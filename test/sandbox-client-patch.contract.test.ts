import { readFileSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_CONTEXT_CLOSE_BROKEN,
  SANDBOX_CONTEXT_CLOSE_FIXED,
  patchSandboxClientBinary,
  patchSandboxClientBytes,
  patchSandboxClientFile,
  patchSandboxClientSource,
} from "../src/browser/sandbox-client-patch.js";

const require = createRequire(import.meta.url);
const packageDirectory = dirname(require.resolve("dev-browser/package.json"));

function closeWithoutBrowserType(source: string) {
  const body = `{
    this._closingStatus = "closed";
    this._browser?._contexts.delete(this);
    ${source}
  }`;
  const close = new Function(body) as (this: {
    _closingStatus: string;
    _browser: {
      _contexts: Set<unknown>;
      _browserType?: { _contexts: Set<unknown> };
    } | null;
  }) => void;
  const browser = { _contexts: new Set<unknown>() };
  const context = { _closingStatus: "none", _browser: browser };
  browser._contexts.add(context);
  close.call(context);
  return context;
}

describe("sandbox client context close", () => {
  it("throws the transport failure when a context closes without a browser type", () => {
    expect(() => closeWithoutBrowserType(SANDBOX_CONTEXT_CLOSE_BROKEN)).toThrow(
      /_contexts/u,
    );
  });

  it("patches the packaged client so that close skips a missing browser type", () => {
    const source = readFileSync(
      join(packageDirectory, "daemon", "dist", "sandbox-client.js"),
      "utf8",
    );
    const binary = readFileSync(
      join(packageDirectory, "bin", "dev-browser-linux-x64"),
    );
    expect(source).toContain(SANDBOX_CONTEXT_CLOSE_BROKEN);
    expect(binary.includes(Buffer.from(SANDBOX_CONTEXT_CLOSE_BROKEN))).toBe(
      true,
    );

    const patched = patchSandboxClientSource(source);
    const patchedBinary = patchSandboxClientBytes(binary);
    expect(patched).toContain(SANDBOX_CONTEXT_CLOSE_FIXED);
    expect(patched).not.toContain(SANDBOX_CONTEXT_CLOSE_BROKEN);
    expect(patchSandboxClientSource(patched)).toBe(patched);
    expect(patchedBinary.length).toBe(binary.length);
    expect(
      patchedBinary.includes(Buffer.from(SANDBOX_CONTEXT_CLOSE_BROKEN)),
    ).toBe(false);
    expect(
      patchedBinary.includes(Buffer.from(SANDBOX_CONTEXT_CLOSE_FIXED)),
    ).toBe(true);

    const context = closeWithoutBrowserType(SANDBOX_CONTEXT_CLOSE_FIXED);
    expect(context._closingStatus).toBe("closed");
    expect(context._browser?._contexts.has(context)).toBe(false);
  });

  it("skips a second read when the patched file is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-patch-"));
    try {
      const path = join(directory, "sandbox-client.js");
      const source = `prefix\n${SANDBOX_CONTEXT_CLOSE_BROKEN}\nsuffix\n`;
      await writeFile(path, source);
      expect(await patchSandboxClientFile(path)).toBe(true);
      expect(await patchSandboxClientFile(path)).toBe(false);
      expect(readFileSync(path, "utf8")).toContain(SANDBOX_CONTEXT_CLOSE_FIXED);
      await writeFile(path, source);
      const later = new Date(Date.now() + 5_000);
      await utimes(path, later, later);
      expect(await patchSandboxClientFile(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(SANDBOX_CONTEXT_CLOSE_FIXED);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips a second read when the patched binary is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-binary-"));
    try {
      const path = join(directory, "dev-browser-linux-x64");
      const bytes = Buffer.concat([
        Buffer.from("prefix"),
        Buffer.from(SANDBOX_CONTEXT_CLOSE_BROKEN),
        Buffer.from("suffix"),
      ]);
      await writeFile(path, bytes);
      expect(await patchSandboxClientBinary(path)).toBe(true);
      expect(await patchSandboxClientBinary(path)).toBe(false);
      expect(
        readFileSync(path).includes(Buffer.from(SANDBOX_CONTEXT_CLOSE_BROKEN)),
      ).toBe(false);
      await writeFile(path, bytes);
      const later = new Date(Date.now() + 5_000);
      await utimes(path, later, later);
      expect(await patchSandboxClientBinary(path)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
