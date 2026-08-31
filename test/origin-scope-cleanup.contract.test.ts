import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { originScopeMatcher } from "../authorization.js";
import {
  BrowserOriginScopeDeniedError,
  installHostOriginScopeGuard,
} from "../origin-scope.js";
import { installPageNavigationGuard } from "../origin-scope-cdp.js";

type CleanupFailure = {
  close?: Error;
  stopLoading?: Error;
  pageClose?: Error;
  detach?: Error;
};

class FakePage {
  closed = false;
  private contextValue!: BrowserContext;

  constructor(
    private readonly failure: CleanupFailure,
    private readonly currentUrl = "https://allowed.example.test/",
  ) {}

  setContext(context: BrowserContext) {
    this.contextValue = context;
  }

  context() {
    return this.contextValue;
  }

  isClosed() {
    return this.closed;
  }

  url() {
    return this.currentUrl;
  }

  async close() {
    if (this.failure.pageClose !== undefined) throw this.failure.pageClose;
    this.closed = true;
  }
}

class FakeCdpSession {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    private readonly page: FakePage,
    private readonly failure: CleanupFailure,
  ) {}

  async send(method: string) {
    if (method === "Page.enable") return;
    if (method === "Page.close") {
      if (this.failure.close !== undefined) throw this.failure.close;
      this.page.closed = true;
      return;
    }
    if (method === "Page.stopLoading") {
      if (this.failure.stopLoading !== undefined) {
        throw this.failure.stopLoading;
      }
      return;
    }
  }

  async detach() {
    if (this.failure.detach !== undefined) throw this.failure.detach;
  }

  on(event: string, listener: (payload: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (payload: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

function createPageBoundary(
  failure: CleanupFailure,
  currentUrl = "https://allowed.example.test/",
) {
  const page = new FakePage(failure, currentUrl);
  const session = new FakeCdpSession(page, failure);
  const context = {
    newCDPSession: async () => session as unknown as CDPSession,
  } as unknown as BrowserContext;
  page.setContext(context);
  return { page, session, context };
}

function deniedPageOptions(recorded: Error[], closeDeniedPage: boolean) {
  return {
    classify: () =>
      new BrowserOriginScopeDeniedError("https://outside.example.test"),
    closeDeniedPage: () => closeDeniedPage,
    recordDenial: (denial: Error) => recorded.push(denial),
  };
}

function createHostBoundary(
  failure: CleanupFailure,
  currentUrl = "https://allowed.example.test/",
) {
  const { page, session } = createPageBoundary(failure, currentUrl);
  let browserClosed = false;
  const contextChannel = {
    prependListener: vi.fn(),
    off: vi.fn(),
  };
  const context = {
    pages: () => (browserClosed ? [] : [page as unknown as Page]),
    route: vi.fn(async () => undefined),
    unroute: vi.fn(async () => undefined),
    newCDPSession: async () => session as unknown as CDPSession,
    _channel: contextChannel,
  } as unknown as BrowserContext;
  page.setContext(context);
  const browserChannel = {
    prependListener: vi.fn(),
    off: vi.fn(),
  };
  const close = vi.fn(async () => {
    if (failure.close !== undefined) throw failure.close;
    browserClosed = true;
    page.closed = true;
  });
  const browser = {
    contexts: () => (browserClosed ? [] : [context]),
    _channel: browserChannel,
    close,
  } as unknown as Browser;
  return { browser, close, page, context };
}

const policy = {
  matcher: originScopeMatcher("https://allowed.example.test"),
  invalidCertificateOrigins: [],
  timeoutMs: 5_000,
};

describe("Origin Scope cleanup", () => {
  it("issue #64 surfaces failed renderer close cleanup instead of resolving", async () => {
    const failure = {
      close: new Error("Page.close failed"),
      stopLoading: new Error("Page.stopLoading failed"),
      pageClose: new Error("Playwright page.close failed"),
    };
    const { page, session } = createPageBoundary(failure);
    const recorded: Error[] = [];
    const guard = await installPageNavigationGuard(
      page as unknown as Page,
      deniedPageOptions(recorded, true),
    );

    session.emit("Page.frameStartedNavigating", {
      frameId: "main",
      url: "data:text/html,denied",
    });

    await expect(guard.dispose()).rejects.toMatchObject({
      errors: expect.arrayContaining([
        failure.close,
        failure.stopLoading,
        failure.pageClose,
      ]),
    });
    expect(recorded[0]).toBeInstanceOf(BrowserOriginScopeDeniedError);
    expect(page.isClosed()).toBe(false);
  });

  it("issue #64 neutralizes a denied renderer when the first close command fails", async () => {
    const { page, session } = createPageBoundary({
      close: new Error("Page.close failed"),
    });
    const guard = await installPageNavigationGuard(
      page as unknown as Page,
      deniedPageOptions([], true),
    );

    session.emit("Page.frameStartedNavigating", {
      frameId: "main",
      url: "data:text/html,denied",
    });

    await expect(guard.dispose()).resolves.toBeUndefined();
    expect(page.isClosed()).toBe(true);
  });

  it("issue #64 surfaces failed stop-and-close cleanup for denied navigation", async () => {
    const failure = {
      stopLoading: new Error("Page.stopLoading failed"),
      pageClose: new Error("Playwright page.close failed"),
    };
    const { page, session } = createPageBoundary(failure);
    const guard = await installPageNavigationGuard(
      page as unknown as Page,
      deniedPageOptions([], false),
    );

    session.emit("Page.frameStartedNavigating", {
      frameId: "main",
      url: "https://outside.example.test/escape",
    });

    await expect(guard.dispose()).rejects.toMatchObject({
      errors: expect.arrayContaining([failure.stopLoading, failure.pageClose]),
    });
    expect(page.isClosed()).toBe(false);
  });

  it("issue #64 surfaces CDP detach failure from a page guard", async () => {
    const { page } = createPageBoundary({
      detach: new Error("CDP detach failed"),
    });
    const guard = await installPageNavigationGuard(
      page as unknown as Page,
      deniedPageOptions([], false),
    );

    await expect(guard.dispose()).rejects.toThrow("CDP detach failed");
  });

  it("issue #64 does not discard page-guard disposal failure at the host scope", async () => {
    const boundary = createHostBoundary({
      detach: new Error("CDP detach failed"),
    });
    const guard = await installHostOriginScopeGuard(
      "http://browser.test",
      policy,
      async () => boundary.browser,
    );

    await expect(guard.dispose()).rejects.toThrow("CDP detach failed");
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.page.isClosed()).toBe(true);
  });

  it("issue #64 preserves an existing-tab cleanup failure with typed denial", async () => {
    const pageClose = new Error("Existing denied page close failed");
    const boundary = createHostBoundary(
      { pageClose },
      "https://outside.example.test/",
    );

    await expect(
      installHostOriginScopeGuard(
        "http://browser.test",
        policy,
        async () => boundary.browser,
      ),
    ).rejects.toMatchObject({
      origin: "https://outside.example.test",
      cause: pageClose,
    });
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.page.isClosed()).toBe(true);
  });
});
