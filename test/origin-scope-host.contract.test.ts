import type {
  APIResponse,
  Browser,
  BrowserContext,
  Frame,
  Page,
  Request,
  Route,
} from "playwright";
import { describe, expect, it, vi } from "vitest";
import { originScopeMatcher } from "../authorization.js";
import {
  BrowserOriginScopeDeniedError,
  installHostOriginScopeGuard,
  preferOriginScopeDenial,
  type BrowserOriginScopePolicy,
} from "../origin-scope.js";

// This boundary double models the external Playwright/CDP contract directly:
// route decisions, committed page URLs, popup lifecycle, and certificate
// fetches. The provisioned-host suite remains the end-to-end browser check.

type RouteAction = "aborted" | "continued" | "fulfilled" | "unguarded";
type ContextEvent = { context: { _object?: BrowserContext } };
type ContextListener = (event: ContextEvent) => void;

class SimulatedPage {
  closed = false;
  closeBarrier: Promise<void> | null = null;
  /** Rejects the next host-driven navigation, like a beforeunload prompt. */
  gotoFailure: Error | null = null;
  readonly history: string[] = [];

  constructor(
    readonly id: string,
    public currentUrl: string,
    readonly openingPage: SimulatedPage | null = null,
  ) {}

  url() {
    return this.currentUrl;
  }

  isClosed() {
    return this.closed;
  }

  async goto(address: string) {
    if (this.gotoFailure !== null) throw this.gotoFailure;
    this.history.push(this.currentUrl);
    this.currentUrl = address;
  }

  async goBack() {
    const previous = this.history.pop();
    if (previous !== undefined) this.currentUrl = previous;
    return null;
  }

  async close() {
    await this.closeBarrier;
    this.closed = true;
  }

  async opener() {
    return this.openingPage as unknown as Page | null;
  }
}

class SimulatedRoute {
  action: RouteAction | null = null;

  constructor(
    readonly destinationUrl: string,
    readonly destinationPage: SimulatedPage,
    readonly navigationRequest = true,
  ) {}

  request() {
    const frame = {
      page: () => this.destinationPage as unknown as Page,
    } as Frame;
    return {
      url: () => this.destinationUrl,
      isNavigationRequest: () => this.navigationRequest,
      frame: () => frame,
    } as Request;
  }

  async abort() {
    this.action = "aborted";
  }

  async continue() {
    this.action = "continued";
  }

  async fulfill() {
    this.action = "fulfilled";
  }
}

class SimulatedContext {
  readonly certificateFetch = vi.fn(async () => ({}) as APIResponse);
  onRouteInstalled: (() => void) | null = null;
  private routeHandler: ((route: Route) => Promise<void>) | null = null;

  constructor(readonly browserPages: SimulatedPage[]) {}

  readonly request = { fetch: this.certificateFetch };

  pages() {
    return this.browserPages
      .filter((page) => !page.closed)
      .map((page) => page as unknown as Page);
  }

  async route(_pattern: string, handler: (route: Route) => Promise<void>) {
    this.routeHandler = handler;
    this.onRouteInstalled?.();
  }

  async unroute() {
    this.routeHandler = null;
  }

  isRouted() {
    return this.routeHandler !== null;
  }

  popup(id: string, opener: SimulatedPage) {
    const popup = new SimulatedPage(id, "about:blank", opener);
    this.browserPages.push(popup);
    return popup;
  }

  page(id: string) {
    return this.browserPages.find((page) => page.id === id && !page.closed);
  }

  async navigate(page: SimulatedPage, url: string, navigationRequest = true) {
    if (this.routeHandler === null) {
      page.currentUrl = url;
      return "unguarded" as const;
    }
    const route = new SimulatedRoute(url, page, navigationRequest);
    await this.routeHandler(route as unknown as Route);
    if (route.action === "continued" || route.action === "fulfilled") {
      page.currentUrl = url;
    }
    return route.action ?? "unguarded";
  }
}

function policy(
  scope = "https://app.example.test",
  invalidCertificateOrigins: readonly string[] = [],
): BrowserOriginScopePolicy {
  return {
    matcher: originScopeMatcher(scope),
    invalidCertificateOrigins,
    timeoutMs: 5_000,
  };
}

