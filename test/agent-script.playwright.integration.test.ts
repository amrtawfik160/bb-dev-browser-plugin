import { createServer, type Server } from "node:http";
import { chromium, type BrowserContext, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { prepareAgentExecution } from "../src/browser/agent-script.js";

type PinnedBrowserApi = {
  getPage: (nameOrId: string) => Promise<Page>;
  newPage: () => Promise<Page>;
  listPages: () => Promise<ReadonlyArray<{ id: string; url: string }>>;
  closePage: (name: string) => Promise<void>;
};

function createPinnedBrowserApi(
  context: BrowserContext,
  namedPages: Map<string, Page>,
): Readonly<PinnedBrowserApi> {
  const pageIds = new Map<Page, string>();
  for (const [name, page] of namedPages) pageIds.set(page, name);

  const getPage = async (nameOrId: string) => {
    const existingPage = namedPages.get(nameOrId);
    if (existingPage !== undefined && !existingPage.isClosed()) {
      return existingPage;
    }
    const createdPage = await context.newPage();
    namedPages.set(nameOrId, createdPage);
    pageIds.set(createdPage, nameOrId);
    return createdPage;
  };

  const newPage = async () => context.newPage();
  const listPages = async () =>
    context
      .pages()
      .filter((page) => !page.isClosed())
      .map((page, index) => ({
        id: pageIds.get(page) ?? `page-${index}`,
        url: page.url(),
      }));

  const browserApi = Object.create(null) as PinnedBrowserApi;
  Object.defineProperties(browserApi, {
    getPage: { value: getPage, enumerable: true },
    newPage: { value: newPage, enumerable: true },
    listPages: { value: listPages, enumerable: true },
    closePage: {
      value: async (name: string) => {
        await namedPages.get(name)?.close();
      },
      enumerable: true,
    },
  });
  return Object.freeze(browserApi);
}

async function listenWithLateResponse(): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late response"), 2_000);
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The timeout evidence server did not bind TCP.");
  }
  return { server, url: `http://127.0.0.1:${address.port}/late` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function runPreparedScript(
  browserApi: Readonly<PinnedBrowserApi>,
  preparedCode: string,
): Promise<string[]> {
  const logs: string[] = [];
  const run = new Function(
    "browser",
    "console",
    `return (async () => {\n${preparedCode}\n})();`,
  ) as (
    browser: Readonly<PinnedBrowserApi>,
    console: { log: (value: unknown) => void },
  ) => Promise<void>;
  await run(browserApi, { log: (value) => logs.push(String(value)) });
  return logs;
}

describe("issue #64 pinned Playwright timeout evidence", () => {
  it("applies context deadlines to initial, existing, and future same-context pages", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const initialPage = await context.newPage();
    const existingPage = await context.newPage();
    const browserApi = createPinnedBrowserApi(
      context,
      new Map([
        ["initial", initialPage],
        ["existing", existingPage],
      ]),
    );
    const timeoutServer = await listenWithLateResponse();

    try {
      expect(Object.getPrototypeOf(browserApi)).toBeNull();
      expect(Object.isFrozen(browserApi)).toBe(true);
      for (const property of ["getPage", "newPage", "listPages", "closePage"]) {
        expect(Object.getOwnPropertyDescriptor(browserApi, property)).toEqual(
          expect.objectContaining({
            configurable: false,
            enumerable: true,
            writable: false,
          }),
        );
      }

      const prepared = prepareAgentExecution({
        tabId: "initial",
        timeoutMs: 1_000,
        code: `
const expectedTimeout = "Timeout 750ms exceeded";
const candidates = [
  { label: "initial", page },
  { label: "existing", page: await browser.getPage("existing") },
  { label: "future-get-page", page: await browser.getPage("future") },
  { label: "future-new-page", page: await browser.newPage() },
];
const observeActionTimeout = async (candidate) => {
  try {
    await candidate.page.locator("#never-appears").click();
    return { label: candidate.label, timedOut: false, hasCallLog: false };
  } catch (error) {
    const message = String(error);
    return {
      label: candidate.label,
      timedOut: message.includes(expectedTimeout),
      hasCallLog: message.includes("Call log:"),
    };
  }
};
const observeNavigationTimeout = async (candidate) => {
  try {
    await candidate.page.goto(${JSON.stringify(timeoutServer.url)});
    return { label: candidate.label, timedOut: false, hasCallLog: false };
  } catch (error) {
    const message = String(error);
    return {
      label: candidate.label,
      timedOut: message.includes(expectedTimeout),
      hasCallLog: message.includes("Call log:"),
    };
  }
};
return JSON.stringify({
  action: await Promise.all(candidates.map(observeActionTimeout)),
  navigation: await Promise.all(candidates.map(observeNavigationTimeout)),
});`,
      });
      const logs = await runPreparedScript(browserApi, prepared);
      const expected = [
        { label: "initial", timedOut: true, hasCallLog: true },
        { label: "existing", timedOut: true, hasCallLog: true },
        { label: "future-get-page", timedOut: true, hasCallLog: true },
        { label: "future-new-page", timedOut: true, hasCallLog: true },
      ];

      expect(JSON.parse(logs[0] ?? "{}")).toEqual({
        action: expected,
        navigation: expected,
      });
    } finally {
      await browser.close();
      await closeServer(timeoutServer.server);
    }
  }, 15_000);
});
