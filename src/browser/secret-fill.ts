import type { Browser, ElementHandle, Page } from "playwright";
import {
  createSecretRedactor,
  loadSecretRefBindings,
  readSecretVariable,
  SECRET_REF_NAME,
  totpCode,
  type SecretRefBinding,
  type SecretRefPaths,
} from "./secret-refs.js";

/**
 * Host side of `fillSecret(selector, ref)` and `fillTotp(selector, ref)`.
 *
 * The script tags the element with a nonce attribute and prints one request
 * line carrying the run's private marker. The host checks the ref, finds the
 * tagged element on a top-level page through its own CDP connection, checks
 * that page's origin, types the value, and answers through the helper's temp
 * folder. Answers carry only success or a refusal that names the ref.
 */

export const SECRET_FILL_ATTRIBUTE = "data-bb-secret-fill";
const REQUEST_FIELD = "__bbSecretFill";
const NONCE = /^[a-z0-9-]{1,64}$/u;
const FILL_TIMEOUT_MS = 10_000;

export type SecretFillKind = "secret" | "totp";

type SecretFillRequest = { kind: SecretFillKind; id: string; ref: string };

export function secretFillAnswerFileName(id: string) {
  return `bb-secret-fill-${id}.json`;
}

function parseRequestLine(
  line: string,
  marker: string,
): SecretFillRequest | null {
  if (!line.includes(marker)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate[REQUEST_FIELD] !== marker) return null;
  const { kind, id, ref } = candidate;
  if (
    (kind !== "secret" && kind !== "totp") ||
    typeof id !== "string" ||
    !NONCE.test(id) ||
    typeof ref !== "string"
  ) {
    return null;
  }
  return { kind, id, ref };
}

class SecretFillRefusedError extends Error {}

function refuse(message: string): never {
  throw new SecretFillRefusedError(message);
}

function checkKind(binding: SecretRefBinding, kind: SecretFillKind) {
  if (kind === "secret" && binding.kind === "totp") {
    refuse(
      `secret ref "${binding.ref}" holds an authenticator seed; use fillTotp.`,
    );
  }
  if (kind === "totp" && binding.kind !== "totp") {
    refuse(
      `secret ref "${binding.ref}" is not an authenticator seed; use fillSecret.`,
    );
  }
}

async function taggedElement(browser: Browser, id: string) {
  const selector = `[${SECRET_FILL_ATTRIBUTE}="${id}"]`;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const element = await page
        .mainFrame()
        .$(selector)
        .catch(() => null);
      if (element !== null) return { page, element };
    }
  }
  return null;
}

function pageOrigin(page: Page) {
  try {
    return new URL(page.url()).origin;
  } catch {
    return "an unknown origin";
  }
}

export function createSecretFillSession(options: {
  marker: string;
  paths: SecretRefPaths;
  connect: () => Promise<Browser>;
  answer: (fileName: string, contents: string) => Promise<void>;
  now?: () => number;
}) {
  const redactor = createSecretRedactor();
  const now = options.now ?? Date.now;
  let connection: Promise<Browser> | undefined;
  const pending = new Set<Promise<void>>();

  async function resolveValue(binding: SecretRefBinding) {
    const stored = await readSecretVariable(
      binding,
      options.paths.secretsDirectory,
    );
    if (stored === undefined) {
      refuse(`the value for secret ref "${binding.ref}" is missing.`);
    }
    redactor.add(stored);
    if (binding.kind === "value") return stored;
    let code: string;
    try {
      code = totpCode(stored, binding.totp, now());
    } catch {
      refuse(
        `the authenticator seed for secret ref "${binding.ref}" is invalid.`,
      );
    }
    redactor.add(code);
    return code;
  }

  async function typeInto(
    element: ElementHandle,
    binding: SecretRefBinding,
    value: string,
  ) {
    try {
      await element.fill(value, { timeout: FILL_TIMEOUT_MS });
    } catch {
      // Playwright errors can echo the call; report only the ref.
      refuse(
        `the element for secret ref "${binding.ref}" changed before the fill finished.`,
      );
    }
  }

  async function fill(request: SecretFillRequest) {
    const helper = request.kind === "totp" ? "fillTotp" : "fillSecret";
    if (!SECRET_REF_NAME.test(request.ref))
      refuse("the secret ref name is invalid.");
    const bindings = await loadSecretRefBindings(options.paths);
    const binding = bindings.get(request.ref);
    if (binding === undefined) {
      refuse(`secret ref "${request.ref}" is not defined.`);
    }
    checkKind(binding, request.kind);
    connection ??= options.connect();
    const target = await taggedElement(await connection, request.id);
    if (target === null) {
      refuse(
        `the element for secret ref "${binding.ref}" is not on a top-level page; ${helper} works in the main frame only.`,
      );
    }
    try {
      const origin = pageOrigin(target.page);
      if (!binding.origins.includes(origin)) {
        refuse(`secret ref "${binding.ref}" may not be filled on ${origin}.`);
      }
      const isInput = await target.element
        .evaluate((element) => element instanceof HTMLInputElement)
        .catch(() => false);
      if (!isInput) {
        refuse(`the element for secret ref "${binding.ref}" is not an input.`);
      }
      await typeInto(target.element, binding, await resolveValue(binding));
    } finally {
      await target.element
        .evaluate(
          (element, attribute) => element.removeAttribute(attribute),
          SECRET_FILL_ATTRIBUTE,
        )
        .catch(() => undefined);
      await target.element.dispose().catch(() => undefined);
    }
  }

  async function serve(request: SecretFillRequest) {
    let outcome: { ok: true } | { ok: false; error: string };
    try {
      await fill(request);
      outcome = { ok: true };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "the fill failed.";
      outcome = {
        ok: false,
        error: redactor.redact(
          `${request.kind === "totp" ? "fillTotp" : "fillSecret"} refused: ${reason}`,
        ),
      };
    }
    await options.answer(
      secretFillAnswerFileName(request.id),
      JSON.stringify(outcome),
    );
  }

  return {
    /** Serve a request line. Returns true when the line was a request. */
    handleLine(line: string) {
      const request = parseRequestLine(line, options.marker);
      if (request === null) return false;
      const served = serve(request).catch(() => undefined);
      pending.add(served);
      void served.finally(() => pending.delete(served));
      return true;
    },
    /** Drop request lines and every value resolved during the run. */
    finishOutput(output: string) {
      return redactor.redact(
        output
          .split("\n")
          .filter((line) => parseRequestLine(line, options.marker) === null)
          .join("\n"),
      );
    },
    redactError(error: unknown): unknown {
      redactErrorInPlace(error, redactor.redact, new Set());
      return error;
    },
    async dispose() {
      await Promise.allSettled([...pending]);
      if (connection === undefined) return;
      await connection
        .then((browser) => browser.close())
        .catch(() => undefined);
    },
  };
}

export type SecretFillSession = ReturnType<typeof createSecretFillSession>;

function redactErrorInPlace(
  error: unknown,
  redact: (text: string) => string,
  seen: Set<unknown>,
) {
  if (!(error instanceof Error) || seen.has(error)) return;
  seen.add(error);
  error.message = redact(error.message);
  if (error.stack !== undefined) error.stack = redact(error.stack);
  redactErrorInPlace(error.cause, redact, seen);
  if (error instanceof AggregateError) {
    for (const inner of error.errors) redactErrorInPlace(inner, redact, seen);
  }
}
