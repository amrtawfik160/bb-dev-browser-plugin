import { describe, expect, it, vi } from "vitest";
import { createControlLeaseManager } from "../src/browser/control-lease.js";
import { BROWSER_SCRIPT_MAX_TIMEOUT_MS } from "../src/shared/contracts.js";

describe("Browser Control Lease", () => {
  it("serializes repeated owner actions without cancelling the active action", async () => {
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const first = await manager.acquireOwner(key);
      const granted: number[] = [];
      const second = manager.acquireOwner(key).then((lease) => {
        granted.push(2);
        return lease;
      });
      const third = manager.acquireOwner(key).then((lease) => {
        granted.push(3);
        return lease;
      });
      expect(first.signal.aborted).toBe(false);
      expect(granted).toEqual([]);
      first.release();
      const next = await second;
      expect(granted).toEqual([2]);
      expect(next.signal.aborted).toBe(false);
      next.release();
      (await third).release();
      expect(granted).toEqual([2, 3]);
      expect(manager.state(key)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("lets the owner act while an agent works, without interrupting it", async () => {
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const agent = await manager.acquireAgent(
        key,
        "Inspect the page",
        undefined,
        "thread:a",
      );
      const owner = await manager.acquireOwner(key);
      expect(agent.signal.aborted).toBe(false);
      expect(owner.signal.aborted).toBe(false);
      // The panel still reports the working agent while the owner browses.
      expect(manager.state(key)).toEqual({
        actor: "agent",
        purpose: "Inspect the page",
      });
      owner.release();
      agent.release();
      expect(manager.state(key)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("runs agent sessions in their own tabs side by side and queues calls within one session", async () => {
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const a = await manager.acquireAgent(
        key,
        "Thread A",
        undefined,
        "thread:a",
      );
      const b = await manager.acquireAgent(
        key,
        "Thread B",
        undefined,
        "thread:b",
      );
      expect(a.signal.aborted).toBe(false);
      expect(b.signal.aborted).toBe(false);
      let secondA = false;
      const nextA = manager
        .acquireAgent(key, "Thread A again", undefined, "thread:a")
        .then((lease) => {
          secondA = true;
          return lease;
        });
      await Promise.resolve();
      expect(secondA).toBe(false);
      a.release();
      (await nextA).release();
      expect(secondA).toBe(true);
      b.release();
    } finally {
      manager.dispose();
    }
  });

  it("stops every agent session when the profile's control is revoked, and only agents when asked", async () => {
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      const a = await manager.acquireAgent(
        key,
        "Thread A",
        undefined,
        "thread:a",
      );
      const owner = await manager.acquireOwner(key);
      manager.revokeAgents(key);
      expect(a.signal.aborted).toBe(true);
      expect(owner.signal.aborted).toBe(false);
      const b = await manager.acquireAgent(
        key,
        "Thread B",
        undefined,
        "thread:b",
      );
      manager.revoke(key);
      expect(b.signal.aborted).toBe(true);
      expect(owner.signal.aborted).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it("removes a cancelled owner request without interrupting another owner", async () => {
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    const controller = new AbortController();
    try {
      const first = await manager.acquireOwner(key);
      const cancelled = expect(
        manager.acquireOwner(key, controller.signal),
      ).rejects.toMatchObject({ code: "browser_busy" });
      controller.abort();
      await cancelled;
      expect(first.signal.aborted).toBe(false);
      first.release();
      expect(manager.state(key)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("does not grant waiting owner requests after disposal", async () => {
    const manager = createControlLeaseManager();
    const key = "host-a\0profile-a";
    try {
      await manager.acquireOwner(key);
      const waiting = expect(manager.acquireOwner(key)).rejects.toMatchObject({
        code: "browser_busy",
      });
      manager.dispose();
      await waiting;
      expect(manager.state(key)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

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
});
