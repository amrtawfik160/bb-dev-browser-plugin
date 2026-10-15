import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareAgentExecution } from "../src/browser/agent-script.js";
import { createSecretFillSession } from "../src/browser/secret-fill.js";

// Fixture values only. No real secret file is ever read by this suite.
const PASSWORD = "fixture-password-7f3a9c";
// RFC 6238 appendix B seed; at 59 s its 6-digit SHA-1 code is 287082.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SEED_CODE = "287082";

const PAGES: Record<string, string> = {
  "https://allowed.test/login":
    '<!doctype html><input id="user"><input id="password" type="password"><input id="otp"><div id="box"></div>',
  "https://allowed.test/redirect":
    '<!doctype html><script>location.replace("https://other.test/login")</script>',
  "https://other.test/login":
    '<!doctype html><input id="password" type="password">',
};

let secretsDirectory: string;
let chrome: ChildProcess;
let endpoint: string;
let sandboxBrowser: Browser;
let page: Page;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("No free port.");
  }
  return address.port;
}

async function connectWithRetry(target: string) {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(target);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error("Chromium did not expose CDP.");
}

beforeAll(async () => {
  secretsDirectory = await mkdtemp(join(tmpdir(), "secret-fill-"));
  await writeFile(
    join(secretsDirectory, "app.env"),
    `APP_PASSWORD=${PASSWORD}\nAPP_TOTP_SECRET=${SEED}\n`,
  );
  const bindingPath = join(secretsDirectory, "browser-secret-refs.json");
  await writeFile(
    bindingPath,
    JSON.stringify({
      refs: {
        "app-password": {
          file: "app.env",
          var: "APP_PASSWORD",
          origins: ["https://allowed.test"],
        },
        "app-totp": {
          file: "app.env",
          var: "APP_TOTP_SECRET",
          origins: ["https://allowed.test"],
          totp: true,
        },
        "app-missing": {
          file: "app.env",
          var: "APP_NOT_SET",
          origins: ["https://allowed.test"],
        },
      },
    }),
  );
  await chmod(bindingPath, 0o600);

  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}`;
  chrome = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      // Test-only: root cannot start Chromium's sandbox in this runner.
      "--no-sandbox",
      `--user-data-dir=${join(secretsDirectory, "profile")}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  sandboxBrowser = await connectWithRetry(endpoint);
  const context = sandboxBrowser.contexts()[0]!;
  await context.route("**/*", async (route) => {
    const body = PAGES[route.request().url()];
    if (body === undefined) return route.abort();
    return route.fulfill({ contentType: "text/html", body });
  });
  page = await context.newPage();
}, 30_000);

afterAll(async () => {
  await sandboxBrowser?.close();
  chrome?.kill("SIGKILL");
  await rm(secretsDirectory, { recursive: true, force: true });
});

/**
 * Run an agent script the way dev-browser does: stdout lines stream to the
 * host while the script runs, and `readFile` reads the helper's temp folder.
 */
async function runScript(code: string) {
  const marker = randomUUID();
  const answers = new Map<string, string>();
  const session = createSecretFillSession({
    marker,
    paths: {
      bindingPath: join(secretsDirectory, "browser-secret-refs.json"),
      secretsDirectory,
    },
    connect: () => chromium.connectOverCDP(endpoint),
    answer: async (fileName, contents) => {
      answers.set(fileName, contents);
    },
    now: () => 59_000,
  });
  const lines: string[] = [];
  const browserApi = Object.freeze({
    getPage: async () => page,
    newPage: async () => page,
    listPages: async () => [{ id: "main", url: page.url() }],
    closePage: async () => undefined,
  });
  const prepared = prepareAgentExecution({
    code,
    tabId: "main",
    timeoutMs: 15_000,
    secretFillMarker: marker,
  });
  const run = new Function(
    "browser",
    "console",
    "readFile",
    `return (async () => {\n${prepared}\n})();`,
  ) as (
    browser: unknown,
    console: { log: (value: unknown) => void },
    readFile: (name: string) => Promise<string>,
  ) => Promise<void>;
  let error: Error | undefined;
  try {
    await run(
      browserApi,
      {
        log: (value) => {
          const line = String(value);
          lines.push(line);
          session.handleLine(line);
        },
      },
      async (name) => {
        const contents = answers.get(name);
        if (contents === undefined) throw new Error("ENOENT");
        return contents;
      },
    );
  } catch (caught) {
    error = session.redactError(caught) as Error;
  } finally {
    await session.dispose();
  }
  return {
    output: session.finishOutput(lines.join("\n")),
    error,
    answers: [...answers.values()].join("\n"),
  };
}

