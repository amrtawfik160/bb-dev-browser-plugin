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
  operation: Promise<void>,
) {
  operations.add(operation);
  void operation.then(
    () => operations.delete(operation),
    () => operations.delete(operation),
  );
}

async function closePage(page: Page, session: CDPSession) {
  if (page.isClosed()) return;
  // Send close first. Chromium can otherwise commit a non-web document while
  // a stop or replacement navigation is still in flight.
  const closeAttempt = await Promise.allSettled([session.send("Page.close")]);
  if (closeAttempt[0]?.status === "fulfilled" || page.isClosed()) return;
  await Promise.allSettled([session.send("Page.stopLoading")]);
  if (!page.isClosed()) {
    await Promise.allSettled([page.close()]);
  }
}

async function stopNavigation(page: Page, session: CDPSession) {
  const stopping = session.send("Page.stopLoading");
  const result = await Promise.allSettled([stopping]);
  if (result[0]?.status === "rejected" && !page.isClosed()) {
    await Promise.allSettled([page.close()]);
  }
}

export async function installPageNavigationGuard(
  page: Page,
  options: PageNavigationGuardOptions,
): Promise<PageNavigationGuard> {
  const session = await page.context().newCDPSession(page);
  const operations = new Set<Promise<void>>();
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
    trackOperation(operations, cleanup);
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
      trackOperation(operations, closePage(page, session));
      return;
    }
    deniedPageCleanupStarted = true;
    trackOperation(operations, closePage(page, session));
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
    await Promise.allSettled([session.detach()]);
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
      await Promise.allSettled([session.detach()]);
    },
  };
}