function simulatedBrowser(initialPages: SimulatedPage[]) {
  const context = new SimulatedContext(initialPages);
  const contexts = [context];
  const contextListeners: ContextListener[] = [];
  const close = vi.fn(async () => undefined);
  const channel = {
    on: (event: string, listener: ContextListener) => {
      if (event === "context") contextListeners.push(listener);
    },
    prependListener: (event: string, listener: ContextListener) => {
      if (event === "context") contextListeners.unshift(listener);
    },
    off: (event: string, listener: ContextListener) => {
      if (event === "context") {
        const index = contextListeners.indexOf(listener);
        if (index >= 0) contextListeners.splice(index, 1);
      }
    },
  };
  const browser = {
    contexts: () =>
      contexts.map(
        (currentContext) => currentContext as unknown as BrowserContext,
      ),
    _channel: channel,
    close,
  } as unknown as Browser;
  return {
    context,
    addContextObserver: (listener: ContextListener) => {
      contextListeners.push(listener);
    },
    addContext: (newContext: SimulatedContext) => {
      contexts.push(newContext);
      for (const listener of [...contextListeners]) {
        listener({
          context: { _object: newContext as unknown as BrowserContext },
        });
      }
    },
    close,
    connect: vi.fn(async () => browser),
  };
}

describe("host-owned Origin Scope guard", () => {
  it("preserves an allowed navigation without an agent-sandbox callback", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(
      await boundary.context.navigate(page, "https://app.example.test/account"),
    ).toBe("continued");
    expect(guard.deniedOrigin()).toBeNull();
    await guard.dispose();
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it("retains denial across an out-and-back navigation", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(
      await boundary.context.navigate(page, "https://outside.example.test/"),
    ).toBe("aborted");
    expect(
      await boundary.context.navigate(page, "https://app.example.test/"),
    ).toBe("continued");
    expect(guard.deniedOrigin()).toBe("https://outside.example.test");
    await guard.dispose();
  });

  it("removes a denied popup so a later call cannot reuse it", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const firstGuard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    const popup = boundary.context.popup("popup-1", page);

    expect(
      await boundary.context.navigate(popup, "https://popup.example.test/"),
    ).toBe("aborted");
    expect(firstGuard.deniedOrigin()).toBe("https://popup.example.test");
    expect(boundary.context.page("popup-1")).toBeUndefined();
    await firstGuard.dispose();

    const secondGuard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    expect(boundary.context.page("popup-1")).toBeUndefined();
    expect(secondGuard.deniedOrigin()).toBeNull();
    await secondGuard.dispose();
  });

  it("retains denial after a denied popup has disappeared", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    const popup = boundary.context.popup("popup-1", page);

    await boundary.context.navigate(popup, "https://popup.example.test/");

    expect(boundary.context.page("popup-1")).toBeUndefined();
    expect(guard.deniedOrigin()).toBe("https://popup.example.test");
    await guard.dispose();
  });

  it("waits for denied popup removal before releasing the host guard", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    const popup = boundary.context.popup("popup-1", page);
    let releaseClose!: () => void;
    popup.closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const navigation = boundary.context.navigate(
      popup,
      "https://popup.example.test/",
    );
    await vi.waitFor(() => {
      expect(guard.deniedOrigin()).toBe("https://popup.example.test");
    });
    let disposed = false;
    const disposal = guard.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(disposed).toBe(false);
    releaseClose();
    await navigation;
    await disposal;
    expect(boundary.context.page("popup-1")).toBeUndefined();
  });

  it("parks unchanged out-of-scope owner tabs on about:blank and restores them after the call", async () => {
    const main = new SimulatedPage("main", "https://outside.example.test/");
    const other = new SimulatedPage(
      "other",
      "https://second-outside.example.test/",
    );
    const granted = new SimulatedPage("granted", "https://app.example.test/");
    const boundary = simulatedBrowser([main, other, granted]);

    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    // The agent's call proceeds; the owner's tabs are out of reach, not gone.
    expect(guard.deniedOrigin()).toBeNull();
    expect(main.url()).toBe("about:blank");
    expect(other.url()).toBe("about:blank");
    expect(main.closed).toBe(false);
    expect(other.closed).toBe(false);
    expect(granted.url()).toBe("https://app.example.test/");

    await guard.dispose();
    expect(main.url()).toBe("https://outside.example.test/");
    expect(other.url()).toBe("https://second-outside.example.test/");
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it("leaves a parked tab where the agent navigated it", async () => {
    const parked = new SimulatedPage("parked", "https://outside.example.test/");
    const boundary = simulatedBrowser([parked]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    expect(parked.url()).toBe("about:blank");

    expect(
      await boundary.context.navigate(parked, "https://app.example.test/work"),
    ).toBe("continued");
    await guard.dispose();
    expect(parked.url()).toBe("https://app.example.test/work");
  });

  it("closes an out-of-scope tab that refuses to park", async () => {
    const stuck = new SimulatedPage("stuck", "https://outside.example.test/");
    stuck.gotoFailure = new Error("beforeunload prompt kept the page");
    const boundary = simulatedBrowser([stuck]);

    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    expect(guard.deniedOrigin()).toBeNull();
    expect(boundary.context.page("stuck")).toBeUndefined();
    await guard.dispose();
  });

  // Recovery issue #64: non-web locations must not disappear into the old
  // null-origin allow path or be surfaced as host-derived identifiers.
  it.each([
    "about:srcdoc",
    "data:text/html,<h1>private</h1>",
    "file:///tmp/private.txt",
    "chrome://settings",
    "javascript:document.body.innerHTML='private'",
    "not a URL",
  ])("parks an existing non-web page before agent access: %s", async (url) => {
    const page = new SimulatedPage("non-web", url);
    const boundary = simulatedBrowser([page]);

    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    expect(guard.deniedOrigin()).toBeNull();
    expect(page.url()).toBe("about:blank");
    expect(page.closed).toBe(false);
    await guard.dispose();
    expect(page.url()).toBe(url);
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it("allows an existing safe internal blank page without a denial", async () => {
    const page = new SimulatedPage("blank", "about:blank");
    const boundary = simulatedBrowser([page]);

    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(guard.deniedOrigin()).toBeNull();
    await guard.dispose();
  });

  it.each([
    "chrome://newtab/",
    "chrome://new-tab-page/",
    "chrome-untrusted://new-tab-page/one-google-bar",
    "chrome-error://chromewebdata/",
  ])(
    "clears an existing Chrome idle tab before agent access: %s",
    async (url) => {
      const page = new SimulatedPage("idle", url);
      const boundary = simulatedBrowser([page]);

      const guard = await installHostOriginScopeGuard(
        "ws://127.0.0.1/devtools/browser/test",
        policy(),
        boundary.connect,
      );

      expect(guard.deniedError()).toBeNull();
      expect(boundary.context.page("idle")?.url()).toBe("about:blank");
      expect(await boundary.context.navigate(page, url)).toBe("aborted");
      expect(guard.deniedError()).toBeInstanceOf(BrowserOriginScopeDeniedError);
      await guard.dispose();
    },
  );

  it("does not treat an empty CDP navigation URL as a non-web denial", async () => {
    const page = new SimulatedPage("main", "chrome://newtab/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(await boundary.context.navigate(page, "")).toBe("continued");
    expect(guard.deniedError()).toBeNull();
    await guard.dispose();
  });

  it("allows an exact about:blank navigation as the safe internal exception", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(await boundary.context.navigate(page, "about:blank")).toBe(
      "continued",
    );
    expect(guard.deniedError()).toBeNull();
    await guard.dispose();
  });

  it("matches an existing blob page by its embedded HTTP(S) origin", async () => {
    const page = new SimulatedPage(
      "blob-page",
      "blob:https://outside.example.test/blob-id",
    );
    const boundary = simulatedBrowser([page]);

    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    expect(page.url()).toBe("about:blank");
    expect(page.closed).toBe(false);
    await guard.dispose();
    expect(page.url()).toBe("blob:https://outside.example.test/blob-id");
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it.each([
    "about:srcdoc",
    "data:text/html,<h1>private</h1>",
    "file:///tmp/private.txt",
    "chrome://settings",
    "javascript:document.body.innerHTML='private'",
    "not a URL",
  ])("aborts a non-web navigation: %s", async (url) => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(await boundary.context.navigate(page, url)).toBe("aborted");
    expect(guard.deniedError()).toEqual(
      new BrowserOriginScopeDeniedError(null),
    );
    expect(preferOriginScopeDenial(guard, new Error("fallback"))).toEqual(
      new BrowserOriginScopeDeniedError(null),
    );
    await guard.dispose();
  });

  it("matches a blob navigation by its embedded HTTP(S) origin", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(
      await boundary.context.navigate(
        page,
        "blob:https://app.example.test/blob-id",
      ),
    ).toBe("continued");
    expect(
      await boundary.context.navigate(
        page,
        "blob:https://outside.example.test/blob-id",
      ),
    ).toBe("aborted");
    expect(guard.deniedOrigin()).toBe("https://outside.example.test");
    await guard.dispose();
  });

  it("parks a page that escapes while the host route is being installed", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    boundary.context.onRouteInstalled = () => {
      page.currentUrl = "https://race.example.test/";
    };

    // The agent has not run yet, so the escape is the owner's or the
    // renderer's navigation: the document leaves the agent's reach without
    // costing the owner the tab.
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    expect(guard.deniedOrigin()).toBeNull();
    expect(page.url()).toBe("about:blank");
    expect(boundary.context.page("main")).toBe(page);
    await guard.dispose();
    expect(page.url()).toBe("https://race.example.test/");
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it("guards a BrowserContext created after the initial snapshot", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );
    const laterPage = new SimulatedPage("later", "https://app.example.test/");
    const laterContext = new SimulatedContext([laterPage]);

    boundary.addContext(laterContext);
    await vi.waitFor(() => expect(laterContext.isRouted()).toBe(true));

    expect(
      await laterContext.navigate(laterPage, "https://outside.example.test/"),
    ).toBe("aborted");
    expect(guard.deniedOrigin()).toBe("https://outside.example.test");
    await guard.dispose();
  });

  it("starts guarding a later context before a competing creation listener can navigate", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const laterPage = new SimulatedPage("later", "https://app.example.test/");
    const laterContext = new SimulatedContext([laterPage]);
    let navigation!: Promise<RouteAction>;
    boundary.addContextObserver(() => {
      navigation = laterContext.navigate(
        laterPage,
        "https://outside.example.test/",
      );
    });
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    try {
      boundary.addContext(laterContext);

      await expect(navigation).resolves.toBe("aborted");
      expect(laterPage.url()).toBe("https://app.example.test/");
      expect(guard.deniedOrigin()).toBe("https://outside.example.test");
    } finally {
      await guard.dispose();
    }
  });

  it("blocks an out-of-scope frame document before commit", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    expect(
      await boundary.context.navigate(page, "https://frame.example.test/"),
    ).toBe("aborted");
    expect(guard.deniedOrigin()).toBe("https://frame.example.test");
    await guard.dispose();
  });

  it("keeps a denial when agent code exits through another exception", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy(),
      boundary.connect,
    );

    await boundary.context.navigate(page, "https://outside.example.test/");
    const fallback = new Error("agent script failed after catching navigation");

    expect(preferOriginScopeDenial(guard, fallback)).toEqual(
      new BrowserOriginScopeDeniedError("https://outside.example.test"),
    );
    await guard.dispose();
  });

  it("bypasses invalid certificates only for the approved exact origin", async () => {
    const page = new SimulatedPage("main", "https://one.example.test/");
    const boundary = simulatedBrowser([page]);
    const guard = await installHostOriginScopeGuard(
      "ws://127.0.0.1/devtools/browser/test",
      policy("https://*.example.test", ["https://one.example.test"]),
      boundary.connect,
    );

    expect(
      await boundary.context.navigate(page, "https://one.example.test/path"),
    ).toBe("fulfilled");
    expect(
      await boundary.context.navigate(page, "https://two.example.test/path"),
    ).toBe("continued");
    expect(boundary.context.certificateFetch).toHaveBeenCalledTimes(1);
    expect(boundary.context.certificateFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ignoreHTTPSErrors: true,
        maxRedirects: 0,
      }),
    );
    expect(guard.deniedOrigin()).toBeNull();
    await guard.dispose();
  });
});
