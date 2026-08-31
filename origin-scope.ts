import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page, Request, Route } from "playwright";
import {
  matcherPermitsOrigin,
  type OriginScopeMatcher,
} from "./authorization.js";
import {
  installPageNavigationGuard,
  type PageNavigationGuard,
} from "./origin-scope-cdp.js";

export type BrowserOriginScopePolicy = {
  matcher: OriginScopeMatcher;
  invalidCertificateOrigins: readonly string[];
  timeoutMs: number;
};

export type HostOriginScopeGuard = {
  deniedError(): BrowserOriginScopeDeniedError | null;
  deniedOrigin(): string | null;
  dispose(): Promise<void>;
};

export type ConnectOriginScopeBrowser = (
  endpoint: string,
  timeoutMs: number,
) => Promise<Browser>;

// Playwright emits context/page creation on private channel proxies rather than
// the public BrowserContext event surface. This narrow adapter is pinned to
// Playwright's channel object and its _object back-reference.
type BrowserContextChannelEvent = {
  context: { _object?: BrowserContext };
};

type BrowserPageChannelEvent = {
  page: { _object?: Page };
};

type BrowserChannelEmitter = {
  prependListener(
    event: "context",
    listener: (event: BrowserContextChannelEvent) => void | Promise<void>,
  ): void;
  off(
    event: "context",
    listener: (event: BrowserContextChannelEvent) => void,
  ): void;
};

type BrowserContextChannelEmitter = {
  prependListener(
    event: "page",
    listener: (event: BrowserPageChannelEvent) => void | Promise<void>,
  ): void;
  off(
    event: "page",
    listener: (event: BrowserPageChannelEvent) => void | Promise<void>,
  ): void;
};

type RouteRegistration = {
  context: BrowserContext;
  handler: (route: Route) => Promise<void>;
  pending: Set<Promise<void>>;
};

type PageRegistration = {
  page: Page;
  guard: PageNavigationGuard;
};

const ORIGIN_SCOPE_ROUTE_PATTERN = "**/*";
const requireFromPlugin = createRequire(import.meta.url);

export class BrowserOriginScopeDeniedError extends Error {
  constructor(public readonly origin: string | null) {
    super(
      origin === null
        ? "Browser navigation to a non-web URL was denied by the active Profile Grant."
        : `Browser navigation to ${origin} was denied by the active Profile Grant.`,
    );
    this.name = "BrowserOriginScopeDeniedError";
  }
}

export function preferOriginScopeDenial<T>(
  guard: HostOriginScopeGuard | null,
  fallback: T,
): BrowserOriginScopeDeniedError | T {
  return guard?.deniedError() ?? fallback;
}

type NavigationClassification =
  | { kind: "web"; origin: string; protocol: "http:" | "https:" | "blob:" }
  | { kind: "safe-internal" }
  | { kind: "non-web" };

/**
 * Classify document navigations before matching a web Origin Scope. Exact
 * about:blank is the only internal page that does not carry host browsing
 * data; every other non-web location is denied, while blob URLs inherit an
 * exposed HTTP(S) origin.
 */
function classifyNavigation(address: string): NavigationClassification {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { kind: "non-web" };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { kind: "web", origin: url.origin, protocol: url.protocol };
  }
  if (url.protocol === "blob:" && isWebOrigin(url.origin)) {
    return { kind: "web", origin: url.origin, protocol: url.protocol };
  }
  if (url.href === "about:blank") return { kind: "safe-internal" };
  return { kind: "non-web" };
}

function isWebOrigin(origin: string): boolean {
  return origin.startsWith("http://") || origin.startsWith("https://");
}

function webOrigin(address: string): string | null {
  const classification = classifyNavigation(address);
  return classification.kind === "web" ? classification.origin : null;
}

