import { describe, expect, it } from "vitest";
import {
  createBrowserTabStrip,
  newTabId,
  type BrowserTabStrip,
} from "../browser-tabs.js";
import { createPanelSession } from "../panel-session.js";

function stripIds(strip: BrowserTabStrip) {
  return strip.tabs.map((tab) => tab.tabId);
}

describe("Browser Tab strip", () => {
  it("shares one ordered strip with one active tab across panels", () => {
    const strip = createBrowserTabStrip();
    const a = strip.openTab("https://example.test/a", "A");
    const b = strip.openTab("https://example.test/b", "B");

    // Two panels observe the same ordered strip and the same active tab.
    const observedByPanel1 = strip.snapshot();
    const observedByPanel2 = strip.snapshot();
    expect(observedByPanel1).toEqual(observedByPanel2);
    expect(stripIds(observedByPanel1)).toEqual([a, b]);
    expect(observedByPanel1.activeTabId).toBe(b);

    strip.activateTab(a);
    expect(strip.snapshot().activeTabId).toBe(a);
    strip.dispose();
  });

  it("normalizes popups into the shared tab strip and activates them", () => {
    const strip = createBrowserTabStrip();
    const opener = strip.openTab("https://example.test/opener", "Opener");
    const popup = strip.normalizePopup(
      "https://example.test/popup",
      "Popup",
      opener,
    );

    const snapshot = strip.snapshot();
    const popupTab = snapshot.tabs.find((tab) => tab.tabId === popup);
    expect(popupTab).toMatchObject({
      origin: "popup",
      openerTabId: opener,
    });
    // The popup is part of the same ordered strip and becomes active.
    expect(stripIds(snapshot)).toEqual([opener, popup]);
    expect(snapshot.activeTabId).toBe(popup);
    strip.dispose();
  });

  it("keeps runtime tab identifiers consistent for the life of the instance", () => {
    const strip = createBrowserTabStrip();
    const id = newTabId();
    strip.syncPages([{ id, url: "https://example.test/x", title: "X" }]);
    expect(strip.isValidTabId(id)).toBe(true);
    expect(strip.tab(id)?.url).toBe("https://example.test/x");

    // Updating a page preserves its runtime id; only url/title change.
    strip.syncPages([
      { id, url: "https://example.test/x/updated", title: "X2" },
    ]);
    expect(strip.tab(id)?.tabId).toBe(id);
    expect(strip.tab(id)?.url).toBe("https://example.test/x/updated");
    expect(strip.snapshot().activeTabId).toBe(id);
    strip.dispose();
  });

  it("invalidates runtime tab identifiers across an instance restart", () => {
    const strip = createBrowserTabStrip();
    const id = strip.openTab("https://example.test/a", "A");
    expect(strip.isValidTabId(id)).toBe(true);

    strip.resetInstance();
    // A stale id from the prior generation fails closed as invalid.
    expect(strip.isValidTabId(id)).toBe(false);
    expect(strip.snapshot()).toEqual({ tabs: [], activeTabId: null });
    expect(strip.generation).toBeGreaterThan(0);
    strip.dispose();
  });

  it("drops pages that close and re-selects an active tab", () => {
    const strip = createBrowserTabStrip();
    const a = strip.openTab("https://example.test/a", "A");
    const b = strip.openTab("https://example.test/b", "B");
    strip.activateTab(a);
    expect(strip.closeTab(b)).toBe(true);
    expect(stripIds(strip.snapshot())).toEqual([a]);
    // Active tab is not the closed one.
    expect(strip.snapshot().activeTabId).toBe(a);
    expect(strip.closeTab(a)).toBe(true);
    expect(strip.snapshot().activeTabId).toBeNull();
    strip.dispose();
  });

  it("broadcasts strip changes to every subscribed panel", () => {
    const strip = createBrowserTabStrip();
    const seen: BrowserTabStrip[] = [];
    const unsubscribe = strip.subscribe((next) => seen.push(next));
    const a = strip.openTab("https://example.test/a", "A");
    strip.openTab("https://example.test/b", "B");
    strip.activateTab(a);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[seen.length - 1]!.activeTabId).toBe(a);
    unsubscribe();
    strip.openTab("https://example.test/c", "C");
    // No further broadcasts after unsubscribe.
    expect(
      seen[seen.length - 1]!.tabs.find((t) => t.url.endsWith("/c")),
    ).toBeUndefined();
    strip.dispose();
  });

  it("trims the strip to a bounded maximum and drops the oldest tab", () => {
    const strip = createBrowserTabStrip({ maxTabs: 2 });
    strip.openTab("https://example.test/a", "A");
    const b = strip.openTab("https://example.test/b", "B");
    const c = strip.openTab("https://example.test/c", "C");
    expect(stripIds(strip.snapshot())).toEqual([b, c]);
    strip.dispose();
  });

  it("reports each evicted tab once until the queue is drained", () => {
    // Forgetting a tab without closing its page bounded nothing: the next
    // inventory reported the same page and the strip re-added it, while every
    // renderer stayed resident for the life of the profile.
    const strip = createBrowserTabStrip({ maxTabs: 2 });
    const a = strip.openTab("https://example.test/a", "A");
    strip.openTab("https://example.test/b", "B");
    strip.openTab("https://example.test/c", "C");
    expect(strip.takeEvictedTabIds()).toEqual([a]);
    expect(strip.takeEvictedTabIds()).toEqual([]);
    strip.dispose();
  });

  it("never evicts the tab the owner is looking at", () => {
    const strip = createBrowserTabStrip({ maxTabs: 2 });
    const a = strip.openTab("https://example.test/a", "A");
    const b = strip.openTab("https://example.test/b", "B");
    strip.activateTab(a);
    const c = strip.openTab("https://example.test/c", "C");
    expect(strip.takeEvictedTabIds()).toEqual([b]);
    expect(stripIds(strip.snapshot())).toEqual([a, c]);
    strip.dispose();
  });

  it("evicts pages past the cap when syncing a runtime inventory", () => {
    const strip = createBrowserTabStrip({ maxTabs: 2 });
    strip.syncPages(
      [
        { id: "tab-a", url: "https://example.test/a" },
        { id: "tab-b", url: "https://example.test/b" },
        { id: "tab-c", url: "https://example.test/c" },
      ],
      "tab-c",
    );
    expect(strip.takeEvictedTabIds()).toEqual(["tab-a"]);
    expect(stripIds(strip.snapshot())).toEqual(["tab-b", "tab-c"]);
    strip.dispose();
  });

  it("refuses to trim an inventory when the foreground tab is unknown", () => {
    const strip = createBrowserTabStrip({ maxTabs: 2 });

    expect(() =>
      strip.syncPages([
        { id: "tab-a", url: "https://example.test/a" },
        { id: "tab-b", url: "https://example.test/b" },
        { id: "tab-c", url: "https://example.test/c" },
      ]),
    ).toThrow("active Browser Tab");
    expect(strip.snapshot()).toEqual({ tabs: [], activeTabId: null });
    strip.dispose();
  });

  it("protects the runtime active tab while syncing a large inventory", () => {
    const strip = createBrowserTabStrip({ maxTabs: 2 });
    strip.syncPages(
      [
        { id: "tab-a", url: "https://example.test/a" },
        { id: "tab-b", url: "https://example.test/b" },
        { id: "tab-c", url: "https://example.test/c" },
      ],
      "tab-a",
    );
    expect(strip.takeEvictedTabIds()).toEqual(["tab-b"]);
    expect(strip.snapshot().activeTabId).toBe("tab-a");
    expect(stripIds(strip.snapshot())).toEqual(["tab-a", "tab-c"]);
    strip.dispose();
  });

  it("forgets pending evictions when a new instance generation starts", () => {
    const strip = createBrowserTabStrip({ maxTabs: 2 });
    strip.openTab("https://example.test/a", "A");
    strip.openTab("https://example.test/b", "B");
    strip.openTab("https://example.test/c", "C");
    strip.resetInstance();
    // Those ids belong to a browser that no longer exists.
    expect(strip.takeEvictedTabIds()).toEqual([]);
    strip.dispose();
  });

  it("delegates a session-backed strip to the shared Panel session", () => {
    const session = createPanelSession();
    const adapter = createBrowserTabStrip({ session });
    const tabId = adapter.openTab("https://example.test/a", "A");

    expect(adapter).toBe(session.tabStrip());
    expect(session.snapshot().tabs).toEqual(adapter.snapshot());
    expect(session.snapshot().tabs.activeTabId).toBe(tabId);
    session.dispose();
  });
});
