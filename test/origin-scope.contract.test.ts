import { compileFunction } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  matcherPermitsOrigin,
  originScopeMatcher,
  scopeMatchesOrigin,
  type OriginScopeMatcher,
} from "../authorization.js";
import {
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

  it("registers context route interception before the agent code runs", () => {
    const preamble = enforcementPreambleScript(matcher, "bb-denial-marker");
    const agentCode = "console.log('agent ran');";
    expect(preamble).toContain("__bbEnforceOriginScope");
    expect(preamble).toContain("__bbEnforcementPage.context()");
    expect(preamble).toContain('"kind":"exact"');
    // The preamble precedes the agent code when concatenated.
    expect(`${preamble}\n${agentCode}`).toMatch(
      /__bbEnforceOriginScope\(__bbEnforcementPage\.context\(\)\)[\s\S]*agent ran/,
    );
  });

  it("only intercepts navigation requests and lets non-document subresources continue", () => {
    const preamble = enforcementPreambleScript(matcher, "bb-denial-marker");
    expect(preamble).toContain("request.isNavigationRequest()");
    expect(preamble).toContain('route.abort("blockedbyclient")');
    expect(preamble).toContain("route.continue()");
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
    const source = originRequiresCertificateBypassSource();
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

type RecordedRoute = {
  fetch: { url: string; options: Record<string, unknown> } | null;
  fulfill: { response: unknown } | null;
  continueCount: number;
  abortErrorCode: string | null;
  deniedMarker: string | null;
};

async function enforcePreambleAgainst(
  matcher: OriginScopeMatcher,
  denialMarker: string,
  invalidCertificateOrigins: readonly string[],
  requestUrl: string,
  isNavigation: boolean,
): Promise<RecordedRoute> {
  const recorded: RecordedRoute = {
    fetch: null,
    fulfill: null,
    continueCount: 0,
    abortErrorCode: null,
    deniedMarker: null,
  };
  const mockRoute = {
    request: () => ({
      isNavigationRequest: () => isNavigation,
      url: () => requestUrl,
      method: () => "GET",
      headers: () => [],
      postData: () => null,
    }),
    continue: async () => {
      recorded.continueCount += 1;
    },
    abort: async (errorCode?: string) => {
      recorded.abortErrorCode = errorCode ?? null;
    },
    fulfill: async (options: { response: unknown }) => {
      recorded.fulfill = options;
    },
  };
  const mockContext = {
    request: {
      fetch: async (url: string, options: Record<string, unknown>) => {
        recorded.fetch = { url, options };
        return { __bbFetchedResponse: true };
      },
    },
    route: async (
      _pattern: string,
      handler: (route: typeof mockRoute) => Promise<void>,
    ) => {
      await handler(mockRoute);
    },
  };
  const mockPage = { context: () => mockContext };
  const browserGlobal = {
    listPages: async () => [{ id: "fixture-tab" }],
    getPage: async () => mockPage,
  };
  const consoleMock = {
    log: (message: string) => {
      recorded.deniedMarker = message;
    },
  };
  const preamble = enforcementPreambleScript(
    matcher,
    denialMarker,
    invalidCertificateOrigins,
  );
  const factory = compileFunction(
    `return async (browser, console) => {\n${preamble}\n};`,
    ["browser", "console"],
    { filename: "enforcement-preamble.js" },
  );
  await factory()(browserGlobal, consoleMock);
  return recorded;
}

describe("enforcement preamble per-origin cert bypass and denial", () => {
  const grantedOrigin = "https://app.example.test:8443";
  const matcher: OriginScopeMatcher = {
    kind: "exact",
    origin: grantedOrigin,
  };
  const denialMarker = "bb-denial-cert";
  const invalidCertificateOrigins = [grantedOrigin];

  it("issue #14 AC4 bypasses cert errors for a granted invalid-certificate origin so it can load", async () => {
    const recorded = await enforcePreambleAgainst(
      matcher,
      denialMarker,
      invalidCertificateOrigins,
      `${grantedOrigin}/account`,
      true,
    );
    expect(recorded.fetch).not.toBeNull();
    expect(recorded.fetch?.options.ignoreHTTPSErrors).toBe(true);
    expect(recorded.fetch?.url).toBe(`${grantedOrigin}/account`);
    expect(recorded.fulfill).toEqual({
      response: { __bbFetchedResponse: true },
    });
    expect(recorded.continueCount).toBe(0);
    expect(recorded.abortErrorCode).toBeNull();
  });

  it("issue #14 AC4 still blocks an ungranted out-of-scope invalid-certificate origin", async () => {
    const recorded = await enforcePreambleAgainst(
      matcher,
      denialMarker,
      invalidCertificateOrigins,
      "https://evil.example.test/account",
      true,
    );
    expect(recorded.abortErrorCode).toBe("blockedbyclient");
    expect(recorded.fetch).toBeNull();
    expect(recorded.fulfill).toBeNull();
    expect(recorded.continueCount).toBe(0);
    expect(recorded.deniedMarker).toContain(denialMarker);
    expect(recorded.deniedMarker).toContain("https://evil.example.test");
  });

  it("continues normally for an in-scope origin that lacks the invalid-certificate opt-in", async () => {
    const recorded = await enforcePreambleAgainst(
      matcher,
      denialMarker,
      [],
      `${grantedOrigin}/account`,
      true,
    );
    expect(recorded.continueCount).toBe(1);
    expect(recorded.fetch).toBeNull();
    expect(recorded.fulfill).toBeNull();
    expect(recorded.abortErrorCode).toBeNull();
  });
});
