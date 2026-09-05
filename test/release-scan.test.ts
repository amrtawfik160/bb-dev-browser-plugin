/**
 * Issue #23 acceptance criterion 3: no development-only raw browser endpoint,
 * debug credential, fixture secret, unsafe browser flag, or unintended
 * telemetry is present in the production build (built dist/ + packaged
 * sources). The scan fails on any hit outside a documented allow-list.
 *
 * The scan surface is:
 *   - shipped plugin source code: TypeScript modules under src/ (excluding test/), and
 *   - the built bundles: dist/ .js and .css, and
 *   - shipped documentation: docs/browser/ .md and the bundled skill.
 *
 * Allow-listed exceptions are documented inline with a concrete reason; each is
 * a security guard or the documented private-network/localhost grant origin
 * list, never an actual unsafe behavior. This test does not provision or
 * mutate the host.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { productionSources } from "./production-sources.js";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

interface Hit {
  file: string;
  line: string;
  lineNumber: number;
  match: string;
}

function listDistFiles(): string[] {
  if (!existsSync(DIST)) return [];
  return readdirSync(DIST)
    .filter((name) => /\.(?:js|css)$/u.test(name))
    .map((name) => join(DIST, name));
}

function listDocFiles(): string[] {
  const docs: string[] = [];
  const browserDocs = join(ROOT, "docs", "browser");
  if (existsSync(browserDocs)) {
    for (const name of readdirSync(browserDocs)) {
      if (name.endsWith(".md")) docs.push(join(browserDocs, name));
    }
  }
  docs.push(join(ROOT, "skills", "browser", "SKILL.md"));
  return docs;
}

function scan(files: string[], pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const found = line.match(pattern);
      if (found !== null) {
        hits.push({
          file: relative(ROOT, file).replace(/\\/gu, "/"),
          line: line.trim(),
          lineNumber: index + 1,
          match: found[0],
        });
      }
    });
  }
  return hits;
}

/**
 * Scan only the plugin's OWN code in the built dist/*.js bundles for a pattern.
 *
 * The bundler marks each bundled module with a `// <source-path>` comment;
 * TypeScript modules under src/ are the plugin's own code, while `node_modules/...`
 * segments are bundled third-party code (ws, zod). This walks those segments
 * and applies the pattern only to the plugin-owned ones, so the credential and
 * telemetry scans prove "no debug credential/telemetry in the production
 * build" against the plugin's own built code without third-party noise.
 */
function scanPluginOwnedDist(pattern: RegExp): Hit[] {
  const pluginSources = new Set(
    productionSources().map((path) =>
      relative(ROOT, path).replace(/\\/gu, "/"),
    ),
  );
  const moduleMarker = /^\/\/\s+([a-zA-Z0-9_./-]+\.(?:ts|tsx|js))$/u;
  const hits: Hit[] = [];
  for (const file of listDistFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    let owned = false;
    lines.forEach((line, index) => {
      const marker = line.match(moduleMarker);
      if (marker !== null) {
        // Entering a new bundled module segment; own it only if the marker
        // names one of the plugin's source files (not node_modules/).
        owned = pluginSources.has(marker[1]!);
        return;
      }
      if (!owned) return;
      const found = line.match(pattern);
      if (found !== null) {
        hits.push({
          file: relative(ROOT, file).replace(/\\/gu, "/"),
          line: line.trim(),
          lineNumber: index + 1,
          match: found[0],
        });
      }
    });
  }
  return hits;
}

function ensureBuilt() {
  if (existsSync(join(DIST, "server.js"))) return;
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
}

