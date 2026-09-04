import { describe, expect, it } from "vitest";
import {
  prepareAgentExecution,
  wrapAgentScriptResult,
} from "../agent-script.js";
import { browserScriptParametersSchema } from "../contracts.js";

type BrowserApi<Page> = {
  getPage: (nameOrId: string) => Promise<Page>;
  newPage: () => Promise<Page>;
  listPages: () => Promise<ReadonlyArray<{ id: string; url: string }>>;
  closePage: (name: string) => Promise<void>;
};

function createPinnedBrowserApi<Page>(callbacks: BrowserApi<Page>) {
  const browserApi = Object.create(null) as BrowserApi<Page>;
  Object.defineProperties(browserApi, {
    getPage: { value: callbacks.getPage, enumerable: true },
    newPage: { value: callbacks.newPage, enumerable: true },
    listPages: { value: callbacks.listPages, enumerable: true },
    closePage: { value: callbacks.closePage, enumerable: true },
  });
  return Object.freeze(browserApi);
}

async function capturedLogs(code: string) {
  const logs: string[] = [];
  const wrapped = wrapAgentScriptResult(code);
  const run = new Function(
    "console",
    `return (async () => {\n${wrapped}\n})();`,
  ) as (console: { log: (value: unknown) => void }) => Promise<void>;
  await run({ log: (value) => logs.push(String(value)) });
  return logs;
}

async function preparedLogs(
  code: string,
  enforceNonWebNavigation = false,
  allowError = false,
) {
  const logs: string[] = [];
  // These fields mirror the pinned dev-browser@0.2.9 Playwright client:
  // BrowserContext._browser, ChannelOwner._parent/_connection, Page._browserContext,
  // and Connection._objects are all enumerable escape paths in that client.
  class FakeConnection {
    readonly _objects = new Map<string, object>();
    readonly sentMethods: string[] = [];
    onmessage = async (message: { method?: unknown }) => {
      if (String(message.method) === "newContext") {
        return "unrestricted-context";
      }
      return undefined;
    };

    async sendMessageToServer(_owner: { _type?: string }, method: unknown) {
      this.sentMethods.push(String(method));
      if (String(method) === "newContext") return "unrestricted-context";
      if (String(method) === "goto") return "forwarded";
      return undefined;
    }
  }

  class FakeBrowserType {
    readonly _type = "BrowserType";
    readonly _playwright = {};

    constructor(readonly _connection: FakeConnection) {}

    async launch() {
      return "unrestricted-browser";
    }
  }

  class FakeBrowser {
    readonly _type = "Browser";
    readonly _contexts = new Set<FakeContext>();
    readonly _channel;

    constructor(
      readonly _connection: FakeConnection,
      readonly _browserType: FakeBrowserType,
    ) {
      this._channel = {
        newContext: async () =>
          this._connection.sendMessageToServer(this, "newContext"),
      };
    }

    browserType() {
      return this._browserType;
    }

    async newContext() {
      return "unrestricted-context";
    }

    async newPage() {
      return "unrestricted-page";
    }

    contexts() {
      return [...this._contexts];
    }
  }

  class FakeContext {
    readonly _type = "BrowserContext";
    _browser: FakeBrowser;
    defaultNavigationTimeout: number | null = null;
    defaultTimeout: number | null = null;

    constructor(
      readonly _parent: FakeBrowser,
      readonly _connection: FakeConnection,
    ) {
      this._browser = _parent;
    }

    browser() {
      return this._browser;
    }

    setDefaultNavigationTimeout(timeoutMs: number) {
      this.defaultNavigationTimeout = timeoutMs;
    }

    setDefaultTimeout(timeoutMs: number) {
      this.defaultTimeout = timeoutMs;
    }
  }

  class FakePage {
    readonly _type = "Page";
    readonly _browserContext: FakeContext;

    constructor(
      readonly _parent: FakeContext,
      readonly _connection: FakeConnection,
    ) {
      this._browserContext = _parent;
    }

    context() {
      return this._browserContext;
    }

    bringToFront = async () => undefined;
    evaluate = async () => "visible";
  }

  const connection = new FakeConnection();
  const browserType = new FakeBrowserType(connection);
  const playwrightBrowser = new FakeBrowser(connection, browserType);
  const context = new FakeContext(playwrightBrowser, connection);
  const page = new FakePage(context, connection);
  const extraPage = new FakePage(context, connection);
  playwrightBrowser._contexts.add(context);
  for (const [guid, object] of [
    ["browser", playwrightBrowser],
    ["browser-type", browserType],
    ["context", context],
    ["page", page],
  ] as const) {
    connection._objects.set(guid, object);
  }

  const fakeBrowser = createPinnedBrowserApi<FakePage>({
    listPages: async () => [{ id: "tab-1", url: "about:blank" }],
    getPage: async (id: string) => (id === "tab-2" ? extraPage : page),
    newPage: async () => extraPage,
    closePage: async () => undefined,
  });
  const prepared = prepareAgentExecution({
    code,
    enforceNonWebNavigation,
  });
  const run = new Function(
    "browser",
    "console",
    `return (async () => {\n${prepared}\n})();`,
  ) as (
    browser: typeof fakeBrowser,
    console: { log: (value: unknown) => void },
  ) => Promise<void>;
  try {
    await run(fakeBrowser, { log: (value) => logs.push(String(value)) });
  } catch (error) {
    if (!allowError) throw error;
    logs.push(String(error));
  }
  return logs;
}

