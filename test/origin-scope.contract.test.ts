import { compileFunction } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  matcherPermitsOrigin,
  originScopeMatcher,
  scopeMatchesOrigin,
  type OriginScopeMatcher,
} from "../authorization.js";
import {
  boundPageGuardScript,
  enforcementPostambleScript,
  enforcementPreambleScript,
  extractOriginDenial,
  originPermittedFunctionSource,
  originRequiresCertificateBypass,
  originRequiresCertificateBypassSource,
} from "../origin-scope.js";

/**
 * Origin Scope enforcement during real browser navigation shares one
 * normalized policy with the server grant store. These contracts prove the
 * QuickJS sandbox matcher mirrors the TypeScript matcher, the matcher parses
 * every Origin Scope shape, the enforcement preamble is injected before agent
 * code, and denial markers surface a typed denial back to the host.
 */

function quickJsOriginPermitted() {
  const source = originPermittedFunctionSource();
  const factory = compileFunction(
    `${source}\nreturn __bbOriginPermitted;`,
    [],
    { filename: "origin-permitted.js" },
  );
  return factory() as (origin: string, matcher: OriginScopeMatcher) => boolean;
}

const matrix: { scope: string; origin: string; permitted: boolean }[] = [
  // Exact scheme, host, and port matching.
  {
    scope: "https://app.example.test",
    origin: "https://app.example.test",
    permitted: true,
  },
  {
    scope: "https://app.example.test",
    origin: "https://app.example.test/account",
    permitted: true,
  },
  {
    scope: "https://app.example.test",
    origin: "https://app.example.test:443",
    permitted: true,
  },
  {
    scope: "https://app.example.test",
    origin: "http://app.example.test",
    permitted: false,
  },
  {
    scope: "https://app.example.test",
    origin: "https://other.example.test",
    permitted: false,
  },
  {
    scope: "http://127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    permitted: true,
  },
  {
    scope: "http://127.0.0.1:3000",
    origin: "http://127.0.0.1:3001",
    permitted: false,
  },
  { scope: "http://[::1]:3000", origin: "http://[::1]:3000", permitted: true },
  // Explicit subdomain patterns.
  {
    scope: "https://*.example.test",
    origin: "https://sub.example.test",
    permitted: true,
  },
  {
    scope: "https://*.example.test",
    origin: "https://a.b.example.test",
    permitted: true,
  },
  {
    scope: "https://*.example.test",
    origin: "https://example.test",
    permitted: false,
  },
  {
    scope: "https://*.example.test:8443",
    origin: "https://sub.example.test:8443",
    permitted: true,
  },
  {
    scope: "https://*.example.test:8443",
    origin: "https://sub.example.test",
    permitted: false,
  },
  {
    scope: "https://*.example.test",
    origin: "http://sub.example.test",
    permitted: false,
  },
  // Project Loopback Aliases are exact loopback origins.
  {
    scope: "http://p-0e3ffbf31db2.localhost:4173",
    origin: "http://p-0e3ffbf31db2.localhost:4173",
    permitted: true,
  },
  {
    scope: "http://p-0e3ffbf31db2.localhost:4173",
    origin: "http://p-other.localhost:4173",
    permitted: false,
  },
  // Raw localhost fallback is an exact origin distinct from aliases and whole-web.
  {
    scope: "http://localhost:4173",
    origin: "http://localhost:4173",
    permitted: true,
  },
  {
    scope: "http://localhost:4173",
    origin: "http://127.0.0.1:4173",
    permitted: false,
  },
  // Whole-web access excludes raw localhost.
  { scope: "*", origin: "https://anywhere.test", permitted: true },
  { scope: "*", origin: "http://10.20.30.40:9000", permitted: true },
  { scope: "*", origin: "http://localhost:3000", permitted: false },
  { scope: "*", origin: "http://localhost.:3000", permitted: false },
  { scope: "*", origin: "http://127.42.0.7:3000", permitted: false },
  { scope: "*", origin: "http://[::1]:3000", permitted: false },
  { scope: "*", origin: "http://[0:0:0:0:0:0:0:1]:3000", permitted: false },
  { scope: "*", origin: "http://[::ffff:127.0.0.1]:3000", permitted: false },
  { scope: "*", origin: "http://0.0.0.0:3000", permitted: false },
  { scope: "*", origin: "http://[::]:3000", permitted: false },
  // Mixed schemes and DNS-style hostname tricks stay outside an exact grant.
  {
    scope: "https://app.example.test",
    origin: "https://app.evil.test",
    permitted: false,
  },
  {
    scope: "https://app.example.test",
    origin: "https://app.example.test.evil.test",
    permitted: false,
  },
];

