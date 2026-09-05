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
export const NON_WEB_NAVIGATION_DENIED_MESSAGE =
  "Browser navigation to a non-web URL was denied by the active Profile Grant.";
export const ACTIVE_TAB_MARKER_FIELD = "__bbActiveTabMarker";
export const ACTIVE_TAB_UNAVAILABLE_MESSAGE =
  "The Browser Profile has no visible active tab.";

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
 * Remove every context-creating Playwright capability reachable through the
 * sandbox's page API. The pinned client exposes Browser, BrowserType, private
 * aliases, and its connection as enumerable objects; `browser.newPage()`
 * remains the supported same-context capability.
 */
function cutAgentBrowserRoots(
  pageListVariable: string,
  enforceNonWebNavigation: boolean,
  operationTimeoutMs: number,
): string {
  return `const __bbNonWebNavigationBoundary = (() => {
  let denied = false;
  return Object.freeze({
    markDenied: () => {
      denied = true;
    },
    wasDenied: () => denied,
  });
})();
const __bbAgentBrowserBoundary = (() => {
  const __bbEnforceNonWebNavigation = ${String(enforceNonWebNavigation)};
  const __bbDenied = async () => {
    throw new Error("Agent-created BrowserContexts are unavailable.");
  };
  const __bbDeniedNonWebNavigation = async () => {
    __bbNonWebNavigationBoundary.markDenied();
    throw new Error(${JSON.stringify(NON_WEB_NAVIGATION_DENIED_MESSAGE)});
  };
  const __bbNullBrowser = () => null;
  const __bbHardenedConnections = new Set();
  const __bbHardenedBrowserTypes = new Set();
  const __bbHardenedBrowsers = new Set();
  const __bbHardenedContexts = new Set();
  const __bbHardenedBrowserPrototypes = new Set();

  const __bbDefineImmutable = (target, property, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor?.configurable === false) {
      if ("value" in descriptor && descriptor.value === value) return;
      throw new Error("Playwright browser boundary could not be hardened.");
    }
    Object.defineProperty(target, property, {
      configurable: false,
      enumerable: descriptor?.enumerable ?? false,
      writable: false,
      value,
    });
  };

  const __bbPatchPrototype = (target, property, value) => {
    const prototype = Object.getPrototypeOf(target);
    if (
      prototype !== null &&
      Object.getOwnPropertyDescriptor(prototype, property) !== undefined
    ) {
      __bbDefineImmutable(prototype, property, value);
    }
  };

  const __bbPatchChannel = (channel, methods) => {
    if (channel === null || typeof channel !== "object") return;
    for (const method of methods) {
      __bbDefineImmutable(channel, method, __bbDenied);
    }
  };

  const __bbIsBlockedProtocolCall = (owner, method) => {
    const methodName = String(method);
    if (
      methodName === "newContext" ||
      methodName === "newContextForReuse" ||
      methodName === "launchPersistentContext"
    ) {
      return true;
    }
    if (
      methodName === "launch" ||
      methodName === "launchServer" ||
      methodName === "connect" ||
      methodName === "connectOverCDP" ||
      methodName === "connectOverCDPTransport"
    ) {
      return true;
    }
    const ownerType = owner?._type;
    return (
      ownerType === "Browser" &&
      (methodName === "newPage" || methodName === "newBrowserCDPSession")
    );
  };

  const __bbNavigationAddress = (address) => {
    if (typeof address === "string" || address instanceof String) return String(address);
    if (address != null && typeof address.href === "string") return address.href;
    return address == null ? "" : String(address);
  };
  const __bbIsAllowedNavigationAddress = (address) => {
    const raw = __bbNavigationAddress(address);
    if (raw.length === 0 || raw === "about:blank") return true;
    if (raw.indexOf("http://") === 0 || raw.indexOf("https://") === 0) return true;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.href === "about:blank") return true;
    if (url.protocol === "http:" || url.protocol === "https:") return true;
    return (
      url.protocol === "blob:" &&
      (url.origin.indexOf("http://") === 0 || url.origin.indexOf("https://") === 0)
    );
  };

  const __bbIsNonWebNavigation = (owner, method, params) =>
    __bbEnforceNonWebNavigation &&
    owner?._type === "Frame" &&
    String(method) === "goto" &&
    !__bbIsAllowedNavigationAddress(params?.url);

  // This adapter only recognizes the navigation protocol family. The host
  // Origin Scope guard remains the single owner of grant matching.
  const __bbHardenContext = (context) => {
    if (context === null || typeof context !== "object") return;
    if (__bbHardenedContexts.has(context)) return;
    __bbHardenedContexts.add(context);
    __bbPatchPrototype(context, "browser", __bbNullBrowser);
    __bbDefineImmutable(context, "browser", __bbNullBrowser);
    __bbDefineImmutable(context, "_browser", null);
    __bbDefineImmutable(context, "_parent", null);
  };

  const __bbHardenBrowserType = (browserType) => {
    if (browserType === null || typeof browserType !== "object") return;
    if (__bbHardenedBrowserTypes.has(browserType)) return;
    __bbHardenedBrowserTypes.add(browserType);
    const methods = [
      "launch",
      "launchServer",
      "launchPersistentContext",
      "connect",
      "_connect",
      "connectOverCDP",
      "_connectOverCDP",
      "connectOverCDPTransport",
      "_connectOverCDPTransport",
    ];
    for (const method of methods) {
      __bbPatchPrototype(browserType, method, __bbDenied);
      __bbDefineImmutable(browserType, method, __bbDenied);
    }
    __bbPatchChannel(browserType._channel, methods);
    __bbDefineImmutable(browserType, "_playwright", null);
    __bbDefineImmutable(browserType, "_connection", null);
  };

  const __bbHardenBrowser = (browser) => {
    if (browser === null || typeof browser !== "object") return;
    if (__bbHardenedBrowsers.has(browser)) return;
    __bbHardenedBrowsers.add(browser);
    const methods = [
      "newContext",
      "newContextForReuse",
      "_newContextForReuse",
      "_innerNewContext",
      "newPage",
      "newBrowserCDPSession",
    ];
    for (const method of methods) {
      __bbPatchPrototype(browser, method, __bbDenied);
      __bbDefineImmutable(browser, method, __bbDenied);
    }
    const browserPrototype = Object.getPrototypeOf(browser);
    if (!__bbHardenedBrowserPrototypes.has(browserPrototype)) {
      const originalDidCreateContext = browserPrototype?._didCreateContext;
      if (typeof originalDidCreateContext === "function") {
        __bbDefineImmutable(
          browserPrototype,
          "_didCreateContext",
          function (context) {
            const result = Reflect.apply(originalDidCreateContext, this, [
              context,
            ]);
            __bbHardenContext(context);
            return result;
          },
        );
      }
      __bbHardenedBrowserPrototypes.add(browserPrototype);
    }
    __bbPatchPrototype(browser, "browserType", __bbNullBrowser);
    __bbDefineImmutable(browser, "browserType", __bbNullBrowser);
    __bbDefineImmutable(browser, "_browserType", null);
    __bbPatchChannel(browser._channel, methods);
    for (const context of browser.contexts?.() ?? []) {
      __bbHardenContext(context);
    }
  };

  const __bbHardenConnection = (connection) => {
    if (connection === null || typeof connection !== "object") return;
    if (__bbHardenedConnections.has(connection)) return;
    __bbHardenedConnections.add(connection);
    const prototype = Object.getPrototypeOf(connection);
    const originalSend = prototype?.sendMessageToServer;
    if (typeof originalSend === "function") {
      const guardedSend = function (owner, method, params, options) {
        if (__bbIsNonWebNavigation(owner, method, params)) {
          return __bbDeniedNonWebNavigation();
        }
        if (__bbIsBlockedProtocolCall(owner, method)) return __bbDenied();
        return Reflect.apply(originalSend, this, [owner, method, params, options]);
      };
      __bbDefineImmutable(prototype, "sendMessageToServer", guardedSend);
      __bbDefineImmutable(connection, "sendMessageToServer", guardedSend);
    }
    const originalOnMessage = connection.onmessage;
    if (typeof originalOnMessage === "function") {
      const guardedOnMessage = (message) => {
        const owner = connection._objects?.get(message?.guid);
        if (__bbIsBlockedProtocolCall(owner, message?.method)) {
          return __bbDenied();
        }
        return originalOnMessage(message);
      };
      __bbDefineImmutable(connection, "onmessage", guardedOnMessage);
    }
    for (const object of connection._objects?.values?.() ?? []) {
      if (object?._type === "Browser") __bbHardenBrowser(object);
      if (object?._type === "BrowserType") __bbHardenBrowserType(object);
      if (object?._type === "BrowserContext") __bbHardenContext(object);
    }
  };

  return {
    install: (candidatePage) => {
      const context = candidatePage.context();
      __bbHardenConnection(candidatePage._connection ?? context._connection);
      __bbHardenContext(context);
    },
  };
})();
const __bbInstallAgentBrowserBoundary = __bbAgentBrowserBoundary.install;
const __bbConfigureAgentContext = (context) => {
  context.setDefaultNavigationTimeout(${operationTimeoutMs});
  context.setDefaultTimeout(${operationTimeoutMs});
};
for (const __bbEntry of ${pageListVariable}) {
  const __bbExistingPage = await browser.getPage(__bbEntry.id);
  const __bbExistingContext = __bbExistingPage.context();
  __bbConfigureAgentContext(__bbExistingContext);
  await __bbInstallAgentBrowserBoundary(__bbExistingPage);
}
__bbConfigureAgentContext(page.context());
await __bbInstallAgentBrowserBoundary(page);
`;
}

