import {
  chmod,
  chown,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

async function writeEnv(name: string, contents: string, mode = 0o600) {
  const path = join(secretsDirectory, name);
  await writeFile(path, contents);
  await chmod(path, mode);
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
      "a plain http origin that is not loopback",
      { file: "app.env", var: "A", origins: ["http://dev.example:5001"] },
    ],
    [
      "a plain http loopback origin with a path",
      { file: "app.env", var: "A", origins: ["http://localhost:5001/"] },
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

  it.each([
    ["the same ref order", "app-totp", "app-seed-as-value"],
    ["the reverse ref order", "app-seed-as-value", "app-totp"],
  ])(
    "rejects the whole file when a plain ref aliases a seed (%s)",
    async (_label, first, second) => {
      const entries = {
        "app-totp": {
          file: "app.env",
          var: "OTP_SEED",
          origins: ["https://app.example"],
          totp: true,
        },
        "app-seed-as-value": {
          // The same variable reached through another spelling of the path.
          file: join(secretsDirectory, "./app.env"),
          var: "OTP_SEED",
          origins: ["https://app.example"],
        },
      };
      await writeBindings({
        refs: { [first]: entries[first], [second]: entries[second] },
      });
      await expect(load()).rejects.toThrow(
        /browser secret ref file is invalid/u,
      );
    },
  );

  it("accepts plain http only for the exact local dev server origin", async () => {
    await writeBindings({
      refs: {
        dev: {
          file: "app.env",
          var: "A",
          origins: ["http://localhost:5001"],
        },
      },
    });
    expect((await load()).get("dev")?.origins).toEqual([
      "http://localhost:5001",
    ]);
  });

  it("refuses a binding file that group or others can read", async () => {
    await writeBindings({ refs: {} }, 0o640);
    await expect(load()).rejects.toThrow(/mode 0600/u);
  });

  it("reads one variable and reports a missing one as undefined", async () => {
    await writeEnv("app.env", 'export APP_PASSWORD="fixture pass"\nOTHER=1\n');
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

describe("bound env file checks", () => {
  let outsideDirectory: string;

  beforeEach(async () => {
    outsideDirectory = await mkdtemp(join(tmpdir(), "secret-refs-outside-"));
  });

  afterEach(async () => {
    await rm(outsideDirectory, { recursive: true, force: true });
  });

  function binding(file: string) {
    return {
      kind: "value" as const,
      ref: "app-password",
      file: join(secretsDirectory, file),
      variable: "PW",
      origins: ["https://app.example"],
    };
  }

  async function writeOutside(name: string) {
    const path = join(outsideDirectory, name);
    await writeFile(path, "PW=outside-fixture\n");
    await chmod(path, 0o600);
    return path;
  }

  const refused = /env file for secret ref "app-password" must be/u;

  it("refuses a bound file that is a symlink leaving the secrets folder", async () => {
    await symlink(
      await writeOutside("app.env"),
      join(secretsDirectory, "app.env"),
    );
    await expect(readSecretVariable(binding("app.env"))).rejects.toThrow(
      refused,
    );
  });

  it("refuses a bound file that is a symlink to a file inside the folder", async () => {
    await writeEnv("real.env", "PW=inside-fixture\n");
    await symlink(
      join(secretsDirectory, "real.env"),
      join(secretsDirectory, "app.env"),
    );
    await expect(readSecretVariable(binding("app.env"))).rejects.toThrow(
      refused,
    );
  });

  it("refuses a bound file whose folder is a symlink leaving the secrets folder", async () => {
    await writeOutside("app.env");
    await symlink(outsideDirectory, join(secretsDirectory, "linked"));
    await expect(readSecretVariable(binding("linked/app.env"))).rejects.toThrow(
      refused,
    );
  });

  it("refuses a bound file with a second hard link", async () => {
    await writeEnv("app.env", "PW=inside-fixture\n");
    await link(
      join(secretsDirectory, "app.env"),
      join(secretsDirectory, "alias.env"),
    );
    await expect(readSecretVariable(binding("app.env"))).rejects.toThrow(
      refused,
    );
  });

  it("refuses a bound file that group or others can read", async () => {
    await writeEnv("app.env", "PW=inside-fixture\n", 0o644);
    await expect(readSecretVariable(binding("app.env"))).rejects.toThrow(
      refused,
    );
  });

  it.runIf(process.getuid?.() === 0)(
    "refuses a bound file owned by another user",
    async () => {
      await writeEnv("app.env", "PW=inside-fixture\n");
      await chown(join(secretsDirectory, "app.env"), 65534, 65534);
      await expect(readSecretVariable(binding("app.env"))).rejects.toThrow(
        refused,
      );
    },
  );

  it("reads a regular file in a real subfolder", async () => {
    await mkdir(join(secretsDirectory, "sub"));
    await writeEnv("sub/app.env", "PW=inside-fixture\n");
    await expect(readSecretVariable(binding("sub/app.env"))).resolves.toBe(
      "inside-fixture",
    );
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
