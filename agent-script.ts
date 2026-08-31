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
 * Remove every context-creating Playwright capability reachable through the
 * sandbox's page API. The pinned client exposes Browser, BrowserType, private
 * aliases, and its connection as enumerable objects; the plugin wrapper's
 * `browser.newPage()` remains the supported same-context capability.
 */
function cutAgentBrowserRoots(pageListVariable: string): string {
  return `const __bbInstallAgentBrowserBoundary = (() => {
  const __bbDenied = async () => {
    throw new Error("Agent-created BrowserContexts are unavailable.");
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
    if (
      method === "newContext" ||
      method === "newContextForReuse" ||
      method === "launchPersistentContext"
    ) {
      return true;
    }
    if (
      method === "launch" ||
      method === "launchServer" ||
      method === "connect" ||
      method === "connectOverCDP" ||
      method === "connectOverCDPTransport"
    ) {
      return true;
    }
    const ownerType = owner?._type;
    return (
      ownerType === "Browser" &&
      (method === "newPage" || method === "newBrowserCDPSession")
    );
  };

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

  return (candidatePage) => {
    const context = candidatePage.context();
    __bbHardenConnection(candidatePage._connection ?? context._connection);
    __bbHardenContext(context);
  };
})();
for (const __bbEntry of ${pageListVariable}) {
  await __bbInstallAgentBrowserBoundary(await browser.getPage(__bbEntry.id));
}
await __bbInstallAgentBrowserBoundary(page);`;
}

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
await page.bringToFront();
${cutAgentBrowserRoots("__bbTargetPages")}`;
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
await page.bringToFront();
${cutAgentBrowserRoots("__bbPages")}`;
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