describe("agent script convenience wrapping", () => {
  it("prints a returned string as the script result", async () => {
    expect(await capturedLogs('return "https://example.com/";')).toEqual([
      "https://example.com/",
    ]);
  });

  it("prints a returned object as JSON", async () => {
    expect(await capturedLogs('return { title: "Example Domain" };')).toEqual([
      '{"title":"Example Domain"}',
    ]);
  });

  it("leaves console.log-only scripts unchanged", async () => {
    expect(await capturedLogs('console.log("hello");')).toEqual(["hello"]);
  });

  it("keeps both console.log and a later return", async () => {
    expect(await capturedLogs('console.log("hello"); return "world";')).toEqual(
      ["hello", "world"],
    );
  });

  it("binds page to an explicit tab before the agent code", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      tabId: "tab-checkout",
    });
    expect(prepared.indexOf('browser.getPage("tab-checkout")')).toBeLessThan(
      prepared.indexOf("return page.url()"),
    );
    expect(prepared).toContain("await page.bringToFront()");
    expect(prepared).toContain("__bbResult");
  });

  it("binds page to the visible tab when tabId is omitted", () => {
    const prepared = prepareAgentExecution({ code: "return page.url()" });
    expect(prepared).toContain("browser.listPages()");
    expect(prepared).toContain('? "main"');
    expect(prepared.indexOf("visibilityState")).toBeLessThan(
      prepared.indexOf("return page.url()"),
    );
    expect(prepared).toContain("await page.bringToFront()");
  });

  it("issue #64 runs user code with the pinned frozen dev-browser API", async () => {
    const logs = await preparedLogs(
      'console.log("user-code-reached"); return "completed";',
      false,
      true,
    );

    expect(logs).toEqual(["user-code-reached", "completed"]);
  });

  // Recovery issue #64: the public Page → BrowserContext → Browser path must
  // not expose a context-creating Browser root to agent code.
  it("blocks every pinned Browser alias from creating a later context", async () => {
    const logs = await preparedLogs(`
const context = page.context();
const browserAliases = [
  context.browser(),
  context._browser,
  context._parent,
  page._browserContext._browser,
  ...page._connection._objects.values(),
].filter((candidate) => candidate && candidate._type === "Browser");
const browserRoots = [...new Set(browserAliases)];
const creationAttempts = await Promise.all(browserRoots.map(async (root) => {
  try {
    await root.newContext();
    return "created";
  } catch {
    return "blocked";
  }
}));
const channelAttempt = browserRoots.length === 0
  ? "missing"
  : await browserRoots[0]._channel.newContext({}).then(() => "created", () => "blocked");
const connectionAttempt = browserRoots.length === 0
  ? "missing"
  : await page._connection.sendMessageToServer(browserRoots[0], new String("newContext"), {}, {})
      .then(() => "created", () => "blocked");
const onmessageAttempt = await page._connection.onmessage({
  guid: "browser",
  method: new String("newContext"),
}).then(() => "created", () => "blocked");
const browserType = browserRoots.length === 0 ? null : browserRoots[0].browserType();
const browserTypeAttempt = browserType === null
  ? "missing"
  : await browserType.launch().then(() => "created", () => "blocked");
return JSON.stringify({
  contextBrowserIsNull: context.browser() === null,
  ownBrowserIsNull: context._browser === null,
  parentBrowserIsNull: context._parent === null,
  browserAliasCount: browserRoots.length,
  creationAttempts,
  channelAttempt,
  connectionAttempt,
  onmessageAttempt,
  browserTypeAttempt,
});`);
    const outcome = JSON.parse(logs[0] ?? "{}");

    expect(outcome).toMatchObject({
      contextBrowserIsNull: true,
      ownBrowserIsNull: true,
      parentBrowserIsNull: true,
      creationAttempts: ["blocked"],
      channelAttempt: "blocked",
      connectionAttempt: "blocked",
      onmessageAttempt: "blocked",
      browserTypeAttempt: "missing",
    });
    expect(outcome.browserAliasCount).toBeGreaterThan(0);
  });

  it("blocks direct non-web goto at the pinned Playwright protocol boundary", async () => {
    const logs = await preparedLogs(
      `const frame = { _type: "Frame" };
const connection = page._connection;
const attempts = await Promise.all([
  connection.sendMessageToServer(frame, new String("goto"), { url: new String("data:text/html,private") }, {})
    .then(() => "forwarded", (error) => String(error).includes("non-web URL") ? "blocked" : String(error)),
  connection.sendMessageToServer(frame, new String("goto"), { url: new String("about:blank") }, {})
    .then(() => "forwarded", () => "blocked"),
  connection.sendMessageToServer(frame, new String("goto"), { url: new String("blob:https://app.example.test/blob-id") }, {})
    .then(() => "forwarded", () => "blocked"),
]);
console.log(JSON.stringify({ attempts, sentMethods: connection.sentMethods }));
return "completed";`,
      true,
      true,
    );
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      attempts: ["blocked", "forwarded", "forwarded"],
      sentMethods: ["goto", "goto"],
    });
    expect(logs[1]).toContain("non-web URL");
  });

  it("keeps a caught protocol denial ahead of a later script error", async () => {
    const logs = await preparedLogs(
      `try {
  await page._connection.sendMessageToServer(
    { _type: "Frame" },
    new String("goto"),
    { url: new String("data:text/html,private") },
    {},
  );
} catch {}
throw new Error("later script failure");`,
      true,
      true,
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("non-web URL");
    expect(logs[0]).not.toContain("later script failure");
  });

  it("keeps new pages in the guarded context available after cutting its Browser root", async () => {
    await expect(
      preparedLogs(
        "const extraPage = await browser.newPage(); return extraPage.context().browser() === null;",
      ),
    ).resolves.toEqual(["true"]);
  });

  it("prefers a tab already on the granted origin", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      preferredOrigin: "https://example.com",
    });
    expect(prepared).toContain("https://example.com");
    expect(prepared).toContain("new URL(__bbEntry.url).origin");
  });

  it("leaves helper headroom at the minimum accepted host timeout", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      timeoutMs: 1_000,
    });
    expect(prepared).toContain("context.setDefaultTimeout(750)");
    expect(prepared).toContain("context.setDefaultNavigationTimeout(750)");
  });

  it("rejects subsecond host timeouts at the public schema boundary", () => {
    const input = {
      purpose: "Exercise the deadline boundary",
      code: "return page.url()",
    };

    expect(
      browserScriptParametersSchema.safeParse({ ...input, timeoutMs: 999 })
        .success,
    ).toBe(false);
    expect(
      browserScriptParametersSchema.safeParse({ ...input, timeoutMs: 1_000 })
        .success,
    ).toBe(true);
  });

  it("declares page before the native screenshot finally block", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      tabId: "tab-screenshot",
      screenshot: { fileName: "shot.png", marker: "bb-screenshot-test" },
    });
    expect(prepared.indexOf("const page")).toBeLessThan(
      prepared.indexOf("try {"),
    );
    expect(prepared.indexOf("try {")).toBeLessThan(
      prepared.indexOf("page.screenshot"),
    );
  });
});
