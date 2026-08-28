import { describe, expect, it } from "vitest";
import {
  projectLoopbackAddress,
  resolveBrowserAddress,
} from "../browser-navigation.js";

describe("Workspace Browser navigation", () => {
  it.each([
    ["https://example.test/path?q=one", "https://example.test/path?q=one"],
    ["example.test/path", "https://example.test/path"],
    ["localhost:4173/sign-in", "http://localhost:4173/sign-in"],
    ["127.0.0.1:4173", "http://127.0.0.1:4173/"],
  ])("navigates the valid address %s directly", (input, expectedUrl) => {
    expect(resolveBrowserAddress(input)).toEqual({
      kind: "address",
      url: expectedUrl,
    });
  });

  it.each([
    "browser integration tests",
    "two words.example",
    "javascript:alert(1)",
  ])(
    "leaves the search text %s for Chrome's configured search engine",
    (input) => {
      expect(resolveBrowserAddress(input)).toEqual({
        kind: "search",
        text: input,
      });
    },
  );

  it("isolates reused loopback ports by project unless raw localhost is explicit", () => {
    const projectA = projectLoopbackAddress(
      "project-a",
      "http://localhost:4173/account",
    );
    const projectB = projectLoopbackAddress(
      "project-b",
      "http://localhost:4173/account",
    );

    expect(projectA).toMatch(
      /^http:\/\/p-[a-f0-9]{12}\.localhost:4173\/account$/u,
    );
    expect(projectB).not.toBe(projectA);
    expect(
      projectLoopbackAddress(
        "project-a",
        "http://localhost:4173/account",
        "raw-localhost",
      ),
    ).toBe("http://localhost:4173/account");
  });

  it.each(["127.0.0.1", "127.42.0.7", "[::1]", "0.0.0.0"])(
    "aliases the raw loopback host %s",
    (hostname) => {
      expect(
        projectLoopbackAddress("project-a", `http://${hostname}:4173/account`),
      ).toMatch(/^http:\/\/p-[a-f0-9]{12}\.localhost:4173\/account$/u);
    },
  );
});
