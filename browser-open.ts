import type { BrowserNavigationResponse } from "./contracts.js";

/**
 * `bb browser open` — the "just open the browser" entry point.
 *
 * Opening a URL is an agent operation: it requires a Profile Grant and runs
 * under the same host-owned Control Lease and Origin Scope enforcement as
 * `browser_script`. Omitting the URL only reports the current Browser Tab.
 */

export const OPEN_UNLOCK_HINT =
  "Open Browser Settings in BB to grant this project access to the current origin.";

export type BrowserOpenPageState = {
  url: string;
  title: string;
};

export function browserOpenDestinationOrigin(address: string): string | null {
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

export function openBrowserScript(address?: string) {
  const navigation =
    address === undefined
      ? ""
      : `await page.goto(${JSON.stringify(address)});\n`;
  return `${navigation}return JSON.stringify({ url: page.url(), title: await page.title() });`;
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