describe("Origin Scope normalized matcher", () => {
  it("parses every Origin Scope shape into a matcher", () => {
    expect(originScopeMatcher("*")).toMatchObject({ kind: "whole-web" });
    expect(originScopeMatcher("https://app.example.test")).toEqual({
      kind: "exact",
      origin: "https://app.example.test",
    });
    expect(originScopeMatcher("https://*.example.test")).toEqual({
      kind: "subdomain",
      protocol: "https",
      baseHost: "example.test",
      port: "",
    });
    expect(originScopeMatcher("https://*.example.test:8443")).toEqual({
      kind: "subdomain",
      protocol: "https",
      baseHost: "example.test",
      port: "8443",
    });
  });

  it.each(matrix)(
    "permits $origin under $scope consistently ($permitted)",
    ({ scope, origin, permitted }) => {
      const normalizedOrigin = new URL(origin).origin;
      expect(scopeMatchesOrigin(scope, normalizedOrigin)).toBe(permitted);
      expect(
        matcherPermitsOrigin(originScopeMatcher(scope), normalizedOrigin),
      ).toBe(permitted);
    },
  );

  it("treats an unparseable destination origin as out of scope instead of throwing", () => {
    expect(matcherPermitsOrigin(originScopeMatcher("*"), "not-a-url")).toBe(
      false,
    );
    expect(
      matcherPermitsOrigin(
        originScopeMatcher("https://app.example.test"),
        "://bad",
      ),
    ).toBe(false);
  });
});

describe("QuickJS sandbox origin-permitted parity", () => {
  const quickJs = quickJsOriginPermitted();

  it.each(matrix)(
    "mirrors the TypeScript matcher for $origin under $scope",
    ({ scope, origin, permitted }) => {
      const normalizedOrigin = new URL(origin).origin;
      const matcher = originScopeMatcher(scope);
      expect(quickJs(normalizedOrigin, matcher)).toBe(
        matcherPermitsOrigin(matcher, normalizedOrigin),
      );
      expect(quickJs(normalizedOrigin, matcher)).toBe(permitted);
    },
  );

  it("rejects raw localhost hostnames under whole-web exactly like the host policy", () => {
    const matcher = originScopeMatcher("*");
    for (const origin of [
      "http://localhost:3000",
      "http://localhost.:3000",
      "http://127.42.0.7:3000",
      "http://[0:0:0:0:0:0:0:1]:3000",
      "http://[::ffff:127.0.0.1]:3000",
      "http://0.0.0.0:3000",
      "http://[::]:3000",
    ]) {
      const normalized = new URL(origin).origin;
      expect(quickJs(normalized, matcher)).toBe(false);
    }
  });
});

