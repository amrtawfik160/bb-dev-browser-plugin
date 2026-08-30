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
  deniedOrigin(): string | null;
  dispose(): Promise<void>;
};

export type ConnectOriginScopeBrowser = (
  endpoint: string,
  timeoutMs: number,
) => Promise<Browser>;

type RouteRegistration = {
  context: BrowserContext;
  handler: (route: Route) => Promise<void>;
  pending: Set<Promise<void>>;
};

const ORIGIN_SCOPE_ROUTE_PATTERN = "**/*";
const requireFromPlugin = createRequire(import.meta.url);

export class BrowserOriginScopeDeniedError extends Error {
  constructor(public readonly origin: string) {
    super(
      `Browser navigation to ${origin} was denied by the active Profile Grant.`,
    );
    this.name = "BrowserOriginScopeDeniedError";
  }
}

export function preferOriginScopeDenial<T>(
  guard: HostOriginScopeGuard | null,
  fallback: T,
): BrowserOriginScopeDeniedError | T {
  const deniedOrigin = guard?.deniedOrigin();
  return deniedOrigin === undefined || deniedOrigin === null
    ? fallback
    : new BrowserOriginScopeDeniedError(deniedOrigin);
}

function webOrigin(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.origin
    : null;
}

function deniedExistingPages(
  contexts: readonly BrowserContext[],
  matcher: OriginScopeMatcher,
): { origin: string; page: Page }[] {
  const denied: { origin: string; page: Page }[] = [];
  for (const context of contexts) {
    for (const page of context.pages()) {
      const origin = webOrigin(page.url());
      if (origin !== null && !matcherPermitsOrigin(matcher, origin)) {
        denied.push({ origin, page });
      }
    }
  }
  return denied;
}

async function closeDeniedExistingPages(
  denied: readonly { origin: string; page: Page }[],
) {
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
  origin: string,
  recordDenial: (origin: string) => void,
) {
  recordDenial(origin);
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
  recordDenial: (origin: string) => void,
) {
  return async (route: Route) => {
    const request = route.request();
    const origin = request.isNavigationRequest()
      ? webOrigin(request.url())
      : null;
    if (origin === null) {
      await route.continue();
    } else if (!matcherPermitsOrigin(policy.matcher, origin)) {
      await denyNavigation(route, request, origin, recordDenial);
    } else if (
      originRequiresCertificateBypass(origin, policy.invalidCertificateOrigins)
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
  const contexts = browser.contexts();
  let deniedOrigin: string | null = null;
  const registrations = contexts.map((context) =>
    routeRegistration(
      context,
      originScopeRouteHandler(context, policy, (origin) => {
        deniedOrigin ??= origin;
      }),
    ),
  );
  try {
    await installRoutes(registrations);
    const existingDenials = deniedExistingPages(contexts, policy.matcher);
    const installationDenial = deniedOrigin ?? existingDenials[0]?.origin;
    if (installationDenial !== undefined && installationDenial !== null) {
      await closeDeniedExistingPages(existingDenials);
      throw new BrowserOriginScopeDeniedError(installationDenial);
    }
  } catch (error) {
    await settlePendingRoutes(registrations);
    await browser.close();
    throw error;
  }
  return {
    deniedOrigin: () => deniedOrigin,
    dispose: async () => {
      try {
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
