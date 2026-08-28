import { describe, expect, it, vi } from "vitest";
import { createControlLeaseManager } from "../control-lease.js";
import { BROWSER_SCRIPT_MAX_TIMEOUT_MS } from "../contracts.js";

describe("Browser Control Lease", () => {
  it("revokes an agent lease at the maximum script duration", async () => {
    vi.useFakeTimers();
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const lease = await manager.acquireAgent(key, "Inspect the fixture");

      await vi.advanceTimersByTimeAsync(BROWSER_SCRIPT_MAX_TIMEOUT_MS);

      expect(lease.signal.aborted).toBe(true);
      expect(manager.state(key)).toBeUndefined();
      lease.release();
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });
});
