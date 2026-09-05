import { describe, expect, it } from "vitest";
import {
  activeBrowserTabScript,
  projectLoopbackAddress,
  resolveBrowserAddress,
} from "../browser-navigation.js";

type FakeTabBrowser = {
  listPages: () => Promise<{ id: string; url: string }[]>;
  getPage: (id: string) => Promise<{
    evaluate: () => Promise<boolean>;
    bringToFront: () => Promise<void>;
  }>;
};

async function reportedActiveTab(
  pages: readonly { id: string; url: string; visible: boolean }[],
) {
  const broughtToFront: string[] = [];
  const browser: FakeTabBrowser = {
    listPages: async () => pages.map(({ id, url }) => ({ id, url })),
    getPage: async (id: string) => {
      const entry = pages.find((page) => page.id === id)!;
      return {
        evaluate: async () => entry.visible,
        bringToFront: async () => {
          broughtToFront.push(id);
        },
      };
    },
  };
  const logs: string[] = [];
  const run = new Function(
    "browser",
    "console",
    `return (async () => {\n${activeBrowserTabScript()}\n})();`,
  ) as (
    browser: FakeTabBrowser,
    console: { log: (value: unknown) => void },
  ) => Promise<void>;
  await run(browser, { log: (value) => logs.push(String(value)) });
  return { active: JSON.parse(logs[0]!) as { id: string }, broughtToFront };
}

describe("active Browser Tab report", () => {
  it("reports the visible tab", async () => {
    const report = await reportedActiveTab([
      { id: "hidden", url: "https://a.example.test/", visible: false },
      { id: "front", url: "https://b.example.test/", visible: true },
    ]);
    expect(report.active.id).toBe("front");
    expect(report.broughtToFront).toEqual([]);
  });

  it("brings the first tab forward when no tab is visible", async () => {
    const report = await reportedActiveTab([
      { id: "first", url: "https://a.example.test/", visible: false },
      { id: "second", url: "https://b.example.test/", visible: false },
    ]);
    expect(report.active.id).toBe("first");
    expect(report.broughtToFront).toEqual(["first"]);
  });

  it("still fails when the profile has no tabs", async () => {
    await expect(reportedActiveTab([])).rejects.toThrow(
      "The Browser Profile has no open tabs",
    );
  });
});

describe("Workspace Browser navigation", () => {
  it.each([
    ["https://example.test/path?q=one", "https://example.test/path?q=one"],
    ["example.test/path", "https://example.test/path"],
    ["localhost:4173/sign-in", "http://localhost:4173/sign-in"],
    ["127.0.0.1:4173", "http://127.0.0.1:4173/"],
    ["[::1]:4173/sign-in", "http://[::1]:4173/sign-in"],
    ["[::ffff:7f00:1]:4173", "http://[::ffff:7f00:1]:4173/"],
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
    "?fixture=query-only",
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

  it.each(["127.0.0.1", "127.42.0.7", "[::1]", "[::ffff:7f00:1]", "0.0.0.0"])(
    "aliases the raw loopback host %s",
    (hostname) => {
      expect(
        projectLoopbackAddress("project-a", `http://${hostname}:4173/account`),
      ).toMatch(/^http:\/\/p-[a-f0-9]{12}\.localhost:4173\/account$/u);
    },
  );
});
