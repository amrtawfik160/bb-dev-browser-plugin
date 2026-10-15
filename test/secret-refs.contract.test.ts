import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSecretRedactor,
  loadSecretRefBindings,
  readSecretVariable,
  totpCode,
} from "../src/browser/secret-refs.js";

let secretsDirectory: string;
let bindingPath: string;

beforeEach(async () => {
  secretsDirectory = await mkdtemp(join(tmpdir(), "secret-refs-"));
  bindingPath = join(secretsDirectory, "browser-secret-refs.json");
});

afterEach(async () => {
  await rm(secretsDirectory, { recursive: true, force: true });
});

async function writeBindings(document: unknown, mode = 0o600) {
  await writeFile(bindingPath, JSON.stringify(document));
  await chmod(bindingPath, mode);
}

function load() {
  return loadSecretRefBindings({ bindingPath, secretsDirectory });
}

describe("browser secret ref bindings", () => {
  it("has no refs when the binding file does not exist", async () => {
    expect((await load()).size).toBe(0);
  });

  it("parses value and authenticator seed refs", async () => {
    await writeBindings({
      refs: {
        "app-password": {
          file: "app.env",
          var: "APP_PASSWORD",
          origins: ["https://app.example"],
        },
        "app-totp": {
          file: join(secretsDirectory, "app.env"),
          var: "APP_TOTP_SECRET",
          origins: ["https://app.example"],
          totp: { digits: 8, period: 60, algorithm: "SHA256" },
        },
      },
    });
    const bindings = await load();
    expect(bindings.get("app-password")).toEqual({
      kind: "value",
      ref: "app-password",
      file: join(secretsDirectory, "app.env"),
      variable: "APP_PASSWORD",
      origins: ["https://app.example"],
    });
    expect(bindings.get("app-totp")).toEqual({
      kind: "totp",
      ref: "app-totp",
      file: join(secretsDirectory, "app.env"),
      variable: "APP_TOTP_SECRET",
      origins: ["https://app.example"],
      totp: { digits: 8, periodSeconds: 60, algorithm: "SHA256" },
    });
  });

  it("defaults authenticator settings to RFC 6238 SHA-1, 30 seconds, 6 digits", async () => {
    await writeBindings({
      refs: {
        otp: {
          file: "app.env",
          var: "APP_TOTP_SECRET",
          origins: ["https://app.example"],
          totp: true,
        },
      },
    });
    expect((await load()).get("otp")).toMatchObject({
      kind: "totp",
      totp: { digits: 6, periodSeconds: 30, algorithm: "SHA1" },
    });
  });

  it.each([
    [
      "an env file outside the secrets directory",
      { file: "../outside.env", var: "A", origins: ["https://app.example"] },
    ],
    [
      "an origin that is not exact https",
      { file: "app.env", var: "A", origins: ["http://app.example"] },
    ],
    [
      "an origin with a path",
      { file: "app.env", var: "A", origins: ["https://app.example/login"] },
    ],
    [
      "an authenticator seed bound as a plain value",
      {
        file: "app.env",
        var: "APP_TOTP_SECRET",
        origins: ["https://a.example"],
      },
    ],
  ])("rejects the whole file for %s", async (_label, entry) => {
    await writeBindings({ refs: { bad: entry } });
    await expect(load()).rejects.toThrow(/browser secret ref file is invalid/u);
  });

  it("refuses a binding file that group or others can read", async () => {
    await writeBindings({ refs: {} }, 0o640);
    await expect(load()).rejects.toThrow(/mode 0600/u);
  });

  it("reads one variable and reports a missing one as undefined", async () => {
    await writeFile(
      join(secretsDirectory, "app.env"),
      'export APP_PASSWORD="fixture pass"\nOTHER=1\n',
    );
    const binding = {
      kind: "value" as const,
      ref: "app-password",
      file: join(secretsDirectory, "app.env"),
      variable: "APP_PASSWORD",
      origins: ["https://app.example"],
    };
    await expect(readSecretVariable(binding)).resolves.toBe("fixture pass");
    await expect(
      readSecretVariable({ ...binding, variable: "ABSENT" }),
    ).resolves.toBeUndefined();
    await expect(
      readSecretVariable({
        ...binding,
        file: join(secretsDirectory, "no.env"),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("authenticator codes", () => {
  // RFC 6238 appendix B: the ASCII seed "12345678901234567890" in base32.
  const rfcSeed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it.each([
    [59_000, "94287082"],
    [1_111_111_109_000, "07081804"],
    [2_000_000_000_000, "69279037"],
  ])("matches the RFC 6238 SHA-1 vector at %d ms", (nowMs, code) => {
    expect(
      totpCode(
        rfcSeed,
        { algorithm: "SHA1", digits: 8, periodSeconds: 30 },
        nowMs,
      ),
    ).toBe(code);
  });

  it("truncates to six digits and ignores seed case and spacing", () => {
    expect(
      totpCode(
        "gezd gnbv gy3t qojq gezd gnbv gy3t qojq",
        { algorithm: "SHA1", digits: 6, periodSeconds: 30 },
        59_000,
      ),
    ).toBe("287082");
  });
});

describe("secret redaction", () => {
  it("removes every added value from text", () => {
    const redactor = createSecretRedactor();
    redactor.add("hunter2");
    redactor.add("");
    expect(redactor.redact("a hunter2 b hunter2")).toBe(
      "a [redacted] b [redacted]",
    );
    expect(redactor.redact("nothing here")).toBe("nothing here");
  });
});
