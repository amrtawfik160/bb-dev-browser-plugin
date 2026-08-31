import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page, Request, Route } from "playwright";
import {
  matcherPermitsOrigin,
  type OriginScopeMatcher,
} from "./authorization.js";

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

// Playwright emits Browser context creation on Browser._channel rather than
// the public Browser event surface. The channel proxy exposes the object via
// its _object back-reference.
type BrowserContextChannelEvent = {
  context: { _object?: BrowserContext };
};

type BrowserContextChannelEmitter = {
  on(
    event: "context",
    listener: (event: BrowserContextChannelEvent) => void,
  ): void;
  off(
    event: "context",
    listener: (event: BrowserContextChannelEvent) => void,
  ): void;
};

type RouteRegistration = {
  context: BrowserContext;
  handler: (route: Route) => Promise<void>;
  pending: Set<Promise<void>>;
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
  | { kind: "web"; origin: string }
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
    return { kind: "web", origin: url.origin };
  }
  if (url.protocol === "blob:" && isWebOrigin(url.origin)) {
    return { kind: "web", origin: url.origin };
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
  const page = request.frame().page();
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

async function settlePendingContextInstallations(
  installations: Set<Promise<void>>,
) {
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
  const recordDenial = (candidate: BrowserOriginScopeDeniedError) => {
    denial ??= candidate;
  };
  const installContext = async (context: BrowserContext) => {
    if (registeredContexts.has(context)) return;
    registeredContexts.add(context);
    const registration = routeRegistration(
      context,
      originScopeRouteHandler(context, policy, recordDenial),
    );
    registrations.push(registration);
    await installRoutes([registration]);
    const existingDenials = deniedExistingPages([context], policy.matcher);
    if (existingDenials.length > 0) {
      recordDenial(existingDenials[0].denial);
      await closeDeniedExistingPages(existingDenials);
    }
  };
  const observeContext = (context: BrowserContext) => {
    const installation = installContext(context);
    pendingContextInstallations.add(installation);
    void installation.then(
      () => pendingContextInstallations.delete(installation),
      () => {
        denial ??= new BrowserOriginScopeDeniedError(null);
        pendingContextInstallations.delete(installation);
        void browser.close().catch(() => undefined);
      },
    );
  };
  const contextEmitter = (
    browser as unknown as { _channel: BrowserContextChannelEmitter }
  )._channel;
  const observeBrowserContext = (event: BrowserContextChannelEvent) => {
    const context = event.context._object;
    if (context === undefined) {
      denial ??= new BrowserOriginScopeDeniedError(null);
      void browser.close().catch(() => undefined);
      return;
    }
    observeContext(context);
  };
  try {
    contextEmitter.on("context", observeBrowserContext);
    const contexts = browser.contexts();
    await Promise.all(contexts.map((context) => installContext(context)));
    await settlePendingContextInstallations(pendingContextInstallations);
    if (denial !== null) throw denial;
  } catch (error) {
    contextEmitter.off("context", observeBrowserContext);
    await settlePendingContextInstallations(pendingContextInstallations);
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
        await settlePendingContextInstallations(pendingContextInstallations);
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
