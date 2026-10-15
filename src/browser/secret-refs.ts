import { createHmac } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

/**
 * Secret Refs: named, owner-written bindings from a ref to one variable in a
 * host env file, plus the exact origins where its value may be typed. Only
 * refs listed in the root-owned binding file exist. The value is read on the
 * host at fill time and never crosses into a script.
 */

export const BROWSER_SECRETS_DIRECTORY = "/root/.bb-server/secrets";
export const BROWSER_SECRET_REFS_PATH = join(
  BROWSER_SECRETS_DIRECTORY,
  "browser-secret-refs.json",
);

export type SecretRefPaths = {
  bindingPath: string;
  secretsDirectory: string;
};

export type TotpSettings = {
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: number;
  periodSeconds: number;
};

type SecretRefSource = {
  ref: string;
  file: string;
  variable: string;
  origins: readonly string[];
};

export type SecretRefBinding =
  | (SecretRefSource & { kind: "value" })
  | (SecretRefSource & { kind: "totp"; totp: TotpSettings });

export const SECRET_REF_NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const SEED_VARIABLE = /TOTP_SECRET/u;

const exactHttpsOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
});

const totpSchema = z.union([
  z.literal(true),
  z
    .object({
      algorithm: z.enum(["SHA1", "SHA256", "SHA512"]).default("SHA1"),
      digits: z.number().int().min(6).max(10).default(6),
      period: z.number().int().min(1).max(600).default(30),
    })
    .strict(),
]);

const bindingFileSchema = z
  .object({
    refs: z.record(
      z.string().regex(SECRET_REF_NAME),
      z
        .object({
          file: z.string().min(1),
          var: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
          origins: z.array(exactHttpsOrigin).min(1),
          totp: totpSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

const INVALID_FILE = "The browser secret ref file is invalid.";

function envFileInside(secretsDirectory: string, file: string) {
  const path = resolve(secretsDirectory, file);
  const inside = relative(resolve(secretsDirectory), path);
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(INVALID_FILE);
  }
  return path;
}

function parseBindings(
  raw: unknown,
  secretsDirectory: string,
): ReadonlyMap<string, SecretRefBinding> {
  const parsed = bindingFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(INVALID_FILE);
  const bindings = new Map<string, SecretRefBinding>();
  for (const [ref, entry] of Object.entries(parsed.data.refs)) {
    const source = {
      ref,
      file: envFileInside(secretsDirectory, entry.file),
      variable: entry.var,
      origins: entry.origins,
    };
    if (entry.totp === undefined) {
      // An authenticator seed must never be typed as itself.
      if (SEED_VARIABLE.test(entry.var)) throw new Error(INVALID_FILE);
      bindings.set(ref, { ...source, kind: "value" });
      continue;
    }
    const settings =
      entry.totp === true
        ? ({ algorithm: "SHA1", digits: 6, period: 30 } as const)
        : entry.totp;
    bindings.set(ref, {
      ...source,
      kind: "totp",
      totp: {
        algorithm: settings.algorithm,
        digits: settings.digits,
        periodSeconds: settings.period,
      },
    });
  }
  return bindings;
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Read the binding file. A missing file means no refs exist. */
export async function loadSecretRefBindings(
  paths: SecretRefPaths,
): Promise<ReadonlyMap<string, SecretRefBinding>> {
  let handle;
  try {
    handle = await open(
      paths.bindingPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissing(error)) return new Map();
    throw new Error(INVALID_FILE, { cause: error });
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new Error(
        "The browser secret ref file must be owned by the host user with mode 0600.",
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new Error(INVALID_FILE);
    }
    return parseBindings(raw, paths.secretsDirectory);
  } finally {
    await handle.close();
  }
}

function unquote(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** One variable from the bound env file, or undefined when either is absent. */
export async function readSecretVariable(
  binding: SecretRefBinding,
): Promise<string | undefined> {
  let source: string;
  try {
    source = await readFile(binding.file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(
      line,
    );
    if (match?.[1] !== binding.variable) continue;
    const value = unquote(match[2] ?? "");
    return value.length === 0 ? undefined : value;
  }
  return undefined;
}

function base32Bytes(seed: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = seed.toUpperCase().replace(/[\s=-]/gu, "");
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("The authenticator seed is not base32.");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 time-based one-time password for a base32 seed. */
export function totpCode(
  seed: string,
  settings: TotpSettings,
  nowMs: number,
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(
    BigInt(Math.floor(nowMs / 1000 / settings.periodSeconds)),
  );
  const digest = createHmac(settings.algorithm.toLowerCase(), base32Bytes(seed))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** settings.digits).padStart(settings.digits, "0");
}

export const REDACTED = "[redacted]";

/** Every value resolved during one run, removed from that run's text. */
export function createSecretRedactor() {
  const values = new Set<string>();
  return {
    add(value: string) {
      if (value.length > 0) values.add(value);
    },
    redact(text: string) {
      let result = text;
      // Longest first, so a value that contains another is removed whole.
      for (const value of [...values].sort((a, b) => b.length - a.length)) {
        result = result.split(value).join(REDACTED);
      }
      return result;
    },
  };
}

export type SecretRedactor = ReturnType<typeof createSecretRedactor>;
