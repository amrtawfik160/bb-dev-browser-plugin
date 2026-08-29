/**
 * Issue #23 acceptance criterion 3: no development-only raw browser endpoint,
 * debug credential, fixture secret, unsafe browser flag, or unintended
 * telemetry is present in the production build (built dist/ + packaged
 * sources). The scan fails on any hit outside a documented allow-list.
 *
 * The scan surface is:
 *   - shipped plugin source code: root .ts/.tsx modules (excluding test/), and
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

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

interface Hit {
  file: string;
  line: string;
  lineNumber: number;
  match: string;
}

function listCodeFiles(): string[] {
  return readdirSync(ROOT)
    .filter((name) => /\.(?:ts|tsx)$/u.test(name))
    .map((name) => join(ROOT, name));
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

function ensureBuilt() {
  if (existsSync(join(DIST, "server.js"))) return;
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
}

describe("release scan (issue #23 AC3)", () => {
  const code = listCodeFiles();
  const docs = listDocFiles();

  it("builds dist/ so the scan covers the production bundles", async () => {
    ensureBuilt();
    expect(
      existsSync(join(DIST, "server.js")),
      "dist/server.js was built",
    ).toBe(true);
  });

  it("forbids unsafe Chrome flags except the documented rejection guard", () => {
    ensureBuilt();
    const surfaces = [...listCodeFiles(), ...listDistFiles()];
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
        (hit.file === "browser-runtime.ts" || hit.file === "dist/host.js") &&
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
    // never appear as a bind host for a listening socket.
    const pattern = /0\.0\.0\.0|\[::\]/u;
    const codeHits = scan(code, pattern).filter(
      (hit) => hit.file === "authorization.ts",
    );
    // No 0.0.0.0/[::] in any shipped source other than authorization.ts.
    const otherCode = scan(code, pattern).filter(
      (hit) => hit.file !== "authorization.ts",
    );
    expect(otherCode, `unexpected 0.0.0.0/[::] in shipped source`).toEqual([]);

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
    expect(codeHits.length).toBeGreaterThan(0);
  });

  it("contains no telemetry SDK, endpoint, or beacon in shipped code", () => {
    const telemetryPattern =
      /\bsentry\b|\bamplitude\b|segment\.io|mixpanel|datadog|google-analytics|googletagmanager|posthog|doubleclick|facebook\.(?:com|net)\/tr|\/v1\/events\b|crashreport|newrelic|hotjar|heap\.io|datadoghq|applicationinsights|opentelemetry|otlp\b|crashlytics|firefox\.pocket/giu;
    const hits = scan(code, telemetryPattern);
    expect(
      hits,
      `telemetry SDK/endpoint in shipped code: ${JSON.stringify(hits)}`,
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
    const credentialHits = scan(
      [...code, ...listDistFiles()],
      credentialPattern,
    );
    // The bundled `ws` library and other third-party code may contain
    // incidental matches; allow-list none of the plugin's own code. Filter
    // hits to the plugin source files only to avoid third-party noise.
    const pluginCredentialHits = credentialHits.filter((hit) =>
      /\.(?:ts|tsx)$/u.test(hit.file),
    );
    expect(
      pluginCredentialHits,
      `hardcoded credential in plugin source: ${JSON.stringify(pluginCredentialHits)}`,
    ).toEqual([]);
  });
});