describe("enforcement preamble and denial signaling", () => {
  const matcher: OriginScopeMatcher = {
    kind: "exact",
    origin: "https://app.example.test",
  };

  it("snapshots the tabs and installs the guard before the agent code runs", () => {
    const preamble = enforcementPreambleScript(matcher, "bb-denial-marker");
    const agentCode = "console.log('agent ran');";
    expect(preamble).toContain("__bbGuardNavigation");
    expect(preamble).toContain("__bbTabsBefore");
    expect(preamble).toContain('"kind":"exact"');
    const wrapped = `${preamble}\n${boundPageGuardScript()}\n${agentCode}`;
    expect(wrapped.indexOf("__bbTabsBefore")).toBeLessThan(
      wrapped.indexOf("page.goto ="),
    );
    expect(wrapped.indexOf("page.goto =")).toBeLessThan(
      wrapped.indexOf("agent ran"),
    );
  });

  it("does not try to wrap the frozen browser global", () => {
    const preamble = enforcementPreambleScript(matcher, "bb-denial-marker");
    // `browser` is frozen, so assigning to it is a silent no-op. Enforcement
    // that depended on such a patch would look present and do nothing.
    expect(preamble).not.toContain("browser.getPage =");
  });

  it("never intercepts requests, which the sandbox cannot service", () => {
    const preamble = enforcementPreambleScript(matcher, "bb-denial-marker");
    // A route handler is agent-supplied JavaScript the sandbox cannot call
    // back into, so every intercepted request hung forever.
    expect(preamble).not.toContain(".route(");
    expect(preamble).not.toContain("route.continue");
  });

  it("extracts the denied origin from a script result carrying the marker", () => {
    const marker = "bb-denial-marker";
    const output = [
      "agent started",
      JSON.stringify({ __bbOriginDenied: marker, origin: "https://evil.test" }),
      "trailing output",
    ].join("\n");
    expect(extractOriginDenial(output, marker)).toEqual({
      origin: "https://evil.test",
    });
  });

  it("extracts the denied origin from a structured screenshot result output", () => {
    const marker = "bb-denial-marker";
    const result = {
      output: [
        JSON.stringify({
          __bbOriginDenied: marker,
          origin: "http://evil.test:4173",
        }),
        "leftover",
      ].join("\n"),
      screenshots: [],
    };
    expect(extractOriginDenial(result, marker)).toEqual({
      origin: "http://evil.test:4173",
    });
  });

  it("ignores a marker line that does not match the unique denial marker", () => {
    const output = JSON.stringify({
      __bbOriginDenied: "some-other-marker",
      origin: "https://evil.test",
    });
    expect(extractOriginDenial(output, "bb-denial-marker")).toBeNull();
  });

  it("leaves an output without a denial marker unchanged", () => {
    const output = "console output\nwith no marker";
    expect(extractOriginDenial(output, "bb-denial-marker")).toBeNull();
  });
});

describe("per-origin invalid-certificate bypass policy", () => {
  const grantedCertOrigin = "https://app.example.test:8443";
  const invalidCertificateOrigins = [grantedCertOrigin];

  it("reports a granted invalid-certificate origin as requiring cert bypass", () => {
    expect(
      originRequiresCertificateBypass(
        grantedCertOrigin,
        invalidCertificateOrigins,
      ),
    ).toBe(true);
  });

  it("does not bypass an in-scope origin that lacks the invalid-certificate opt-in", () => {
    expect(
      originRequiresCertificateBypass("https://app.example.test:8443", []),
    ).toBe(false);
  });

  it("treats an unparseable destination origin as not requiring cert bypass", () => {
    expect(
      originRequiresCertificateBypass("not-a-url", invalidCertificateOrigins),
    ).toBe(false);
  });
});

describe("QuickJS sandbox cert-bypass parity", () => {
  const quickJsBypass = (() => {
    // Both sources share the sandbox origin parser, exactly as the generated
    // preamble concatenates them.
    const source = `${originPermittedFunctionSource()}\n${originRequiresCertificateBypassSource()}`;
    const factory = compileFunction(
      `${source}\nreturn __bbOriginRequiresCertificateBypass;`,
      [],
      { filename: "origin-cert-bypass.js" },
    );
    return factory() as (origin: string, origins: readonly string[]) => boolean;
  })();

  it.each([
    ["https://app.example.test:8443", ["https://app.example.test:8443"], true],
    ["https://app.example.test:8443", [], false],
    ["https://other.example.test", ["https://app.example.test:8443"], false],
    ["not-a-url", ["https://app.example.test:8443"], false],
  ] as const)(
    "mirrors the TypeScript cert-bypass matcher for %s",
    (origin, origins, expected) => {
      expect(quickJsBypass(origin, origins)).toBe(
        originRequiresCertificateBypass(origin, origins),
      );
      expect(quickJsBypass(origin, origins)).toBe(expected);
    },
  );
});