/**
 * Bound both navigation and ordinary locator actions below the script
 * deadline through the shared BrowserContext.
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

/**
 * Bind `page` before the agent code runs. An explicit `tabId` must exist or
 * the script fails closed as `tab_invalid`. Otherwise the binding order is:
 * the visible tab when it is already on the preferred (granted) origin, then
 * any tab on that origin, then the visible tab, then the first tab, and when
 * the profile has no tabs at all a fresh one is opened. Agents expect `page`
 * to exist; a profile whose tabs were all closed used to fail every script
 * with "no visible active tab" until an owner opened one by hand.
 */
export function agentPagePreamble(
  tabId?: string,
  preferredOrigin?: string,
  enforceNonWebNavigation = false,
  operationTimeoutMs = boundedOperationTimeoutMs(BROWSER_SCRIPT_MAX_TIMEOUT_MS),
): string {
  if (tabId !== undefined) {
    return `const __bbTargetPages = await browser.listPages();
if (!__bbTargetPages.some((entry) => entry.id === ${JSON.stringify(tabId)})) throw new Error(${JSON.stringify(
      TAB_INVALID_MESSAGE,
    )});
const page = await browser.getPage(${JSON.stringify(tabId)});
await page.bringToFront();
${cutAgentBrowserRoots("__bbTargetPages", enforceNonWebNavigation, operationTimeoutMs)}`;
  }
  return `const __bbPages = await browser.listPages();
let page;
const __bbPreferred = ${JSON.stringify(preferredOrigin ?? null)};
const __bbEntryOrigin = (entry) => {
  if (typeof entry.url !== "string" || (entry.url.indexOf("http://") !== 0 && entry.url.indexOf("https://") !== 0)) {
    return null;
  }
  return new URL(entry.url).origin;
};
const __bbIsVisible = async (candidate) => {
  try {
    return await candidate.evaluate(() => document.visibilityState === "visible");
  } catch {
    // A page that cannot answer (closed or crashed between the listing and
    // this call) is not one to bind; keep looking rather than fail the script.
    return false;
  }
};
let __bbVisibleEntry;
let __bbVisiblePage;
for (const __bbEntry of __bbPages) {
  const __bbCandidate = await browser.getPage(__bbEntry.id);
  if (await __bbIsVisible(__bbCandidate)) {
    __bbVisibleEntry = __bbEntry;
    __bbVisiblePage = __bbCandidate;
    break;
  }
}
if (__bbPreferred !== null) {
  if (__bbVisibleEntry !== undefined && __bbEntryOrigin(__bbVisibleEntry) === __bbPreferred) {
    page = __bbVisiblePage;
  } else {
    for (const __bbEntry of __bbPages) {
      if (__bbEntryOrigin(__bbEntry) === __bbPreferred) {
        page = await browser.getPage(__bbEntry.id);
        break;
      }
    }
  }
}
if (page === undefined) page = __bbVisiblePage;
if (page === undefined && __bbPages.length > 0) page = await browser.getPage(__bbPages[0].id);
if (page === undefined) page = await browser.newPage();
if (page === undefined) throw new Error(${JSON.stringify(ACTIVE_TAB_UNAVAILABLE_MESSAGE)});
await page.bringToFront();
${cutAgentBrowserRoots("__bbPages", enforceNonWebNavigation, operationTimeoutMs)}`;
}