describe("release scan (issue #23 AC3)", () => {
  const code = productionSources();
  const docs = listDocFiles();

  it("builds dist/ so the scan covers the production bundles", async () => {
    ensureBuilt();
    expect(code).toEqual(
      expect.arrayContaining([
        join(ROOT, "src/server/server.ts"),
        join(ROOT, "src/host/host.ts"),
        join(ROOT, "src/app/app.tsx"),
      ]),
    );
    expect(
      existsSync(join(DIST, "server.js")),
      "dist/server.js was built",
    ).toBe(true);
  });

  it("forbids unsafe Chrome flags except the documented rejection guard", () => {
    ensureBuilt();
    const surfaces = [...productionSources(), ...listDistFiles()];
    const unsafeFlagPattern =
      /--no-sandbox|--disable-web-security|--disable-site-isolation-trials|--ignore-certificate-errors(?:-spki-list)?/gu;
    const hits = scan(surfaces, unsafeFlagPattern);

    // The ONLY permitted occurrence of --no-sandbox is the guard in the
    // browser runtime (browser-runtime.ts source, bundled into dist/host.js)
    // that throws `unsafe-launch` when the flag is present. Every other unsafe
    // flag must be absent entirely.
    const violations = hits.filter((hit) => {
      if (hit.match !== "--no-sandbox") return true;
      const isGuard =
        (hit.file === "src/browser/browser-runtime.ts" ||
          hit.file === "dist/host.js") &&
        hit.line.includes("no-sandbox") &&
        (hit.line.includes("includes") || hit.line.includes("forbidden"));
      return !isGuard;
    });
    expect(
      violations,
      `unsafe Chrome flags outside the rejection guard: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("binds every listening socket to loopback", () => {
    // All .listen( calls in shipped source must use a loopback host or the
    // panel-gateway loopback bind constant.
    const listenPattern = /\.listen\(/gu;
    const hits = scan(code, listenPattern);
    for (const hit of hits) {
      // A loopback bind is either the literal "127.0.0.1" or the
      // PANEL_GATEWAY_BIND_HOST constant (defined as "127.0.0.1").
      const loopback =
        hit.line.includes("127.0.0.1") ||
        hit.line.includes("PANEL_GATEWAY_BIND_HOST") ||
        hit.line.includes("bindHost");
      expect(loopback, `${hit.file}:${hit.lineNumber} binds to loopback`).toBe(
        true,
      );
    }
  });

  it("treats 0.0.0.0/[::] only as the documented private-network grant list", () => {
    // The private-network/localhost grant origin list (RAW_LOCALHOST_HOSTS in
    // authorization.ts) legitimately contains 0.0.0.0 and [::]. They must
    // never appear as a bind host for a listening socket, and never outside
    // the RAW_LOCALHOST_HOSTS grant-list literal in authorization.ts.
    const pattern = /0\.0\.0\.0|\[::\]/u;
    const otherCode = scan(code, pattern).filter(
      (hit) => hit.file !== "src/access/authorization.ts",
    );
    // No 0.0.0.0/[::] in any shipped source other than authorization.ts.
    expect(otherCode, `unexpected 0.0.0.0/[::] in shipped source`).toEqual([]);

    // Every 0.0.0.0/[::] hit in authorization.ts must be a member line of
    // the RAW_LOCALHOST_HOSTS grant-list literal (a quoted array member
    // inside its `new Set([...])` body), not any other occurrence in the
    // file. A future non-loopback use added anywhere else in the file would
    // fail this assertion.
    const authPath = join(ROOT, "src/access/authorization.ts");
    const authLines = readFileSync(authPath, "utf8").split("\n");
    const setStart = authLines.findIndex((line) =>
      /RAW_LOCALHOST_HOSTS\s*=\s*new\s+Set\(\[/u.test(line),
    );
    expect(
      setStart,
      "RAW_LOCALHOST_HOSTS grant-list literal exists",
    ).toBeGreaterThanOrEqual(0);
    // Find the close of the Set literal body (first `];` at/after setStart).
    let setEnd = setStart + 1;
    while (
      setEnd < authLines.length &&
      !/^\s*\];?\s*$/u.test(authLines[setEnd] ?? "")
    ) {
      setEnd += 1;
    }
    const grantListHits = scan(code, pattern).filter(
      (hit) => hit.file === "src/access/authorization.ts",
    );
    expect(
      grantListHits.length,
      "grant-list literal ships the hosts",
    ).toBeGreaterThan(0);
    const grantMemberPattern = /^\s*"(?:0\.0\.0\.0|\[::\])"\s*,?\s*$/u;
    for (const hit of grantListHits) {
      expect(
        hit.lineNumber > setStart && hit.lineNumber <= setEnd,
        `${hit.file}:${hit.lineNumber} is inside RAW_LOCALHOST_HOSTS`,
      ).toBe(true);
      expect(
        grantMemberPattern.test(hit.line),
        `${hit.file}:${hit.lineNumber} is a RAW_LOCALHOST_HOSTS member line`,
      ).toBe(true);
    }

    // In the bundles, 0.0.0.0/[::] must never be the bind host of a
    // .listen( call (it is only the bundled RAW_LOCALHOST_HOSTS array).
    const bindPattern = /\.listen\([^)]*?["']?(?:0\.0\.0\.0|\[::\])/u;
    const bindHits = scan(listDistFiles(), bindPattern);
    expect(
      bindHits,
      `non-loopback bind host in built bundles: ${JSON.stringify(bindHits)}`,
    ).toEqual([]);
    // Sanity: the grant-list literal still ships in the bundle.
    expect(scan(listDistFiles(), pattern).length).toBeGreaterThan(0);
  });

  it("contains no telemetry SDK, endpoint, or beacon in shipped code or the built bundles", () => {
    const telemetryPattern =
      /\bsentry\b|\bamplitude\b|segment\.io|mixpanel|datadog|google-analytics|googletagmanager|posthog|doubleclick|facebook\.(?:com|net)\/tr|\/v1\/events\b|crashreport|newrelic|hotjar|heap\.io|datadoghq|applicationinsights|opentelemetry|otlp\b|crashlytics|firefox\.pocket/giu;
    // Scan shipped plugin source AND the plugin's own built code in dist/
    // (the production build), so "no telemetry in the production build" is
    // proven against the built artifact, not just unbuilt source. Bundled
    // third-party code (ws, zod) is excluded by scanPluginOwnedDist.
    const hits = [
      ...scan(code, telemetryPattern),
      ...scanPluginOwnedDist(telemetryPattern),
    ];
    expect(
      hits,
      `telemetry SDK/endpoint in shipped code or built bundles: ${JSON.stringify(hits)}`,
    ).toEqual([]);
  });

  it("contains no debug credential or fixture secret in the production build", () => {
    const surfaces = [...code, ...listDistFiles(), ...docs];
    // Fixture-secret markers that exist only in test/ fixtures; they must not
    // leak into shipped code, the built bundles, or the shipped docs.
    const fixtureSecretPattern =
      /fixture-session|fixture-user|deterministic-transfer-fixture|should-not-stage|fixture-session=valid|deterministicLoginFixture/gu;
    const fixtureHits = scan(surfaces, fixtureSecretPattern);
    expect(
      fixtureHits,
      `fixture secret leaked into the production build: ${JSON.stringify(fixtureHits)}`,
    ).toEqual([]);

    // Hardcoded credential literals: an assignment of a quoted secret value.
    // Values containing "/" are filesystem paths (e.g. the /etc/passwd
    // dedicated-user probe in readiness.ts), not secrets, so they are
    // excluded. CLI/Chrome flag strings are not assignments and do not match.
    const credentialPattern =
      /(?:password|api[_-]?key|secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'/]{6,}["']/iu;
    // Scan shipped plugin source AND the plugin's own built code in dist/
    // (the production build), so "no debug credential in the production
    // build" is proven against the built artifact. scanPluginOwnedDist
    // excludes bundled third-party code (ws, zod) that may carry incidental
    // matches, so only the plugin's own code is asserted.
    const pluginCredentialHits = [
      ...scan(code, credentialPattern),
      ...scanPluginOwnedDist(credentialPattern),
    ];
    expect(
      pluginCredentialHits,
      `hardcoded credential in plugin source or built bundles: ${JSON.stringify(pluginCredentialHits)}`,
    ).toEqual([]);
  });
});
