import type { CDPSession, Page } from "playwright";

type FrameNavigationEvent = {
  frameId: string;
  url: string;
};

type FrameCommitEvent = {
  frame: {
    id: string;
    url: string;
  };
};

type WindowOpenEvent = {
  url: string;
};

export type PageNavigationGuard = {
  dispose(): Promise<void>;
};

type NavigationDenial = Error | null;

type PageNavigationGuardOptions = {
  classify: (address: string) => NavigationDenial;
  closeDeniedPage: (address: string) => boolean;
  recordDenial: (denial: Error) => void;
};

function trackOperation(
  operations: Set<Promise<void>>,
  failures: unknown[],
  operation: Promise<void>,
) {
  operations.add(operation);
  void operation.then(
    () => operations.delete(operation),
    (error: unknown) => {
      operations.delete(operation);
      failures.push(error);
    },
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

async function closePage(page: Page, session: CDPSession) {
  if (page.isClosed()) return;
  const failures: unknown[] = [];
  try {
    // Send close first. Chromium can otherwise commit a non-web document while
    // a stop or replacement navigation is still in flight.
    await session.send("Page.close");
  } catch (error) {
    failures.push(error);
  }
  if (page.isClosed()) return;
  try {
    await session.send("Page.stopLoading");
  } catch (error) {
    failures.push(error);
  }
  if (page.isClosed()) return;
  try {
    await page.close();
  } catch (error) {
    failures.push(error);
  }
  if (page.isClosed()) return;
  throw cleanupFailure(
    "Denied Browser Tab cleanup failed.",
    failures.length === 0
      ? [new Error("Denied Browser Tab remained open after cleanup.")]
      : failures,
  );
}

async function stopNavigation(page: Page, session: CDPSession) {
  let stopFailure: unknown;
  try {
    await session.send("Page.stopLoading");
  } catch (error) {
    stopFailure = error;
  }
  if (page.isClosed() || stopFailure === undefined) return;
  try {
    await page.close();
  } catch (error) {
    throw cleanupFailure("Denied Browser navigation cleanup failed.", [
      stopFailure,
      error,
    ]);
  }
  if (!page.isClosed()) {
    throw cleanupFailure("Denied Browser navigation cleanup failed.", [
      stopFailure,
      new Error("Denied Browser Tab remained open after cleanup."),
    ]);
  }
}

export async function installPageNavigationGuard(
  page: Page,
  options: PageNavigationGuardOptions,
): Promise<PageNavigationGuard> {
  const session = await page.context().newCDPSession(page);
  const operations = new Set<Promise<void>>();
  const cleanupFailures: unknown[] = [];
  let deniedPageCleanupStarted = false;

  const deny = (event: FrameNavigationEvent) => {
    const denial = options.classify(event.url);
    if (denial === null) return;
    options.recordDenial(denial);
    if (deniedPageCleanupStarted) return;
    deniedPageCleanupStarted = true;
    const cleanup = options.closeDeniedPage(event.url)
      ? closePage(page, session)
      : stopNavigation(page, session);
    trackOperation(operations, cleanupFailures, cleanup);
  };
  const onFrameStarted = (event: FrameNavigationEvent) => deny(event);
  const onFrameRequested = (event: FrameNavigationEvent) => deny(event);
  const onFrameScheduled = (event: FrameNavigationEvent) => deny(event);
  const onWindowOpen = (event: WindowOpenEvent) => {
    const denial = options.classify(event.url);
    if (denial === null) return;
    options.recordDenial(denial);
    // The event is emitted on the opener. The route and popup page lifecycle
    // own target cleanup; closing this page would discard the owner tab.
  };
  const onFrameCommitted = (event: FrameCommitEvent) => {
    const denial = options.classify(event.frame.url);
    if (denial === null) return;
    options.recordDenial(denial);
    if (page.isClosed()) return;
    if (deniedPageCleanupStarted) {
      trackOperation(operations, cleanupFailures, closePage(page, session));
      return;
    }
    deniedPageCleanupStarted = true;
    trackOperation(operations, cleanupFailures, closePage(page, session));
  };

  session.on("Page.frameStartedNavigating", onFrameStarted);
  session.on("Page.frameRequestedNavigation", onFrameRequested);
  session.on("Page.frameScheduledNavigation", onFrameScheduled);
  session.on("Page.frameNavigated", onFrameCommitted);
  session.on("Page.windowOpen", onWindowOpen);
  try {
    await session.send("Page.enable");
  } catch (error) {
    session.off("Page.frameStartedNavigating", onFrameStarted);
    session.off("Page.frameRequestedNavigation", onFrameRequested);
    session.off("Page.frameScheduledNavigation", onFrameScheduled);
    session.off("Page.frameNavigated", onFrameCommitted);
    session.off("Page.windowOpen", onWindowOpen);
    try {
      await session.detach();
    } catch (detachError) {
      throw new AggregateError(
        [error, detachError],
        "Origin Scope page guard setup failed.",
        { cause: detachError },
      );
    }
    throw error;
  }

  return {
    dispose: async () => {
      session.off("Page.frameStartedNavigating", onFrameStarted);
      session.off("Page.frameRequestedNavigation", onFrameRequested);
      session.off("Page.frameScheduledNavigation", onFrameScheduled);
      session.off("Page.frameNavigated", onFrameCommitted);
      session.off("Page.windowOpen", onWindowOpen);
      await Promise.allSettled([...operations]);
      try {
        await session.detach();
      } catch (error) {
        if (!page.isClosed()) cleanupFailures.push(error);
      }
      if (cleanupFailures.length > 0) {
        throw cleanupFailure(
          "Origin Scope page guard cleanup failed.",
          cleanupFailures,
        );
      }
    },
  };
}
