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

describe("shared profile authentication", () => {
  it("keeps owner and agent tabs separate while sharing the site's authentication", async () => {
    const server = createServer((request, response) => {
      response.end(
        request.headers.cookie?.includes("fixture_login=active")
          ? "signed in"
          : "sign in",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture did not bind.");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const ownerPage = await context.newPage();
    const namedPages = new Map([["owner", ownerPage]]);
    const browserApi = createPinnedBrowserApi(context, namedPages);
    try {
      await context.addCookies([
        { name: "fixture_login", value: "active", url: origin },
      ]);
      await ownerPage.goto(`${origin}/owner`);
      const output = await runPreparedScript(
        browserApi,
        prepareAgentExecution({
          threadPageName: "agent-thread-a",
          preferredOrigin: origin,
          code: `
const initial = await page.locator('body').innerText();
await page.goto(${JSON.stringify(`${origin}/work-a`)});
const other = await browser.getPage('agent-thread-b');
await other.goto(${JSON.stringify(`${origin}/work-b`)});
const authenticated = await other.locator('body').innerText();
const resumed = await browser.getPage('agent-thread-a');
return JSON.stringify({initial, authenticated, resumed: resumed.url()});`,
        }),
      );
      expect(JSON.parse(output[0]!)).toEqual({
        initial: "signed in",
        authenticated: "signed in",
        resumed: `${origin}/work-a`,
      });
      expect(ownerPage.url()).toBe(`${origin}/owner`);
      expect(namedPages.get("agent-thread-a")?.url()).toBe(`${origin}/work-a`);
      expect(namedPages.get("agent-thread-b")?.url()).toBe(`${origin}/work-b`);
    } finally {
      await browser.close();
      await closeServer(server);
    }
  });
});
