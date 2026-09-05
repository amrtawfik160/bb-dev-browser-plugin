import { describe, expect, it, vi } from "vitest";
import { createControlLeaseManager } from "../src/browser/control-lease.js";
import { BROWSER_SCRIPT_MAX_TIMEOUT_MS } from "../src/shared/contracts.js";

describe("Browser Control Lease", () => {
  it("waits for a normal 20-second agent operation instead of returning browser_busy after five seconds", async () => {
    vi.useFakeTimers();
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const first = await manager.acquireAgent(key, "Read the login page");
      const waiting = manager.acquireAgent(key, "Inspect another page").then(
        (lease) => ({ lease }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(manager.state(key)?.purpose).toBe("Read the login page");
      first.release();
      const outcome = await waiting;
      expect(outcome).toHaveProperty("lease");
      if ("lease" in outcome) {
        expect(manager.state(key)?.purpose).toBe("Inspect another page");
        outcome.lease.release();
      }
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });

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

  it("expires a waiting call after 30 seconds and never grants it later", async () => {
    vi.useFakeTimers();
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const first = await manager.acquireAgent(key, "First operation");
      const second = manager.acquireAgent(key, "Second operation");
      const expired = expect(
        manager.acquireAgent(key, "Expired operation"),
      ).rejects.toMatchObject({
        code: "browser_busy",
        message: expect.stringContaining("This call did not run"),
      });
      await vi.advanceTimersByTimeAsync(20_000);
      first.release();
      const next = await second;
      await vi.advanceTimersByTimeAsync(10_000);
      await expired;
      expect(manager.state(key)?.purpose).toBe("Second operation");
      next.release();
      expect(manager.state(key)).toBeUndefined();
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });

  it("removes a cancelled call while it waits behind another agent", async () => {
    vi.useFakeTimers();
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    const controller = new AbortController();
    try {
      const first = await manager.acquireAgent(key, "Active operation");
      const cancelled = expect(
        manager.acquireAgent(key, "Cancelled operation", controller.signal),
      ).rejects.toMatchObject({ code: "browser_busy" });
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort();
      await cancelled;
      expect(manager.state(key)?.purpose).toBe("Active operation");
      first.release();
      expect(manager.state(key)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.state(key)).toBeUndefined();
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });

  it("gives owner takeover priority over waiting agents", async () => {
    vi.useFakeTimers();
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const first = await manager.acquireAgent(key, "Active operation");
      first.signal.addEventListener("abort", () => first.release(), {
        once: true,
      });
      const waiting = expect(
        manager.acquireAgent(key, "Waiting operation"),
      ).rejects.toMatchObject({ code: "browser_busy" });
      await vi.advanceTimersByTimeAsync(10_000);
      const owner = await manager.acquireOwner(key);
      await waiting;
      expect(first.signal.aborted).toBe(true);
      expect(manager.state(key)?.actor).toBe("owner");
      await expect(
        manager.acquireAgent(key, "Another operation"),
      ).rejects.toMatchObject({ code: "browser_busy" });
      owner.release();
      expect(manager.state(key)).toBeUndefined();
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });
});