function expectNoSecret(...texts: Array<string | undefined>) {
  for (const text of texts) {
    expect(text ?? "").not.toContain(PASSWORD);
    expect(text ?? "").not.toContain(SEED);
    expect(text ?? "").not.toContain(SEED_CODE);
  }
}

describe("fillSecret and fillTotp", () => {
  it("fills a stored value on an allowed origin and redacts it from output", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillSecret("#password", "app-password");
console.log("seen " + (await page.inputValue("#password")));
return { value: await page.inputValue("#password") };`);
    expect(result.error).toBeUndefined();
    expect(await page.inputValue("#password")).toBe(PASSWORD);
    expect(result.output).toContain("seen [redacted]");
    expect(result.output).not.toContain("__bbSecretFill");
    expectNoSecret(result.output, result.answers);
  }, 30_000);

  it("removes the value from a thrown error", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillSecret("#password", "app-password");
throw new Error("leak " + (await page.inputValue("#password")));`);
    expect(result.error?.message).toContain("leak [redacted]");
    expectNoSecret(result.error?.message, result.error?.stack, result.output);
  }, 30_000);

  it("refuses an unknown ref", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillSecret("#password", "nope");`);
    expect(result.error?.message).toMatch(/secret ref "nope" is not defined/u);
    expect(await page.inputValue("#password")).toBe("");
  }, 30_000);

  it("refuses an origin that is not bound to the ref", async () => {
    const result = await runScript(`
await page.goto("https://other.test/login");
await fillSecret("#password", "app-password");`);
    expect(result.error?.message).toMatch(
      /secret ref "app-password" may not be filled on https:\/\/other\.test/u,
    );
    expect(await page.inputValue("#password")).toBe("");
    expectNoSecret(result.error?.message);
  }, 30_000);

  it("refuses after a redirect to another origin between navigation and fill", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/redirect");
await page.waitForURL("https://other.test/login");
await fillSecret("#password", "app-password");`);
    expect(result.error?.message).toMatch(/may not be filled on https:\/\/other\.test/u);
    expect(await page.inputValue("#password")).toBe("");
    expectNoSecret(result.error?.message);
  }, 30_000);

  it("refuses a missing variable and names only the ref", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillSecret("#password", "app-missing");`);
    expect(result.error?.message).toMatch(/value for secret ref "app-missing" is missing/u);
    expect(result.error?.message).not.toContain("APP_NOT_SET");
  }, 30_000);

  it("refuses an element that is not an input", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillSecret("#box", "app-password");`);
    expect(result.error?.message).toMatch(/element for secret ref "app-password" is not an input/u);
    expectNoSecret(result.error?.message);
  }, 30_000);

  it("types the current authenticator code, never the seed", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillTotp("#otp", "app-totp");
return await page.inputValue("#otp");`);
    expect(result.error).toBeUndefined();
    expect(await page.inputValue("#otp")).toBe(SEED_CODE);
    expect(result.output).toBe("[redacted]");
    expectNoSecret(result.output, result.answers);
  }, 30_000);

  it("refuses to fill an authenticator seed as a plain value", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillSecret("#otp", "app-totp");`);
    expect(result.error?.message).toMatch(/secret ref "app-totp" holds an authenticator seed/u);
    expect(await page.inputValue("#otp")).toBe("");
    expectNoSecret(result.error?.message);
  }, 30_000);

  it("refuses an authenticator code from a plain value ref", async () => {
    const result = await runScript(`
await page.goto("https://allowed.test/login");
await fillTotp("#otp", "app-password");`);
    expect(result.error?.message).toMatch(/secret ref "app-password" is not an authenticator seed/u);
    expect(await page.inputValue("#otp")).toBe("");
  }, 30_000);
});

describe("secret fill fixture hygiene", () => {
  it("reads only the temp fixture binding file", async () => {
    const raw = await readFile(
      join(secretsDirectory, "browser-secret-refs.json"),
      "utf8",
    );
    expect(raw).not.toContain("/root/.bb-server/secrets");
  });
});
