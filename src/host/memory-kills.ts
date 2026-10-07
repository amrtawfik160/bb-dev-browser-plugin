import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Chrome runs in the host worker's cgroup, which on a BB host is the host
 * service's. When the service reaches its memory limit the kernel kills
 * processes there, Chrome renderers first, and the page crashes or stalls.
 * A call that fails while the kill count rises failed for lack of memory.
 */
export type HostMemoryKills = { count(): Promise<number | null> };

export function cgroupMemoryKills(root = "/"): HostMemoryKills {
  return {
    async count() {
      try {
        const membership = await readFile(
          join(root, "proc", "self", "cgroup"),
          "utf8",
        );
        const path = /^0::(.+)$/mu.exec(membership)?.[1];
        if (path === undefined) return null;
        const events = await readFile(
          join(root, "sys", "fs", "cgroup", path, "memory.events"),
          "utf8",
        );
        const kills = /^oom_kill (\d+)$/mu.exec(events)?.[1];
        return kills === undefined ? null : Number(kills);
      } catch {
        return null;
      }
    },
  };
}

export async function memoryKillNotice(
  kills: HostMemoryKills,
  before: number | null,
) {
  const after = await kills.count();
  if (before === null || after === null || after <= before) return undefined;
  const killed = after - before;
  return `The host ran out of memory during this call: the kernel killed ${killed} process${killed === 1 ? "" : "es"} in BB's host service, Chrome page processes first, so the page crashed or stalled. Retry once memory frees up. If it keeps happening, close unused tabs and agents on this host or raise the host service's memory limit.`;
}