function deniedExistingPages(
  contexts: readonly BrowserContext[],
  matcher: OriginScopeMatcher,
): { denial: BrowserOriginScopeDeniedError; page: Page }[] {
  const denied: { denial: BrowserOriginScopeDeniedError; page: Page }[] = [];
  for (const context of contexts) {
    for (const page of context.pages()) {
      const classification = classifyNavigation(page.url());
      if (
        classification.kind === "non-web" ||
        (classification.kind === "web" &&
          !matcherPermitsOrigin(matcher, classification.origin))
      ) {
        denied.push({
          denial: new BrowserOriginScopeDeniedError(
            classification.kind === "web" ? classification.origin : null,
          ),
          page,
        });
      }
    }
  }
  return denied;
}

async function closeDeniedExistingPages(denied: readonly { page: Page }[]) {
  const results = await Promise.allSettled(
    denied.map(({ page }) => page.close()),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) {
    throw new Error("An out-of-scope Browser Tab could not be closed.", {
      cause: failure.reason,
    });
  }
}

export function originRequiresCertificateBypass(
  origin: string,
  invalidCertificateOrigins: readonly string[],
): boolean {
  const normalized = webOrigin(origin);
  return normalized !== null && invalidCertificateOrigins.includes(normalized);
}

async function closeDeniedPopup(request: Request) {
  let page: Page;
  try {
    page = request.frame().page();
  } catch {
    // Chromium can issue a popup's first navigation before Playwright creates
    // its Frame object. The route is already aborted; the CDP window-open
    // guard owns cleanup for non-web popups, so there is no page to close here.
    return;
  }
  if ((await page.opener()) !== null && !page.isClosed()) await page.close();
}

async function denyNavigation(
  route: Route,
  request: Request,
  denial: BrowserOriginScopeDeniedError,
  recordDenial: (denial: BrowserOriginScopeDeniedError) => void,
) {
  recordDenial(denial);
  await route.abort("blockedbyclient");
  await closeDeniedPopup(request);
}

async function fulfillCertificateBypass(
  route: Route,
  request: Request,
  context: BrowserContext,
  timeoutMs: number,
) {
  const response = await context.request.fetch(request, {
    ignoreHTTPSErrors: true,
    maxRedirects: 0,
    timeout: timeoutMs,
  });
  await route.fulfill({ response });
}

function originScopeRouteHandler(
  context: BrowserContext,
  policy: BrowserOriginScopePolicy,
  recordDenial: (denial: BrowserOriginScopeDeniedError) => void,
) {
  return async (route: Route) => {
    const request = route.request();
    const classification = request.isNavigationRequest()
      ? classifyNavigation(request.url())
      : null;
    if (classification === null || classification.kind === "safe-internal") {
      await route.continue();
    } else if (classification.kind === "non-web") {
      await denyNavigation(
        route,
        request,
        new BrowserOriginScopeDeniedError(null),
        recordDenial,
      );
    } else if (!matcherPermitsOrigin(policy.matcher, classification.origin)) {
      await denyNavigation(
        route,
        request,
        new BrowserOriginScopeDeniedError(classification.origin),
        recordDenial,
      );
    } else if (
      originRequiresCertificateBypass(
        classification.origin,
        policy.invalidCertificateOrigins,
      )
    ) {
      await fulfillCertificateBypass(route, request, context, policy.timeoutMs);
    } else {
      await route.continue();
    }
  };
}

function navigationDenial(
  address: string,
  policy: BrowserOriginScopePolicy,
): BrowserOriginScopeDeniedError | null {
  const classification = classifyNavigation(address);
  if (classification.kind === "safe-internal") return null;
  if (classification.kind === "non-web") {
    return new BrowserOriginScopeDeniedError(null);
  }
  return matcherPermitsOrigin(policy.matcher, classification.origin)
    ? null
    : new BrowserOriginScopeDeniedError(classification.origin);
}

function shouldCloseDeniedPage(address: string): boolean {
  const classification = classifyNavigation(address);
  return (
    classification.kind === "non-web" ||
    (classification.kind === "web" && classification.protocol === "blob:")
  );
}