type EnforcementRun = {
  attempted: string[];
  denialLines: string[];
  thrown: string | null;
};

/**
 * Drive the real generated preamble, bound-page guard, and postamble against a
 * stand-in `browser` global, so the enforcement the host injects is the
 * enforcement under test rather than a paraphrase of it.
 */
async function runEnforcement(input: {
  matcher: OriginScopeMatcher;
  denialMarker: string;
  invalidCertificateOrigins?: readonly string[];
  /** Navigations the script attempts through the bound page. */
  gotoTargets?: readonly string[];
  /** Tabs open before the call, as `id -> url`. */
  tabsBefore: Readonly<Record<string, string>>;
  /** Tabs open after the call; defaults to the state before. */
  tabsAfter?: Readonly<Record<string, string>>;
}): Promise<EnforcementRun> {
  const run: EnforcementRun = { attempted: [], denialLines: [], thrown: null };
  const page = {
    goto: async (url: string) => {
      run.attempted.push(url);
    },
  };
  let listed = 0;
  const toEntries = (tabs: Readonly<Record<string, string>>) =>
    Object.entries(tabs).map(([id, url]) => ({ id, url }));
  const browserGlobal = {
    listPages: async () => {
      // The preamble snapshots first; the postamble lists again afterwards.
      listed += 1;
      return toEntries(
        listed === 1 ? input.tabsBefore : (input.tabsAfter ?? input.tabsBefore),
      );
    },
    getPage: async () => page,
  };
  const consoleMock = {
    log: (message: string) => {
      run.denialLines.push(message);
    },
  };
  const body = [
    enforcementPreambleScript(
      input.matcher,
      input.denialMarker,
      input.invalidCertificateOrigins ?? [],
    ),
    "const page = await browser.getPage('tab-0');",
    boundPageGuardScript(),
    "try {",
    ...(input.gotoTargets ?? []).map(
      (target) => `  await page.goto(${JSON.stringify(target)});`,
    ),
    "} catch (error) {",
    "  if (error === null || typeof error !== 'object' || error.__bbOriginDenied !== true) throw error;",
    "  __bbThrown = String(error.message);",
    "}",
    enforcementPostambleScript(),
    "return __bbThrown;",
  ].join("\n");
  const factory = compileFunction(
    `return async (browser, console) => {\nlet __bbThrown = null;\n${body}\n};`,
    ["browser", "console"],
    { filename: "enforcement.js" },
  );
  run.thrown = (await factory()(browserGlobal, consoleMock)) as string | null;
  return run;
}

