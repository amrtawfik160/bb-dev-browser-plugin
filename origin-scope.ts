import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Request, Route } from "playwright";
import {
  matcherPermitsOrigin,
  type OriginScopeMatcher,
} from "./authorization.js";
import {
  installPageNavigationGuard,
  type PageNavigationGuard,
} from "./origin-scope-cdp.js";
import {
  requirePlaywrightRuntime,
  type ResolvePlaywrightRuntimeOptions,
} from "./playwright-runtime.js";

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
  failures: unknown[];
};

type PageRegistration = {
  page: Page;
  guard: PageNavigationGuard;
};

const ORIGIN_SCOPE_ROUTE_PATTERN = "**/*";

export class BrowserOriginScopeDeniedError extends Error {
  constructor(
    public readonly origin: string | null,
    options?: ErrorOptions,
  ) {
    super(
      origin === null
        ? "Browser navigation to a non-web URL was denied by the active Profile Grant."
        : `Browser navigation to ${origin} was denied by the active Profile Grant.`,
      options,
    );
    this.name = "BrowserOriginScopeDeniedError";
  }
}

function rejectedReasons(
  results: readonly PromiseSettledResult<unknown>[],
): unknown[] {
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
}

function cleanupFailure(message: string, failures: readonly unknown[]) {
  const causes = failures.flatMap((failure) =>
    failure instanceof AggregateError ? [...failure.errors] : [failure],
  );
  if (causes.length === 1) {
    const [cause] = causes;
    return cause instanceof Error ? cause : new Error(message, { cause });
  }
  return new AggregateError(causes, message);
}