function contextChannel(
  context: BrowserContext,
): BrowserContextChannelEmitter | null {
  const channel = (
    context as unknown as { _channel?: BrowserContextChannelEmitter }
  )._channel;
  return channel ?? null;
}

async function connectOriginScopeBrowser(endpoint: string, timeoutMs: number) {
  // Keep Playwright at the host runtime boundary. Bundling its server internals
  // pulls optional BiDi modules that a CDP-only attachment never executes.
  const playwright = requireFromPlugin("playwright") as {
    chromium: {
      connectOverCDP(
        endpoint: string,
        options: { timeout: number },
      ): Promise<Browser>;
    };
  };
  return playwright.chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
}

async function removeRoutes(registrations: readonly RouteRegistration[]) {
  await Promise.all(
    registrations.map(({ context, handler }) =>
      context.unroute(ORIGIN_SCOPE_ROUTE_PATTERN, handler),
    ),
  );
}

async function settlePendingRoutes(
  registrations: readonly RouteRegistration[],
) {
  // Handler errors already reach the navigation that initiated them. Cleanup
  // only needs to wait until every page-close or fulfil action has settled.
  await Promise.allSettled(
    registrations.flatMap(({ pending }) => [...pending]),
  );
}

async function settlePendingInstallations(installations: Set<Promise<void>>) {
  while (installations.size > 0) {
    await Promise.allSettled([...installations]);
  }
}

function routeRegistration(
  context: BrowserContext,
  handler: (route: Route) => Promise<void>,
): RouteRegistration {
  const pending = new Set<Promise<void>>();
  const trackedHandler = (route: Route) => {
    const execution = handler(route);
    pending.add(execution);
    void execution.then(
      () => pending.delete(execution),
      () => pending.delete(execution),
    );
    return execution;
  };
  return { context, handler: trackedHandler, pending };
}

async function installRoutes(registrations: readonly RouteRegistration[]) {
  await Promise.all(
    registrations.map(({ context, handler }) =>
      context.route(ORIGIN_SCOPE_ROUTE_PATTERN, handler),
    ),
  );
}

