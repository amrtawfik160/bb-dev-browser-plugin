import type { BrowserNavigationResponse } from "./contracts.js";

/**
 * `bb browser open` — the "just open the browser" entry point.
 *
 * Opening a URL is an agent operation: it requires a Profile Grant and runs
 * under the same host-owned Control Lease and Origin Scope enforcement as
 * `browser_script`.
 */

export type BrowserOpenPageState = {
  url: string;
  title: string;
};

export function openBrowserScript(address: string) {
  return `await page.goto(${JSON.stringify(address)});\nreturn JSON.stringify({ url: page.url(), title: await page.title() });`;
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
  page: BrowserOpenPageState,
) {
  return [
    `Opened ${page.url}`,
    `Title: ${page.title}`,
    `Tab: ${navigation.tabId}`,
  ].join("\n");
}
