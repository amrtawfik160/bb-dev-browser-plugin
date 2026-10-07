import { expect, it } from "vitest";
import { CONTROL_LEASE_AGENT_WAIT_MS } from "../src/browser/control-lease.js";
import {
  AXI_COMMAND_TIMEOUT_MS,
  BROWSER_AXI_HOST_CALL_TIMEOUT_MS,
  BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  BROWSER_SCRIPT_MIN_TIMEOUT_MS,
  browserScriptHostCallTimeoutMs,
} from "../src/shared/contracts.js";

/** BB's host call deadline when the caller names none. */
const BB_DEFAULT_HOST_CALL_DEADLINE_MS = 30_000;

it("gives a browser script a host deadline above its lease wait plus two runs", () => {
  expect(browserScriptHostCallTimeoutMs(BROWSER_SCRIPT_MAX_TIMEOUT_MS)).toBe(
    240_000,
  );
  for (const scriptTimeoutMs of [
    BROWSER_SCRIPT_MIN_TIMEOUT_MS,
    BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  ]) {
    expect(browserScriptHostCallTimeoutMs(scriptTimeoutMs)).toBeGreaterThan(
      CONTROL_LEASE_AGENT_WAIT_MS +
        2 * scriptTimeoutMs +
        BB_DEFAULT_HOST_CALL_DEADLINE_MS,
    );
  }
});

it("gives an axi command a host deadline above axi's own command limit", () => {
  expect(BROWSER_AXI_HOST_CALL_TIMEOUT_MS).toBe(270_000);
  expect(BROWSER_AXI_HOST_CALL_TIMEOUT_MS).toBeGreaterThan(
    AXI_COMMAND_TIMEOUT_MS,
  );
});
