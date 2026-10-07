import { describe, expect, it } from "vitest";
import {
  prepareAgentExecution,
  wrapAgentScriptResult,
} from "../src/browser/agent-script.js";
import { browserScriptParametersSchema } from "../src/shared/contracts.js";

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

type BoundPage = {
  id: string;
  url: string;
  visible: boolean;
  broughtToFront: boolean;
};

/**
 * Run the prepared preamble against a fake tab set and report which page the
 * agent code received. Pages are plain objects: the boundary hardening only
 * touches Playwright internals when they exist, so a minimal page and context
 * shape is enough to exercise tab selection.
 */
async function boundPage(input: {
  pages: readonly { id: string; url: string; visible?: boolean }[];
  preferredOrigin?: string;
  activeTabMarker?: string;
  threadPageName?: string;
  tabId?: string;
}) {
  const context = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
  };
  const pages = new Map<string, BoundPage & Record<string, unknown>>();
  const makePage = (id: string, url: string, visible: boolean) => {
    const page: BoundPage & Record<string, unknown> = {
      id,
      url,
      visible,
      broughtToFront: false,
      context: () => context,
      evaluate: async () => page.visible,
      bringToFront: async () => {
        page.broughtToFront = true;
      },
    };
    pages.set(id, page);
    return page;
  };
  for (const entry of input.pages) {
    makePage(entry.id, entry.url, entry.visible ?? false);
  }
  let created = 0;
  let gets = 0;
  const fakeBrowser = createPinnedBrowserApi<BoundPage>({
    listPages: async () =>
      [...pages.values()].map((page) => ({ id: page.id, url: page.url })),
    getPage: async (id: string) => {
      gets += 1;
      const page = pages.get(id);
      if (page !== undefined) return page;
      created += 1;
      return makePage(`created-${created}`, "about:blank", true);
    },
    newPage: async () => {
      created += 1;
      return makePage(`created-${created}`, "about:blank", true);
    },
    closePage: async () => undefined,
  });
  const logs: string[] = [];
  const prepared = prepareAgentExecution({
    code: "return page.id;",
    ...(input.preferredOrigin === undefined
      ? {}
      : { preferredOrigin: input.preferredOrigin }),
    ...(input.activeTabMarker === undefined
      ? {}
      : { activeTabMarker: input.activeTabMarker }),
    ...(input.threadPageName === undefined
      ? {}
      : { threadPageName: input.threadPageName }),
    ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
  });
  const run = new Function(
    "browser",
    "console",
    `return (async () => {\n${prepared}\n})();`,
  ) as (
    browser: typeof fakeBrowser,
    console: { log: (value: unknown) => void },
  ) => Promise<void>;
  await run(fakeBrowser, { log: (value) => logs.push(String(value)) });
  return { logs, pages, created, gets };
}

describe("shared profile thread page binding", () => {
  it("resumes each thread's page, recreates closed tabs, and honors an explicit tab", async () => {
    const pages = new Map<
      string,
      {
        url: () => string;
        goto: (url: string) => Promise<void>;
        bringToFront: () => Promise<void>;
        context: () => object;
      }
    >();
    let contexts = new Map<string, object>();
    const createPage = (id: string, initialUrl = "about:blank") => {
      let url = initialUrl;
      const context = () => {
        if (!contexts.has(id))
          contexts.set(id, {
            setDefaultNavigationTimeout() {},
            setDefaultTimeout() {},
          });
        return contexts.get(id)!;
      };
      const page = {
        url: () => url,
        goto: async (next: string) => {
          url = next;
        },
        bringToFront: async () => {},
        context,
      };
      pages.set(id, page);
      return page;
    };
    createPage("owner", "https://example.test/owner");
    const browser = createPinnedBrowserApi({
      getPage: async (id: string) => pages.get(id) ?? createPage(id),
      newPage: async () => createPage("anonymous"),
      closePage: async (id: string) => {
        pages.delete(id);
      },
      listPages: async () =>
        [...pages].map(([id, page]) => ({ id, url: page.url() })),
    });
    const execute = async (
      threadPageName: string,
      code: string,
      tabId?: string,
    ) => {
      contexts = new Map();
      const logs: string[] = [];
      const prepared = prepareAgentExecution({
        threadPageName,
        preferredOrigin: "https://example.test",
        code,
        ...(tabId === undefined ? {} : { tabId }),
      });
      await new Function(
        "browser",
        "console",
        `return (async () => {${prepared}})();`,
      )(browser, { log: (value: unknown) => logs.push(String(value)) });
      return logs;
    };
    expect(await execute("agent-a", "return page.url();")).toEqual([
      "https://example.test",
    ]);
    await execute("agent-a", 'await page.goto("https://example.test/a");');
    await execute("agent-b", 'await page.goto("https://example.test/b");');
    expect(await execute("agent-a", "return page.url();")).toEqual([
      "https://example.test/a",
    ]);
    expect(await execute("agent-b", "return page.url();")).toEqual([
      "https://example.test/b",
    ]);
    expect(await execute("agent-a", "return page.url();", "owner")).toEqual([
      "https://example.test/owner",
    ]);
    expect(pages.get("owner")?.url()).toBe("https://example.test/owner");
    pages.delete("agent-a");
    expect(await execute("agent-a", "return page.url();")).toEqual([
      "https://example.test",
    ]);
  });
});