describe("Origin Scope navigation gate", () => {
  const grantedOrigin = "https://app.example.test:8443";
  const matcher: OriginScopeMatcher = { kind: "exact", origin: grantedOrigin };
  const denialMarker = "bb-denial-gate";

  it("lets an in-scope navigation reach the browser", async () => {
    const run = await runEnforcement({
      matcher,
      denialMarker,
      gotoTargets: [`${grantedOrigin}/account`],
      tabsBefore: { "tab-0": `${grantedOrigin}/` },
      tabsAfter: { "tab-0": `${grantedOrigin}/account` },
    });
    expect(run.attempted).toEqual([`${grantedOrigin}/account`]);
    expect(run.denialLines).toEqual([]);
    expect(run.thrown).toBeNull();
  });

  it("refuses an out-of-scope navigation on the bound page before it is issued", async () => {
    const run = await runEnforcement({
      matcher,
      denialMarker,
      gotoTargets: ["https://evil.example.test/account"],
      tabsBefore: { "tab-0": `${grantedOrigin}/` },
    });
    expect(run.attempted).toEqual([]);
    expect(run.thrown).toContain("https://evil.example.test");
    expect(run.denialLines.join("\n")).toContain(denialMarker);
    expect(run.denialLines.join("\n")).toContain("https://evil.example.test");
  });

  it("denies a tab this call navigated out of scope by other means", async () => {
    // A redirect or a link click moves the tab without page.goto, so the
    // guard never sees it and the sweep is what catches it.
    const run = await runEnforcement({
      matcher,
      denialMarker,
      tabsBefore: { "tab-0": `${grantedOrigin}/` },
      tabsAfter: { "tab-0": "https://redirected.example.test/" },
    });
    expect(run.denialLines.join("\n")).toContain(denialMarker);
    expect(run.denialLines.join("\n")).toContain(
      "https://redirected.example.test",
    );
  });

  it("denies a tab this call opened", async () => {
    const run = await runEnforcement({
      matcher,
      denialMarker,
      tabsBefore: { "tab-0": `${grantedOrigin}/` },
      tabsAfter: {
        "tab-0": `${grantedOrigin}/`,
        "tab-1": "https://popup.example.test/",
      },
    });
    expect(run.denialLines.join("\n")).toContain("https://popup.example.test");
  });

  it("leaves a tab this call never moved alone, so a narrow grant stays usable", async () => {
    // The owner keeps unrelated tabs open, including raw localhost that a
    // whole-web grant excludes. Denying over a tab the call never touched
    // would make every narrow grant fail the moment a second tab exists.
    const unchanged = {
      "tab-0": `${grantedOrigin}/`,
      "tab-1": "https://unrelated.example.test/",
    };
    const run = await runEnforcement({
      matcher,
      denialMarker,
      tabsBefore: unchanged,
      tabsAfter: unchanged,
    });
    expect(run.denialLines).toEqual([]);
  });

  it("ignores blank and browser-internal locations", async () => {
    const run = await runEnforcement({
      matcher,
      denialMarker,
      gotoTargets: ["about:blank"],
      tabsBefore: { "tab-0": `${grantedOrigin}/` },
      tabsAfter: { "tab-0": "about:blank", "tab-1": "chrome://new-tab-page" },
    });
    expect(run.attempted).toEqual(["about:blank"]);
    expect(run.denialLines).toEqual([]);
  });

  it("denies an unparseable navigation target", async () => {
    const run = await runEnforcement({
      matcher,
      denialMarker,
      gotoTargets: ["not-a-url"],
      tabsBefore: { "tab-0": `${grantedOrigin}/` },
    });
    expect(run.attempted).toEqual([]);
    expect(run.denialLines.join("\n")).toContain(denialMarker);
  });

  it("permits any public origin under a whole-web grant but still refuses raw localhost", async () => {
    const wholeWeb: OriginScopeMatcher = {
      kind: "whole-web",
      rawLocalhostHosts: ["localhost", "localhost.", "0.0.0.0", "[::]"],
    };
    const allowed = await runEnforcement({
      matcher: wholeWeb,
      denialMarker,
      gotoTargets: ["https://anywhere.test/page"],
      tabsBefore: { "tab-0": "https://start.test/" },
      tabsAfter: { "tab-0": "https://anywhere.test/page" },
    });
    expect(allowed.attempted).toEqual(["https://anywhere.test/page"]);
    expect(allowed.denialLines).toEqual([]);

    const refused = await runEnforcement({
      matcher: wholeWeb,
      denialMarker,
      gotoTargets: ["http://localhost:3000/"],
      tabsBefore: { "tab-0": "https://start.test/" },
    });
    expect(refused.attempted).toEqual([]);
    expect(refused.denialLines.join("\n")).toContain("http://localhost:3000");
  });
});