/**
 * Report which tab is in front once the agent code has finished, so the host
 * can keep the shared strip's active tab in step with the browser. A script
 * that closed its last tab, or left every page hidden, has still succeeded:
 * the report is skipped rather than turning a good result into a failure.
 */
function activeTabReport(activeTabMarker: string) {
  return `const __bbActivePages = await browser.listPages();
let __bbActiveTabId;
for (const __bbActiveEntry of __bbActivePages) {
  try {
    const __bbActiveCandidate = await browser.getPage(__bbActiveEntry.id);
    if (await __bbActiveCandidate.evaluate(() => document.visibilityState === "visible")) {
      __bbActiveTabId = __bbActiveEntry.id;
      break;
    }
  } catch {
    continue;
  }
}
if (__bbActiveTabId !== undefined) {
  console.log(JSON.stringify({ ${ACTIVE_TAB_MARKER_FIELD}: ${JSON.stringify(activeTabMarker)}, id: __bbActiveTabId }));
}`;
}

export function wrapAgentScriptResult(
  code: string,
  activeTabMarker?: string,
): string {
  const activeReport =
    activeTabMarker === undefined ? "" : activeTabReport(activeTabMarker);
  return `let __bbResult;
let __bbScriptError;
let __bbScriptFailed = false;
try {
  __bbResult = await (async () => {
${code}
  })();
} catch (error) {
  __bbScriptFailed = true;
  __bbScriptError = error;
}
if (
  typeof __bbNonWebNavigationBoundary !== "undefined" &&
  __bbNonWebNavigationBoundary.wasDenied()
) {
  throw new Error(${JSON.stringify(NON_WEB_NAVIGATION_DENIED_MESSAGE)});
}
if (!__bbScriptFailed) {
${activeReport}
}
if (__bbScriptFailed) throw __bbScriptError;
if (__bbResult !== undefined) {
  console.log(typeof __bbResult === "string" ? __bbResult : JSON.stringify(__bbResult));
}`;
}

export function prepareAgentExecution(input: {
  code: string;
  tabId?: string;
  preferredOrigin?: string;
  timeoutMs?: number;
  enforceNonWebNavigation?: boolean;
  activeTabMarker?: string;
  screenshot?: { fileName: string; marker: string };
}): string {
  const operationTimeoutMs = boundedOperationTimeoutMs(
    input.timeoutMs ?? BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  );
  const pagePreamble = agentPagePreamble(
    input.tabId,
    input.preferredOrigin,
    input.enforceNonWebNavigation ?? false,
    operationTimeoutMs,
  );
  const wrappedUser = wrapAgentScriptResult(input.code, input.activeTabMarker);
  if (input.screenshot === undefined) {
    return `${pagePreamble}${wrappedUser}`;
  }
  const markerLine = JSON.stringify({
    __bbScreenshot: input.screenshot.marker,
  });
  return `${pagePreamble}try {
${wrappedUser}
} finally {
await saveScreenshot(await page.screenshot({ type: "png" }), ${JSON.stringify(input.screenshot.fileName)});
console.log(${JSON.stringify(markerLine)});
}`;
}
