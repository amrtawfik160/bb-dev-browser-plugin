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

const IDLE_CHROME_HOSTS = new Set([
  "newtab",
  "new-tab-page",
  "new-tab-page-third-party",
]);

function isIdleInternalDocument(url: URL): boolean {
  if (url.protocol === "chrome:" && IDLE_CHROME_HOSTS.has(url.hostname)) {
    return true;
  }
  if (url.protocol === "chrome-untrusted:" && url.hostname === "new-tab-page") {
    return true;
  }
  return url.protocol === "chrome-error:" && url.hostname === "chromewebdata";
}

/**
 * Classify document navigations before matching a web Origin Scope. Exact
 * about:blank is the only safe internal document. Restored Chrome new-tab and
 * error pages are cleared before installing this guard because they can expose
 * profile history. Blob URLs inherit an exposed HTTP(S) origin.
 */
function classifyNavigation(address: string): NavigationClassification {
  if (typeof address !== "string" || address.length === 0) {
    return { kind: "safe-internal" };
  }
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
): Page[] {
  const denied: Page[] = [];
  for (const context of contexts) {
    for (const page of context.pages()) {
      const address = page.url();
      if (address.length === 0) continue;
      const classification = classifyNavigation(address);
      if (
        classification.kind === "non-web" ||
        (classification.kind === "web" &&
          !matcherPermitsOrigin(matcher, classification.origin))
      ) {
        denied.push(page);
      }
    }
  }
  return denied;
}

type ParkedPage = { page: Page; url: string };

const PARKED_PAGE_RESTORE_TIMEOUT_MS = 5_000;

/**
 * Put an owner tab that is outside the agent's Origin Scope beyond the agent's
 * reach for the length of the call without discarding it. The tab is parked on
 * exact `about:blank`, the one safe internal document, and brought back when
 * the guard is disposed. Closing these tabs instead, as the guard once did,
 * meant every agent call under an exact-origin grant threw away whatever else
 * the owner had open and left the shared strip pointing at pages that no
 * longer existed. A tab that refuses to park (a beforeunload prompt, a hung
 * renderer) is still closed so the call never starts with an out-of-scope
 * document readable.
 */
async function parkDeniedExistingPages(
  denied: readonly Page[],
  timeoutMs: number,
  parked: ParkedPage[],
): Promise<{ failures: unknown[]; deniedOrigin: string | null }> {
  const results = await Promise.allSettled(
    denied.map(async (page) => {
      const url = page.url();
      try {
        await page.goto("about:blank", { timeout: timeoutMs });
      } catch {
        await page.close();
        return;
      }
      if (page.isClosed()) return;
      if (page.url() !== "about:blank") {
        await page.close();
        return;
      }
      parked.push({ page, url });
    }),
  );
  const failures: unknown[] = [];
  let deniedOrigin: string | null = null;
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    failures.push(result.reason);
    deniedOrigin ??= webOrigin(denied[index]!.url());
  });
  return { failures, deniedOrigin };
}

/**
 * Bring parked owner tabs back once the routes and page guards are gone. A tab
 * the agent navigated during the call is left where the agent put it, exactly
 * as a shared active tab would be. Restoration is best effort: a tab that
 * cannot return keeps its history, so the owner's Back button still works.
 */
async function restoreParkedPages(parked: readonly ParkedPage[]) {
  await Promise.allSettled(
    parked.map(async ({ page, url }) => {
      if (page.isClosed() || page.url() !== "about:blank") return;
      await page.goBack({
        timeout: PARKED_PAGE_RESTORE_TIMEOUT_MS,
        waitUntil: "commit",
      });
      if (!page.isClosed() && page.url() === "about:blank") {
        await page.goto(url, {
          timeout: PARKED_PAGE_RESTORE_TIMEOUT_MS,
          waitUntil: "commit",
        });
      }
    }),
  );
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
  const parkedPages: ParkedPage[] = [];
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
        if (page === undefined) return;
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
      const outcome = await parkDeniedExistingPages(
        existingDenials,
        policy.timeoutMs,
        parkedPages,
      );
      if (outcome.failures.length > 0) {
        // An out-of-scope document is still readable, so the call must not
        // proceed: surface a typed denial whose cause retires the instance.
        recordDenial(new BrowserOriginScopeDeniedError(outcome.deniedOrigin));
        throw cleanupFailure(
          "An out-of-scope Browser Tab could not be parked or closed.",
          outcome.failures,
        );
      }
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
    if (context === undefined) return;
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
    // Routes and page guards are gone, so bringing the owner's tabs back is an
    // ordinary navigation again rather than a denied one.
    await restoreParkedPages(parkedPages.splice(0));
    cleanupFailures.push(...(await collectBrowserCloseFailures()));
    return cleanupFailures;
  };
  try {
    contextEmitter.prependListener("context", observeBrowserContext);
    const contexts = browser.contexts();
    await Promise.all(
      contexts
        .flatMap((context) => context.pages())
        .map(async (page) => {
          let address: URL;
          try {
            address = new URL(page.url());
          } catch {
            return;
          }
          if (isIdleInternalDocument(address)) {
            await page.goto("about:blank", { timeout: policy.timeoutMs });
          }
        }),
    );
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
