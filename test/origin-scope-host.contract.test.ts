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

type RouteAction = "aborted" | "continued" | "fulfilled";

class SimulatedPage {
  closed = false;
  closeBarrier: Promise<void> | null = null;

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
      throw new Error("Origin Scope route is not installed.");
    }
    const route = new SimulatedRoute(url, page, navigationRequest);
    await this.routeHandler(route as unknown as Route);
    if (route.action === "continued" || route.action === "fulfilled") {
      page.currentUrl = url;
    }
    return route.action;
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
  const close = vi.fn(async () => undefined);
  const browser = {
    contexts: () => [context as unknown as BrowserContext],
    close,
  } as unknown as Browser;
  return {
    context,
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

  it("denies an unchanged out-of-scope tab before agent code can read it", async () => {
    const boundary = simulatedBrowser([
      new SimulatedPage("main", "https://outside.example.test/"),
      new SimulatedPage("other", "https://second-outside.example.test/"),
    ]);

    await expect(
      installHostOriginScopeGuard(
        "ws://127.0.0.1/devtools/browser/test",
        policy(),
        boundary.connect,
      ),
    ).rejects.toEqual(
      new BrowserOriginScopeDeniedError("https://outside.example.test"),
    );
    expect(boundary.context.page("main")).toBeUndefined();
    expect(boundary.context.page("other")).toBeUndefined();
    expect(boundary.close).toHaveBeenCalledOnce();
  });

  it("denies a page that escapes while the host route is being installed", async () => {
    const page = new SimulatedPage("main", "https://app.example.test/");
    const boundary = simulatedBrowser([page]);
    boundary.context.onRouteInstalled = () => {
      page.currentUrl = "https://race.example.test/";
    };

    await expect(
      installHostOriginScopeGuard(
        "ws://127.0.0.1/devtools/browser/test",
        policy(),
        boundary.connect,
      ),
    ).rejects.toEqual(
      new BrowserOriginScopeDeniedError("https://race.example.test"),
    );
    expect(boundary.context.page("main")).toBeUndefined();
    expect(boundary.close).toHaveBeenCalledOnce();
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