describe("agent page binding", () => {
  it("falls back to the visible tab when no tab is on the preferred origin", async () => {
    const bound = await boundPage({
      pages: [
        { id: "signin", url: "https://accounts.example.test/", visible: true },
      ],
      preferredOrigin: "https://app.example.test",
    });
    expect(bound.logs).toEqual(["signin"]);
    expect(bound.pages.get("signin")?.broughtToFront).toBe(false);
    expect(bound.created).toBe(0);
  });

  it("prefers the visible tab when several tabs share the preferred origin", async () => {
    const bound = await boundPage({
      pages: [
        { id: "background", url: "https://app.example.test/a" },
        { id: "front", url: "https://app.example.test/b", visible: true },
      ],
      preferredOrigin: "https://app.example.test",
    });
    expect(bound.logs).toEqual(["front"]);
  });

  it("binds a hidden tab on the preferred origin ahead of a visible tab elsewhere", async () => {
    const bound = await boundPage({
      pages: [
        { id: "elsewhere", url: "https://other.example.test/", visible: true },
        { id: "granted", url: "https://app.example.test/" },
      ],
      preferredOrigin: "https://app.example.test",
    });
    expect(bound.logs).toEqual(["granted"]);
    expect(bound.pages.get("granted")?.broughtToFront).toBe(false);
  });

  it("uses the first tab when no tab reports itself visible", async () => {
    const bound = await boundPage({
      pages: [
        { id: "first", url: "https://app.example.test/" },
        { id: "second", url: "https://app.example.test/" },
      ],
    });
    expect(bound.logs).toEqual(["first"]);
    expect(bound.pages.get("first")?.broughtToFront).toBe(false);
  });

  it("opens a tab when the profile has none instead of failing", async () => {
    const bound = await boundPage({
      pages: [],
      preferredOrigin: "https://app.example.test",
    });
    expect(bound.created).toBe(1);
    expect(bound.logs).toEqual(["created-1"]);
  });

  it("keeps a successful result when no tab is visible afterwards", async () => {
    const bound = await boundPage({
      pages: [{ id: "hidden", url: "https://app.example.test/" }],
      activeTabMarker: "marker-1",
    });
    expect(bound.logs).toEqual(["hidden"]);
  });

  it("reports the visible tab after the agent code when one exists", async () => {
    const bound = await boundPage({
      pages: [{ id: "front", url: "https://app.example.test/", visible: true }],
      activeTabMarker: "marker-2",
    });
    expect(bound.logs).toEqual([
      '{"__bbActiveTabMarker":"marker-2","id":"front"}',
      "front",
    ]);
  });

  it("reports a visible thread page without scanning every tab again", async () => {
    const bound = await boundPage({
      pages: [
        { id: "agent-a", url: "https://app.example.test/", visible: true },
        { id: "other", url: "https://other.example.test/" },
      ],
      threadPageName: "agent-a",
      activeTabMarker: "marker-3",
    });
    expect(bound.logs).toEqual([
      '{"__bbActiveTabMarker":"marker-3","id":"agent-a"}',
      "agent-a",
    ]);
    // One getPage binds the thread page. The boundary then reads each listed
    // page once. The report must not read them again.
    expect(bound.gets).toBe(3);
  });

  it("still reports another visible tab when the thread page is hidden", async () => {
    const bound = await boundPage({
      pages: [
        { id: "agent-a", url: "https://app.example.test/" },
        { id: "front", url: "https://other.example.test/", visible: true },
      ],
      threadPageName: "agent-a",
      activeTabMarker: "marker-4",
    });
    expect(bound.logs[0]).toBe(
      '{"__bbActiveTabMarker":"marker-4","id":"front"}',
    );
  });
});

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
    expect(prepared).not.toContain("bringToFront");
    expect(prepared).toContain("__bbResult");
  });

  it("binds page to the visible tab when tabId is omitted", () => {
    const prepared = prepareAgentExecution({ code: "return page.url()" });
    expect(prepared).toContain("browser.listPages()");
    expect(prepared).not.toContain('? "main"');
    expect(prepared).toContain("page === undefined");
    expect(prepared.indexOf("visibilityState")).toBeLessThan(
      prepared.indexOf("return page.url()"),
    );
    expect(prepared).not.toContain("bringToFront");
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
  connection.sendMessageToServer(frame, new String("goto"), { url: new String("chrome://newtab/") }, {})
    .then(() => "forwarded", () => "blocked"),
  connection.sendMessageToServer(frame, new String("goto"), { url: new String("chrome-untrusted://new-tab-page/one-google-bar") }, {})
    .then(() => "forwarded", () => "blocked"),
  connection.sendMessageToServer(frame, "goto", { url: { href: "https://example.com/", toString() { return this.href; } } }, {})
    .then(() => "forwarded", () => "blocked"),
]);
console.log(JSON.stringify({ attempts, sentMethods: connection.sentMethods }));
return "completed";`,
      true,
      true,
    );
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      attempts: [
        "blocked",
        "forwarded",
        "forwarded",
        "blocked",
        "blocked",
        "forwarded",
      ],
      sentMethods: ["goto", "goto", "goto"],
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
    expect(prepared).toContain("new URL(entry.url).origin");
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

describe("shared browser context close", () => {
  it("does not throw when the browser has no browser type", async () => {
    class SharedBrowser {
      readonly _contexts = new Set<SharedContext>();
      readonly _browserType: { _contexts: Set<SharedContext> } | undefined =
        undefined;

      contexts() {
        return [...this._contexts];
      }
    }

    class SharedContext {
      _closingStatus = "none";
      _browser: SharedBrowser | null;

      constructor(browser: SharedBrowser) {
        this._browser = browser;
      }

      setDefaultNavigationTimeout() {}

      setDefaultTimeout() {}

      _onClose() {
        this._closingStatus = "closed";
        this._browser?._contexts.delete(this);
        if (this._browser == null) return;
        (
          this._browser._browserType as { _contexts: Set<SharedContext> }
        )._contexts.delete(this);
      }
    }

    const sharedBrowser = new SharedBrowser();
    const bound = new SharedContext(sharedBrowser);
    sharedBrowser._contexts.add(bound);
    const probe = new SharedContext(sharedBrowser);
    expect(() => probe._onClose()).toThrow(/_contexts/u);
    const sibling = new SharedContext(sharedBrowser);
    const page = {
      extra: sibling,
      context: () => bound,
      evaluate: async () => "visible",
      bringToFront: async () => undefined,
      url: () => "https://example.com/",
    };
    const fakeBrowser = createPinnedBrowserApi<typeof page>({
      listPages: async () => [{ id: "tab-1", url: "https://example.com/" }],
      getPage: async () => page,
      newPage: async () => page,
      closePage: async () => undefined,
    });
    const logs: string[] = [];
    const prepared = prepareAgentExecution({
      code: "page.extra._onClose(); return page.extra._closingStatus;",
    });
    const run = new Function(
      "browser",
      "console",
      `return (async () => {\n${prepared}\n})();`,
    ) as (
      browser: typeof fakeBrowser,
      console: { log: (value: unknown) => void },
    ) => Promise<void>;
    await run(fakeBrowser, { log: (value) => logs.push(String(value)) });
    expect(logs).toEqual(["closed"]);
    expect(sibling._browser).toBeNull();
  });
});

it("settles a confirm dialog when dismiss rejects with no dialog showing", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const dialogListeners: Array<
    (dialog: {
      type: () => string;
      accept: () => Promise<void>;
      dismiss: () => Promise<void>;
    }) => void
  > = [];
  const context = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
  };
  const page = {
    id: "confirm-page",
    url: "https://app.example.test/confirm",
    context: () => context,
    evaluate: async (expression: string) => {
      if (expression.includes("confirm(")) return true;
      return "visible";
    },
    on: (
      event: string,
      listener: (dialog: {
        type: () => string;
        accept: () => Promise<void>;
        dismiss: () => Promise<void>;
      }) => void,
    ) => {
      if (event === "dialog") dialogListeners.push(listener);
    },
  };
  const html = `<button id="confirm">confirm</button><script>document.getElementById("confirm").onclick = () => confirm("leave this page?");</script>`;
  const fakeBrowser = createPinnedBrowserApi<typeof page>({
    listPages: async () => [{ id: page.id, url: page.url }],
    getPage: async () => page,
    newPage: async () => page,
    closePage: async () => undefined,
  });
  const logs: string[] = [];
  try {
    const prepared = prepareAgentExecution({
      code: `await page.evaluate(${JSON.stringify(`confirm("leave this page?")`)}); return ${JSON.stringify(html)};`,
    });
    const run = new Function(
      "browser",
      "console",
      `return (async () => {\n${prepared}\n})();`,
    ) as (
      browser: typeof fakeBrowser,
      console: { log: (value: unknown) => void },
    ) => Promise<void>;
    await run(fakeBrowser, { log: (value) => logs.push(String(value)) });
    expect(dialogListeners).toHaveLength(1);
    const dismissed = Promise.reject(new Error("No dialog is showing"));
    dialogListeners[0]?.({
      type: () => "confirm",
      accept: () => dismissed,
      dismiss: () => dismissed,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(logs).toEqual([html]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