function preservePrimaryFailure(primary: unknown, cleanup: Error) {
  if (primary instanceof BrowserOriginScopeDeniedError) {
    const cause =
      primary.cause === undefined
        ? cleanup
        : new AggregateError(
            [primary.cause, cleanup],
            "Origin Scope setup and cleanup failed.",
          );
    return new BrowserOriginScopeDeniedError(primary.origin, {
      cause,
    });
  }
  return cleanupFailure("Origin Scope setup and cleanup failed.", [
    primary,
    cleanup,
  ]);
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
  const failures = rejectedReasons(results);
  if (failures.length > 0) {
    throw cleanupFailure(
      "An out-of-scope Browser Tab could not be closed.",
      failures,
    );
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

async function connectOriginScopeBrowser(
  endpoint: string,
  timeoutMs: number,
  playwright?: ResolvePlaywrightRuntimeOptions,
) {
  // Keep Playwright at the host runtime boundary. Bundling its server internals
  // pulls optional BiDi modules that a CDP-only attachment never executes.
  // Isolated host artifacts have no node_modules beside host.mjs.
  const { packageDirectory } = requirePlaywrightRuntime(playwright);
  const requireFromPlugin = createRequire(
    join(packageDirectory, "package.json"),
  );
  const loaded = requireFromPlugin("playwright") as {
    chromium: {
      connectOverCDP(
        endpoint: string,
        options: { timeout: number },
      ): Promise<Browser>;
    };
  };
  return loaded.chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
}

async function removeRoutes(registrations: readonly RouteRegistration[]) {
  return rejectedReasons(
    await Promise.allSettled(
      registrations.map(({ context, handler }) =>
        context.unroute(ORIGIN_SCOPE_ROUTE_PATTERN, handler),
      ),
    ),
  );
}

async function settlePendingRoutes(
  registrations: readonly RouteRegistration[],
) {
  await Promise.allSettled(
    registrations.flatMap(({ pending }) => [...pending]),
  );
  return registrations.flatMap(({ failures }) => failures.splice(0));
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
  const failures: unknown[] = [];
  const trackedHandler = (route: Route) => {
    const execution = handler(route);
    pending.add(execution);
    void execution.then(
      () => pending.delete(execution),
      (error: unknown) => {
        pending.delete(execution);
        failures.push(error);
      },
    );
    return execution;
  };
  return { context, handler: trackedHandler, pending, failures };
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
  connect?: ConnectOriginScopeBrowser,
  playwright?: ResolvePlaywrightRuntimeOptions,
): Promise<HostOriginScopeGuard> {
  const resolvedConnect: ConnectOriginScopeBrowser =
    connect ??
    ((target, timeoutMs) =>
      connectOriginScopeBrowser(target, timeoutMs, playwright));
  const browser = await resolvedConnect(endpoint, policy.timeoutMs);
  let denial: BrowserOriginScopeDeniedError | null = null;
  const registrations: RouteRegistration[] = [];
  const registeredContexts = new Set<BrowserContext>();
  const pendingContextInstallations = new Set<Promise<void>>();
  const pageRegistrations: PageRegistration[] = [];
  const registeredPages = new Set<Page>();
  const pendingPageInstallations = new Set<Promise<void>>();
  const installationFailures: unknown[] = [];
  let browserCloseAttempt: Promise<void> | undefined;
  let browserCloseObserved = false;
  const browserCloseFailures: unknown[] = [];
  const browserClose = () => {
    browserCloseAttempt ??= Promise.resolve().then(() => browser.close());
    return browserCloseAttempt;
  };
  const observeBrowserClose = () => {
    if (browserCloseObserved) return;
    browserCloseObserved = true;
    void browserClose().then(
      () => undefined,
      (error: unknown) => browserCloseFailures.push(error),
    );
  };
  const collectBrowserCloseFailures = async () => {
    observeBrowserClose();
    await Promise.allSettled([browserClose()]);
    return browserCloseFailures.splice(0);
  };
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
  const recordInstallationFailure = (error: unknown) => {
    installationFailures.push(error);
    observeBrowserClose();
  };
  const trackPageInstallation = (installation: Promise<void>) => {
    pendingPageInstallations.add(installation);
    void installation.then(
      () => pendingPageInstallations.delete(installation),
      (error: unknown) => {
        pendingPageInstallations.delete(installation);
        denial ??= new BrowserOriginScopeDeniedError(null);
        recordInstallationFailure(error);
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
          observeBrowserClose();
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
      (error: unknown) => {
        denial ??= new BrowserOriginScopeDeniedError(null);
        pendingContextInstallations.delete(installation);
        recordInstallationFailure(error);
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
      observeBrowserClose();
      return;
    }
    await observeContext(context);
  };
  const disposeResources = async () => {
    const cleanupFailures: unknown[] = installationFailures.splice(0);
    try {
      contextEmitter.off("context", observeBrowserContext);
    } catch (error) {
      cleanupFailures.push(error);
    }
    for (const [context, observer] of pageObservers) {
      try {
        contextChannel(context)?.off("page", observer);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    await settlePendingInstallations(pendingContextInstallations);
    await settlePendingInstallations(pendingPageInstallations);
    cleanupFailures.push(...installationFailures.splice(0));
    cleanupFailures.push(
      ...rejectedReasons(
        await Promise.allSettled(
          pageRegistrations.map(({ guard }) => guard.dispose()),
        ),
      ),
    );
    cleanupFailures.push(...(await removeRoutes(registrations)));
    cleanupFailures.push(...(await settlePendingRoutes(registrations)));
    cleanupFailures.push(...(await collectBrowserCloseFailures()));
    return cleanupFailures;
  };
  try {
    contextEmitter.prependListener("context", observeBrowserContext);
    const contexts = browser.contexts();
    await Promise.all(contexts.map((context) => installContext(context)));
    await settlePendingInstallations(pendingContextInstallations);
    await settlePendingInstallations(pendingPageInstallations);
    const backgroundFailures = installationFailures.splice(0);
    if (denial !== null) {
      if (backgroundFailures.length > 0) {
        throw preservePrimaryFailure(
          denial,
          cleanupFailure(
            "Origin Scope installation failed.",
            backgroundFailures,
          ),
        );
      }
      throw denial;
    }
    if (backgroundFailures.length > 0) {
      throw cleanupFailure(
        "Origin Scope installation failed.",
        backgroundFailures,
      );
    }
  } catch (error) {
    const cleanupFailures = await disposeResources();
    if (denial !== null && error !== denial) cleanupFailures.push(error);
    if (cleanupFailures.length > 0) {
      const primary = denial ?? error;
      throw preservePrimaryFailure(
        primary,
        cleanupFailure("Origin Scope cleanup failed.", cleanupFailures),
      );
    }
    throw denial ?? error;
  }
  return {
    deniedError: () => denial,
    deniedOrigin: () => denial?.origin ?? null,
    dispose: async () => {
      const cleanupFailures = await disposeResources();
      if (cleanupFailures.length > 0) {
        throw cleanupFailure("Origin Scope cleanup failed.", cleanupFailures);
      }
    },
  };
}
