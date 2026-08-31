/**
 * Test-only switch for the public Browser Panel lifecycle seam. Production
 * always uses BB Connect; this flag lets tests connect the rendered panel to
 * the retained host's real loopback gateway without evaluating app.tsx before
 * the plugin test runtime is installed. Stored on globalThis so a dynamically
 * imported app.tsx cannot miss a second module instance of this file.
 */
const LOOPBACK_FLAG = "__BB_BROWSER_PANEL_LOOPBACK__";

export function setTestLoopbackPanelTransport(enabled: boolean) {
  (globalThis as Record<string, unknown>)[LOOPBACK_FLAG] = enabled;
}

export function isTestLoopbackPanelTransport() {
  return (globalThis as Record<string, unknown>)[LOOPBACK_FLAG] === true;
}
