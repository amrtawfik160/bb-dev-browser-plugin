import {
  BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  BROWSER_SCRIPT_MIN_TIMEOUT_MS,
} from "./contracts.js";

/**
 * Convenience wrapping for agent Playwright scripts.
 *
 * `dev-browser` captures stdout, not JavaScript `return` values, and does not
 * bind a `page` global. Agent docs and the bundled skill use `return page.url()`.
 * The host injects an active-tab `page` binding and prints a returned value so
 * those scripts work without extra boilerplate. Owner navigation scripts do not
 * pass through this helper; they call the process boundary directly.
 */

export const TAB_INVALID_MESSAGE =
  "Browser Tab is invalid or belongs to a previous runtime";

export function preferredTabOrigin(originScope?: string): string | undefined {
  if (
    originScope === undefined ||
    originScope === "*" ||
    originScope.includes("*")
  ) {
    return undefined;
  }
  return originScope;
}

const NAVIGATION_TIMEOUT_HEADROOM_MS = 5_000;

/**
 * Bound both navigation and ordinary locator actions below the script
 * deadline.
 *
 * Playwright defaults an action such as `click` to 30 seconds, which is also
 * the maximum script timeout, so an element that never becomes actionable
 * outlived the host call and surfaced an opaque transport deadline instead of
 * the Playwright call log naming the reason. Leaving headroom lets the real
 * error win the race.
 */
function boundedOperationTimeoutMs(scriptTimeoutMs: number): number {
  if (scriptTimeoutMs < BROWSER_SCRIPT_MIN_TIMEOUT_MS) {
    throw new RangeError(
      `Browser script timeout must be at least ${BROWSER_SCRIPT_MIN_TIMEOUT_MS}ms.`,
    );
  }
  const headroomMs = Math.min(
    NAVIGATION_TIMEOUT_HEADROOM_MS,
    Math.floor(scriptTimeoutMs / 4),
  );
  return scriptTimeoutMs - headroomMs;
}

export function agentPagePreamble(
  tabId?: string,
  preferredOrigin?: string,
): string {
  if (tabId !== undefined) {
    return `const __bbTargetPages = await browser.listPages();
if (!__bbTargetPages.some((entry) => entry.id === ${JSON.stringify(tabId)})) throw new Error(${JSON.stringify(
      TAB_INVALID_MESSAGE,
    )});
const page = await browser.getPage(${JSON.stringify(tabId)});
await page.bringToFront();`;
  }
  return `const __bbPages = await browser.listPages();
let page = await browser.getPage(__bbPages.length === 0 ? "main" : __bbPages[0].id);
const __bbPreferred = ${JSON.stringify(preferredOrigin ?? null)};
if (__bbPreferred !== null) {
  for (const __bbEntry of __bbPages) {
    if (typeof __bbEntry.url !== "string" || (__bbEntry.url.indexOf("http://") !== 0 && __bbEntry.url.indexOf("https://") !== 0)) {
      continue;
    }
    if (new URL(__bbEntry.url).origin === __bbPreferred) {
      page = await browser.getPage(__bbEntry.id);
      break;
    }
  }
} else {
  for (const __bbEntry of __bbPages) {
    const __bbCandidate = await browser.getPage(__bbEntry.id);
    if (await __bbCandidate.evaluate(() => document.visibilityState === "visible")) {
      page = __bbCandidate;
      break;
    }
  }
}
await page.bringToFront();`;
}

export function wrapAgentScriptResult(code: string): string {
  return `const __bbResult = await (async () => {
${code}
})();
if (__bbResult !== undefined) {
  console.log(typeof __bbResult === "string" ? __bbResult : JSON.stringify(__bbResult));
}`;
}

export function prepareAgentExecution(input: {
  code: string;
  tabId?: string;
  preferredOrigin?: string;
  timeoutMs?: number;
  screenshot?: { fileName: string; marker: string };
}): string {
  const pagePreamble = agentPagePreamble(input.tabId, input.preferredOrigin);
  const wrappedUser = wrapAgentScriptResult(input.code);
  const operationTimeoutMs = boundedOperationTimeoutMs(
    input.timeoutMs ?? BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  );
  const prefix = `${pagePreamble}
page.setDefaultNavigationTimeout(${operationTimeoutMs});
page.setDefaultTimeout(${operationTimeoutMs});`;
  if (input.screenshot === undefined) {
    return `${prefix}${wrappedUser}`;
  }
  const markerLine = JSON.stringify({
    __bbScreenshot: input.screenshot.marker,
  });
  return `${prefix}try {
${wrappedUser}
} finally {
await saveScreenshot(await page.screenshot({ type: "png" }), ${JSON.stringify(input.screenshot.fileName)});
console.log(${JSON.stringify(markerLine)});
}`;
}