export async function installHostOriginScopeGuard(
  endpoint: string,
  policy: BrowserOriginScopePolicy,
  connect: ConnectOriginScopeBrowser = connectOriginScopeBrowser,
): Promise<HostOriginScopeGuard> {
  const browser = await connect(endpoint, policy.timeoutMs);
  let denial: BrowserOriginScopeDeniedError | null = null;
  const registrations: RouteRegistration[] = [];
  const registeredContexts = new Set<BrowserContext>();
  const pendingContextInstallations = new Set<Promise<void>>();
  const pageRegistrations: PageRegistration[] = [];
  const registeredPages = new Set<Page>();
  const pendingPageInstallations = new Set<Promise<void>>();
  const pageObservers = new Map<
    BrowserContext,
    (event: BrowserPageChannelEvent) => void | Promise<void>
  >();
  const recordDenial = (candidate: BrowserOriginScopeDeniedError) => {
    denial ??= candidate;
  };
  const recordPageDenial = (candidate: Error) => {
    if (candidate instanceof BrowserOriginScopeDeniedError) {
      recordDenial(candidate);
    } else {
      recordDenial(new BrowserOriginScopeDeniedError(null));
    }
  };
  const trackPageInstallation = (installation: Promise<void>) => {
    pendingPageInstallations.add(installation);
    void installation.then(
      () => pendingPageInstallations.delete(installation),
      () => {
        pendingPageInstallations.delete(installation);
        denial ??= new BrowserOriginScopeDeniedError(null);
        void browser.close().catch(() => undefined);
      },
    );
    return installation;
  };
  const installPage = async (context: BrowserContext, page: Page) => {
    if (
      registeredPages.has(page) ||
      page.isClosed() ||
      typeof (context as unknown as { newCDPSession?: unknown })
        .newCDPSession !== "function"
    ) {
      return;
    }
    registeredPages.add(page);
    try {
      const guard = await installPageNavigationGuard(page, {
        classify: (address) => navigationDenial(address, policy),
        closeDeniedPage: shouldCloseDeniedPage,
        recordDenial: recordPageDenial,
      });
      pageRegistrations.push({ page, guard });
    } catch (error) {
      registeredPages.delete(page);
      throw error;
    }
  };
  const installContext = async (context: BrowserContext) => {
    if (registeredContexts.has(context)) return;
    registeredContexts.add(context);
    const pageChannel = contextChannel(context);
    if (pageChannel !== null) {
      const observePage = (event: BrowserPageChannelEvent) => {
        const page = event.page._object;
        if (page === undefined) {
          denial ??= new BrowserOriginScopeDeniedError(null);
          void browser.close().catch(() => undefined);
          return;
        }
        trackPageInstallation(installPage(context, page));
      };
      pageObservers.set(context, observePage);
      pageChannel.prependListener("page", observePage);
    }
    const registration = routeRegistration(
      context,
      originScopeRouteHandler(context, policy, recordDenial),
    );
    registrations.push(registration);
    const pageInstallations = context
      .pages()
      .map((page) => trackPageInstallation(installPage(context, page)));
    await Promise.all([installRoutes([registration]), ...pageInstallations]);
    const existingDenials = deniedExistingPages([context], policy.matcher);
    if (existingDenials.length > 0) {
      recordDenial(existingDenials[0].denial);
      await closeDeniedExistingPages(existingDenials);
    }
  };
  const observeContext = (context: BrowserContext) => {
    const installation = installContext(context);
    pendingContextInstallations.add(installation);
    return installation.then(
      () => pendingContextInstallations.delete(installation),
      () => {
        denial ??= new BrowserOriginScopeDeniedError(null);
        pendingContextInstallations.delete(installation);
        void browser.close().catch(() => undefined);
      },
    );
  };
  const contextEmitter = (
    browser as unknown as { _channel: BrowserChannelEmitter }
  )._channel;
  const observeBrowserContext = async (event: BrowserContextChannelEvent) => {
    const context = event.context._object;
    if (context === undefined) {
      denial ??= new BrowserOriginScopeDeniedError(null);
      void browser.close().catch(() => undefined);
      return;
    }
    await observeContext(context);
  };
  try {
    contextEmitter.prependListener("context", observeBrowserContext);
    const contexts = browser.contexts();
    await Promise.all(contexts.map((context) => installContext(context)));
    await settlePendingInstallations(pendingContextInstallations);
    await settlePendingInstallations(pendingPageInstallations);
    if (denial !== null) throw denial;
  } catch (error) {
    contextEmitter.off("context", observeBrowserContext);
    for (const [context, observer] of pageObservers) {
      contextChannel(context)?.off("page", observer);
    }
    await settlePendingInstallations(pendingContextInstallations);
    await settlePendingInstallations(pendingPageInstallations);
    await Promise.allSettled(
      pageRegistrations.map(({ guard }) => guard.dispose()),
    );
    await settlePendingRoutes(registrations);
    await browser.close();
    throw error;
  }
  return {
    deniedError: () => denial,
    deniedOrigin: () => denial?.origin ?? null,
    dispose: async () => {
      try {
        contextEmitter.off("context", observeBrowserContext);
        for (const [context, observer] of pageObservers) {
          contextChannel(context)?.off("page", observer);
        }
        await settlePendingInstallations(pendingContextInstallations);
        await settlePendingInstallations(pendingPageInstallations);
        await Promise.allSettled(
          pageRegistrations.map(({ guard }) => guard.dispose()),
        );
        try {
          await removeRoutes(registrations);
        } finally {
          await settlePendingRoutes(registrations);
        }
      } finally {
        await browser.close();
      }
    },
  };
}
