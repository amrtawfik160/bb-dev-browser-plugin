import { describe, expect, it } from "vitest";
import {
  matcherPermitsOrigin,
  originScopeMatcher,
  scopeMatchesOrigin,
} from "../src/access/authorization.js";
import { originRequiresCertificateBypass } from "../src/browser/origin-scope.js";

const scopeMatrix = [
  ["https://app.example.test", "https://app.example.test", true],
  ["https://app.example.test", "https://app.example.test:443", true],
  ["https://app.example.test", "http://app.example.test", false],
  ["https://app.example.test", "https://other.example.test", false],
  ["http://127.0.0.1:3000", "http://127.0.0.1:3000", true],
  ["http://127.0.0.1:3000", "http://127.0.0.1:3001", false],
  ["http://[::1]:3000", "http://[::1]:3000", true],
  ["https://*.example.test", "https://sub.example.test", true],
  ["https://*.example.test", "https://a.b.example.test", true],
  ["https://*.example.test", "https://example.test", false],
  ["https://*.example.test:8443", "https://sub.example.test:8443", true],
  ["https://*.example.test:8443", "https://sub.example.test", false],
  ["*", "https://anywhere.test", true],
  ["*", "http://10.20.30.40:9000", true],
  ["*", "http://localhost:3000", false],
  ["*", "http://127.42.0.7:3000", false],
  ["*", "http://[::1]:3000", false],
  ["*", "http://[::ffff:127.0.0.1]:3000", false],
] as const;

describe("Origin Scope normalized matcher", () => {
  it.each(scopeMatrix)(
    "permits %s against %s consistently",
    (scope, origin, permitted) => {
      const normalizedOrigin = new URL(origin).origin;
      expect(scopeMatchesOrigin(scope, normalizedOrigin)).toBe(permitted);
      expect(
        matcherPermitsOrigin(originScopeMatcher(scope), normalizedOrigin),
      ).toBe(permitted);
    },
  );

  it("treats an unparseable destination as out of scope", () => {
    expect(matcherPermitsOrigin(originScopeMatcher("*"), "not-a-url")).toBe(
      false,
    );
  });
});

describe("per-origin invalid-certificate bypass policy", () => {
  it.each([
    ["https://app.example.test:8443", ["https://app.example.test:8443"], true],
    ["https://app.example.test:8443", [], false],
    ["https://other.example.test", ["https://app.example.test:8443"], false],
    ["not-a-url", ["https://app.example.test:8443"], false],
  ] as const)(
    "matches only an approved exact origin",
    (origin, grants, expected) => {
      expect(originRequiresCertificateBypass(origin, grants)).toBe(expected);
    },
  );
});
