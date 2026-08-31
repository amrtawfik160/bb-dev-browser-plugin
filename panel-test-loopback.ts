/**
 * Test-only switches for the public Browser Panel lifecycle seam. Production
 * always uses BB Connect; these let tests connect the rendered panel to the
 * retained host's real loopback gateway and drive reconnect timers without
 * evaluating app.tsx before the plugin test runtime is installed. Stored on
 * globalThis so a dynamically imported app.tsx cannot miss a second module
 * instance of this file.
 */
const LOOPBACK_FLAG = "__BB_BROWSER_PANEL_LOOPBACK__";
const CLOCK_KEY = "__BB_BROWSER_PANEL_LIFECYCLE_CLOCK__";

export type PanelLifecycleTestClock = {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: unknown): void;
};

function testPanelLifecycleClock() {
  return (globalThis as Record<string, unknown>)[CLOCK_KEY] as
    PanelLifecycleTestClock | undefined;
}

export function setTestLoopbackPanelTransport(enabled: boolean) {
  (globalThis as Record<string, unknown>)[LOOPBACK_FLAG] = enabled;
}

export function isTestLoopbackPanelTransport() {
  return (globalThis as Record<string, unknown>)[LOOPBACK_FLAG] === true;
}

export function setTestPanelLifecycleClock(
  clock: PanelLifecycleTestClock | undefined,
) {
  (globalThis as Record<string, unknown>)[CLOCK_KEY] = clock;
}

export function schedulePanelTimeout(
  callback: () => void,
  milliseconds: number,
): ReturnType<typeof setTimeout> | number {
  const clock = testPanelLifecycleClock();
  if (clock !== undefined) {
    return clock.setTimeout(callback, milliseconds);
  }
  return setTimeout(callback, milliseconds);
}

export function clearPanelTimeout(handle: unknown) {
  const clock = testPanelLifecycleClock();
  if (clock !== undefined) {
    clock.clearTimeout(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
