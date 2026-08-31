import { randomUUID } from "node:crypto";

/**
 * Browser Tabs, one active tab, and one Browser Instance belong to a Browser
 * Profile rather than to a BB thread. Every Browser Panel that uses one
 * profile observes the same ordered tab set and the same active tab; popup
 * windows are normalized into that tab set. Runtime-only tab identifiers stay
 * consistent for the life of the instance and are invalidated when the
 * instance restarts, so a stale id from a prior generation fails closed as
 * `tab_invalid` rather than targeting the wrong page.
 *
 * This module is the host-owned shared browser state for one profile. The
 * server-side control state (ADR 0012) subscribes to it so every panel for
 * the profile renders one ordered strip and one active tab regardless of
 * which BB thread or client opened it.
 */
export type BrowserTabOrigin = "page" | "popup";

export type BrowserTab = {
  /** Runtime-only identifier; stable for the life of the instance. */
  tabId: string;
  url: string;
  title: string;
  origin: BrowserTabOrigin;
  /** The tab that opened this popup, if {@link origin} is "popup". */
  openerTabId: string | null;
};

export type BrowserTabStrip = {
  tabs: BrowserTab[];
  activeTabId: string | null;
};

export type BrowserTabStripListener = (strip: BrowserTabStrip) => void;

export type BrowserTabStripOptions = {
  /** Maximum number of tabs retained in the shared strip. */
  maxTabs?: number;
};

export type BrowserTabStripStore = ReturnType<typeof createBrowserTabStrip>;

export const TAB_STRIP_DEFAULT_MAX_TABS = 64;

/**
 * Mint a runtime-only tab identifier. It is opaque and carries no transport
 * address; it is only meaningful within the instance generation that created
 * it.
 */
export function newTabId(): string {
  return `bb-tab-${randomUUID()}`;
}

