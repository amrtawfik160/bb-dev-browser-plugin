import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Issue #14 AC6: no raw Chrome, CDP, dev-browser, or helper endpoint bypasses
 * the policy layer. An agent running inside the dev-browser QuickJS sandbox
 * only sees a frozen `browser` global. These contracts prove the sandboxed
 * surface cannot spawn a fresh un-intercepted context or page to escape Origin
 * Scope enforcement:
 *
 * 1. The `browser` global is frozen and non-reassignable, so an agent cannot
 *    monkey-patch it to expose a context-spawning method.
 * 2. The global exposes only page-level helpers (`getPage`, `newPage`,
 *    `listPages`, `closePage`); there is no `newContext`/`browser.newContext`,
 *    so the agent cannot create a fresh context that the enforcement route was
 *    never registered on.
 * 3. `newPage` reuses the one connected context (`entry.context.newPage()`),
 *    where the host-owned Origin Scope guard is installed before agent code.
 *    The guard's navigation behavior is covered in
 *    `origin-scope-host.contract.test.ts`.
 *
 * The contracts assert against the pinned `dev-browser` source so a version
 * bump that widens the sandbox surface fails loudly instead of silently
 * reintroducing an escape hatch.
 */

const require = createRequire(import.meta.url);
const devBrowserDirectory = dirname(
  require.resolve("dev-browser/package.json"),
);
const daemonBundlePath = join(
  devBrowserDirectory,
  "daemon",
  "dist",
  "daemon.bundle.mjs",
);

async function readDaemonBundle() {
  return readFile(daemonBundlePath, "utf8");
}

function browserApiBlock(source: string) {
  const start = source.indexOf("const browserApi = Object.create(null);");
  const freeze = source.indexOf("Object.freeze(browserApi);", start);
  if (start === -1 || freeze === -1) {
    throw new Error("The dev-browser sandbox browser global was not found.");
  }
  return source.slice(start, freeze);
}

describe("issue #14 AC6 sandbox cannot escape the policy layer", () => {
  it("freezes the browser global so an agent cannot add a context-spawning method", async () => {
    const source = await readDaemonBundle();
    expect(source).toContain("Object.freeze(browserApi);");
    expect(source).toContain('Object.defineProperty(globalThis, "browser", {');
    expect(source).toContain("configurable: false");
    expect(source).toContain("writable: false");
  });

  it("exposes only page-level helpers and no newContext on the sandboxed browser global", async () => {
    const source = await readDaemonBundle();
    const api = browserApiBlock(source);
    for (const method of ["getPage", "newPage", "listPages", "closePage"]) {
      expect(api).toContain(`${method}:`);
    }
    expect(api).not.toContain("newContext:");
    // The sandbox global reaches the host only through a fixed set of hostCall
    // verbs; none of them spawns a fresh context an agent could reach.
    expect(api).not.toContain('hostCall("newContext"');
    expect(api).not.toContain('hostCall("browser.newContext"');
  });

  it("creates new sandbox pages in the one connected context the enforcement route covers", async () => {
    const source = await readDaemonBundle();
    // The host-side manager handler for the sandbox `newPage` host call.
    expect(source).toMatch(/async #newPage\(\)/);
    expect(source).toContain(
      "this.#options.manager.newPage(this.#options.browserName)",
    );
    // The manager reuses the one connected context rather than spawning another.
    expect(source).toContain("async newPage(browserName)");
    expect(source).toContain("return entry.context.newPage();");
  });
});
