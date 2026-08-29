import type { BrowserNavigationResponse } from "./contracts.js";

/**
 * `bb browser open` — the "just open the browser" entry point.
 *
 * Opening runs through the owner navigation boundary, which wakes a sleeping
 * Browser Instance, resolves bare search text through the profile's configured
 * search engine, and applies the Project Loopback Alias. It needs no Profile
 * Grant, so a fresh install can reach a page before anyone has decided
 * anything about automation.
 *
 * Reading the page back is a separate, grant-gated step. `open` attempts it
 * and degrades to the navigation result plus a one-line unlock hint when the
 * project has not been trusted yet, so the first failure explains its own fix.
 */

export const OPEN_UNLOCK_HINT =
  "Run `bb browser trust` to let agents read and automate pages in this project.";

export type BrowserOpenPageState = {
  url: string;
  title: string;
};

/** Read the page the owner navigation just landed on. */
export function openBrowserScript() {
  return "return JSON.stringify({ url: page.url(), title: await page.title() });";
}

export function parseOpenPageState(
  output: string,
): BrowserOpenPageState | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as BrowserOpenPageState).url !== "string" ||
      typeof (parsed as BrowserOpenPageState).title !== "string"
    ) {
      return null;
    }
    return parsed as BrowserOpenPageState;
  } catch {
    return null;
  }
}

export function openCliText(
  navigation: BrowserNavigationResponse,
  page: BrowserOpenPageState | null,
  unlockHint: boolean,
) {
  return [
    `Opened ${page?.url ?? navigation.address.url}`,
    page === null ? null : `Title: ${page.title}`,
    `Tab: ${navigation.tabId}`,
    unlockHint ? OPEN_UNLOCK_HINT : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