export function createBrowserTabStrip(options: BrowserTabStripOptions = {}) {
  const maxTabs = Math.max(1, options.maxTabs ?? TAB_STRIP_DEFAULT_MAX_TABS);
  let generation = 0;
  let tabs = new Map<string, BrowserTab>();
  let order: string[] = [];
  let activeTabId: string | null = null;
  let evicted: string[] = [];
  const listeners = new Set<BrowserTabStripListener>();

  function snapshot(): BrowserTabStrip {
    return {
      tabs: order.map((id) => tabs.get(id)!).filter((tab) => tab !== undefined),
      activeTabId,
    };
  }

  function emit() {
    const strip = snapshot();
    for (const listener of listeners) listener(strip);
  }

  /**
   * Drop the oldest tabs past the retention cap and record which real pages
   * they were.
   *
   * Trimming used to forget a tab and leave its page open in the browser, so
   * the cap bounded nothing: the next inventory reported the same page, the
   * strip re-added it, and something else was evicted. Pages accumulated for
   * the life of the profile — and `--restore-last-session` brought them all
   * back on the next launch — with each one holding renderer memory. The
   * caller drains {@link takeEvictedTabIds} and closes those pages, which is
   * what makes the cap a real bound.
   *
   * The active tab is never evicted; the owner is looking at it.
   */
  function trimToMax() {
    while (order.length > maxTabs) {
      const oldest = order.findIndex((id) => id !== activeTabId);
      if (oldest === -1) break;
      const [dropped] = order.splice(oldest, 1);
      tabs.delete(dropped!);
      // One reconcile both adds pages individually and re-syncs the whole
      // inventory, so the same page can be trimmed twice before the caller
      // drains. Report it once.
      if (!evicted.includes(dropped!)) evicted.push(dropped!);
    }
  }

  /**
   * Hand back the pages evicted since the last call, so the caller can close
   * them in the browser. Draining keeps a page from being closed twice.
   */
  function takeEvictedTabIds(): string[] {
    const drained = evicted;
    evicted = [];
    return drained;
  }

  /**
   * Reset the strip for a new Browser Instance generation. Prior runtime tab
   * ids are invalidated; any later use of a stale id fails closed by the
   * runtime as `tab_invalid`. The strip starts empty with no active tab until
   * the runtime reports its pages.
   */
  function resetInstance() {
    generation += 1;
    tabs = new Map();
    order = [];
    activeTabId = null;
    // A new instance owns no pages from the previous one, so pending
    // evictions would name ids that no longer exist.
    evicted = [];
    emit();
  }

  function upsertTab(tab: BrowserTab): BrowserTab {
    const existing = tabs.get(tab.tabId);
    if (existing === undefined) {
      tabs.set(tab.tabId, tab);
      order.push(tab.tabId);
    } else {
      tabs.set(tab.tabId, { ...existing, ...tab });
    }
    if (activeTabId === null) activeTabId = tab.tabId;
    trimToMax();
    emit();
    return tabs.get(tab.tabId)!;
  }

  /**
   * Open a top-level page tab and activate it. Returns the runtime tab id the
   * strip assigned. When the runtime already minted a stable id for the page,
   * pass it so the strip and runtime stay consistent for the life of the
   * instance.
   */
  function openTab(url: string, title = "", tabId?: string): string {
    const id = tabId ?? newTabId();
    upsertTab({ tabId: id, url, title, origin: "page", openerTabId: null });
    activateTab(id);
    return id;
  }

  /**
   * Normalize a popup window into the shared tab strip as a regular tab. The
   * popup carries its opener tab id so the panel can show the relationship,
   * but it participates in the same ordered strip and active-tab selection as
   * every other tab. Returns the runtime tab id the strip assigned.
   */
  function normalizePopup(
    url: string,
    title: string,
    openerTabId: string | null,
    tabId?: string,
  ): string {
    const id = tabId ?? newTabId();
    upsertTab({ tabId: id, url, title, origin: "popup", openerTabId });
    activateTab(id);
    return id;
  }

  /**
   * Sync the strip from a runtime page inventory. Pages not present are
   * dropped; new pages are added (preserving popup origin and opener when the
   * runtime reports them). A supplied active tab is protected while trimming;
   * otherwise the current active tab is preserved when possible, and the last
   * reported page becomes active when no active tab remains. Runtime tab ids
   * are preserved unchanged so they stay consistent for the life of the
   * instance.
   */
  function syncPages(
    pages: ReadonlyArray<{
      id: string;
      url: string;
      title?: string;
      origin?: BrowserTabOrigin;
      openerTabId?: string | null;
    }>,
    preferredActiveTabId?: string,
  ) {
    const next = new Map<string, BrowserTab>();
    const nextOrder: string[] = [];
    for (const page of pages) {
      const prior = tabs.get(page.id);
      const tab: BrowserTab = prior
        ? { ...prior, url: page.url, title: page.title ?? prior.title }
        : {
            tabId: page.id,
            url: page.url,
            title: page.title ?? "",
            origin: page.origin ?? "page",
            openerTabId: page.openerTabId ?? null,
          };
      next.set(page.id, tab);
      nextOrder.push(page.id);
    }
    tabs = next;
    order = nextOrder;
    activeTabId =
      preferredActiveTabId !== undefined && tabs.has(preferredActiveTabId)
        ? preferredActiveTabId
        : activeTabId !== null && tabs.has(activeTabId)
          ? activeTabId
          : (order[order.length - 1] ?? null);
    trimToMax();
    emit();
  }

  function activateTab(tabId: string): boolean {
    if (!tabs.has(tabId)) return false;
    if (activeTabId === tabId) return true;
    activeTabId = tabId;
    emit();
    return true;
  }

  function closeTab(tabId: string): boolean {
    if (!tabs.delete(tabId)) return false;
    order = order.filter((id) => id !== tabId);
    if (activeTabId === tabId) {
      activeTabId = order[order.length - 1] ?? null;
    }
    emit();
    return true;
  }

  function tab(tabId: string): BrowserTab | undefined {
    return tabs.get(tabId);
  }

  /**
   * Whether a runtime tab id is still valid in the current instance
   * generation. The host uses this to fail closed on stale ids before
   * dispatching an agent script to a page that no longer exists.
   */
  function isValidTabId(tabId: string): boolean {
    return tabs.has(tabId);
  }

  function subscribe(listener: BrowserTabStripListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    listeners.clear();
    tabs.clear();
    order = [];
    activeTabId = null;
    evicted = [];
  }

  return {
    resetInstance,
    openTab,
    normalizePopup,
    syncPages,
    activateTab,
    closeTab,
    takeEvictedTabIds,
    tab,
    isValidTabId,
    snapshot,
    subscribe,
    dispose,
    get generation() {
      return generation;
    },
  };
}
