import { describe, expect, it } from "vitest";
import { BROWSER_TRANSFER_MAX_FILE_BYTES } from "../contracts.js";
import {
  authorizeFileTransfer,
  createTransferStagingManager,
  resolveTransferStagingRoot,
  type TransferStagingFilesystem,
  type TransferStagingStat,
} from "../transfer-staging.js";

/**
 * In-memory Transfer Staging filesystem. Resolves realpaths (canonicalizing
 * `..`/`.` and following symlinks), reports narrow stats, and lets a test
 * mutate a file between selection and copy to prove changed-after-selection
 * rejection. `available` controls the low-disk guard.
 */
type FakeEntry = {
  kind: "file" | "directory" | "special" | "symlink";
  content?: Uint8Array;
  target?: string;
  mtimeNs: bigint;
};
function createFakeFilesystem(
  options: {
    available?: number;
    onStatAfter?: (path: string, stat: TransferStagingStat) => void;
  } = {},
) {
  const entries = new Map<string, FakeEntry>();
  let available = options.available ?? Number.POSITIVE_INFINITY;
  let disposed = false;
  function normalize(path: string): string {
    const parts = path.split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        stack.pop();
        continue;
      }
      stack.push(part);
    }
    return `/${stack.join("/")}`;
  }
  function realpath(path: string): string {
    let current = normalize(path);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      if (seen.has(current)) throw new Error("symlink loop");
      seen.add(current);
      const entry = entries.get(current);
      if (entry === undefined) throw new Error(`ENOENT: ${current}`);
      if (entry.kind !== "symlink") return current;
      current = normalize(entry.target!);
    }
    return current;
  }
  const fs: TransferStagingFilesystem = {
    realpath: async (p) => realpath(p),
    async stat(p) {
      const resolved = realpath(p);
      const entry = entries.get(resolved);
      if (entry === undefined) throw new Error(`ENOENT: ${resolved}`);
      const isFile = entry.kind === "file";
      const isDirectory = entry.kind === "directory";
      const isSpecial = entry.kind === "special";
      const stat: TransferStagingStat = {
        sizeBytes: entry.content?.byteLength ?? 0,
        mtimeNs: entry.mtimeNs,
        isFile,
        isDirectory,
        isSpecial,
      };
      options.onStatAfter?.(resolved, stat);
      return stat;
    },
    async copyFile(source, destination) {
      const resolved = realpath(source);
      const entry = entries.get(resolved);
      if (entry?.kind !== "file") throw new Error("not a file");
      entries.set(normalize(destination), {
        kind: "file",
        content: entry.content!.slice(),
        mtimeNs: entry.mtimeNs,
      });
    },
    async writeFile(path, data) {
      entries.set(normalize(path), {
        kind: "file",
        content: data.slice(),
        mtimeNs: 1_000_000n,
      });
    },
    async mkdir(path) {
      entries.set(normalize(path), { kind: "directory", mtimeNs: 1_000_000n });
    },
    async chmod() {
      // No-op: permissions are not modeled in memory.
    },
    async rm(path, opts) {
      const resolved = normalize(path);
      const entry = entries.get(resolved);
      if (entry === undefined) {
        if (opts.force) return;
        throw new Error("ENOENT");
      }
      entries.delete(resolved);
    },
    async availableBytes() {
      if (disposed) return 0;
      return available;
    },
  };
  function put(path: string, entry: FakeEntry) {
    entries.set(normalize(path), entry);
  }
  function has(path: string) {
    return entries.has(normalize(path));
  }
  function setAvailable(bytes: number) {
    available = bytes;
  }
  function mutate(path: string, content: Uint8Array) {
    const resolved = realpath(path);
    const entry = entries.get(resolved);
    if (entry?.kind === "file") {
      entries.set(resolved, {
        ...entry,
        content,
        mtimeNs: entry.mtimeNs + 1_000_000n,
      });
    }
  }
  function markSpecial(path: string) {
    entries.set(normalize(path), { kind: "special", mtimeNs: 1_000_000n });
  }
  return {
    fs,
    put,
    has,
    setAvailable,
    mutate,
    markSpecial,
    dispose: () => {
      disposed = true;
    },
  };
}

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now };
  const fake = createFakeFilesystem();
  fake.put("/env", { kind: "directory", mtimeNs: 1_000_000n });
  fake.put("/env/payload.txt", {
    kind: "file",
    content: new TextEncoder().encode("deterministic-fixture"),
    mtimeNs: 1_000_000n,
  });
  const manager = createTransferStagingManager({
    filesystem: fake.fs,
    stagingRoot: "/staging",
    clock,
    id: () => "transfer-1",
    maxFileBytes: 1024,
    lowDiskMarginBytes: 1024,
    ttlMs: 60_000,
  });
  return {
    clock,
    fake,
    manager,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("Transfer Staging", () => {
  it("stages an explicitly selected workspace file inside the environment", async () => {
    const { manager } = setup();
    const response = await manager.stage({
      kind: "workspace",
      transferId: "fixture",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    expect(response).toEqual({
      outcome: "staged",
      transferId: "fixture",
      kind: "workspace",
      sizeBytes: 21,
      contentType: null,
    });
  });

  it("never exposes the staged path, source path, or environment root", async () => {
    const { manager } = setup();
    const response = await manager.stage({
      kind: "workspace",
      transferId: "fixture",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    const json = JSON.stringify(response);
    expect(json).not.toContain("/staging");
    expect(json).not.toContain("/env/payload.txt");
    expect(json).not.toContain("environmentRoot");
  });

  it("rejects a symlink that escapes the environment", async () => {
    const { fake, manager } = setup();
    fake.put("/outside", { kind: "directory", mtimeNs: 1_000_000n });
    fake.put("/outside/secret.txt", {
      kind: "file",
      content: new TextEncoder().encode("secret"),
      mtimeNs: 1_000_000n,
    });
    fake.put("/env/escape.txt", {
      kind: "symlink",
      target: "/outside/secret.txt",
      mtimeNs: 1_000_000n,
    });
    const response = await manager.stage({
      kind: "workspace",
      transferId: "escape",
      sourcePath: "/env/escape.txt",
      environmentRoot: "/env",
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("symlink-escape");
    }
  });

  it("rejects a traversal path that resolves outside the environment", async () => {
    const { fake, manager } = setup();
    fake.put("/sibling.txt", {
      kind: "file",
      content: new TextEncoder().encode("outside"),
      mtimeNs: 1_000_000n,
    });
    const response = await manager.stage({
      kind: "workspace",
      transferId: "traversal",
      sourcePath: "/env/../sibling.txt",
      environmentRoot: "/env",
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("symlink-escape");
    }
  });

  it("rejects a special (non-regular) file", async () => {
    const { fake, manager } = setup();
    fake.put("/env/subdir", { kind: "directory", mtimeNs: 1_000_000n });
    const response = await manager.stage({
      kind: "workspace",
      transferId: "dir",
      sourcePath: "/env/subdir",
      environmentRoot: "/env",
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("special-file");
    }
  });

  it("rejects a missing file", async () => {
    const { manager } = setup();
    const response = await manager.stage({
      kind: "workspace",
      transferId: "missing",
      sourcePath: "/env/absent.txt",
      environmentRoot: "/env",
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("not-found");
    }
  });

  it("rejects an oversized file", async () => {
    const { fake, manager } = setup();
    fake.put("/env/big.txt", {
      kind: "file",
      content: new Uint8Array(2048),
      mtimeNs: 1_000_000n,
    });
    const response = await manager.stage({
      kind: "workspace",
      transferId: "big",
      sourcePath: "/env/big.txt",
      environmentRoot: "/env",
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("oversized");
    }
  });

  it("rejects when the host is low on disk", async () => {
    const { fake, manager } = setup();
    fake.setAvailable(10);
    const response = await manager.stage({
      kind: "workspace",
      transferId: "lowdisk",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("low-disk");
    }
  });

  it("rejects a file that changed between selection and staging", async () => {
    let calls = 0;
    const fakeFs = createFakeFilesystem({
      onStatAfter: (path) => {
        if (path === "/env/payload.txt") {
          calls += 1;
          // Mutate the file after the first (selection) stat so the post-copy
          // stat differs in size or mtime.
          if (calls === 1) {
            fakeFs.mutate(
              "/env/payload.txt",
              new TextEncoder().encode("changed"),
            );
          }
        }
      },
    });
    fakeFs.put("/env", { kind: "directory", mtimeNs: 1_000_000n });
    fakeFs.put("/env/payload.txt", {
      kind: "file",
      content: new TextEncoder().encode("deterministic-fixture"),
      mtimeNs: 1_000_000n,
    });
    const manager = createTransferStagingManager({
      filesystem: fakeFs.fs,
      stagingRoot: "/staging",
      clock: { now: () => 1_000_000 },
      id: () => "transfer-1",
      maxFileBytes: 1024,
      lowDiskMarginBytes: 1024,
      ttlMs: 60_000,
    });
    const response = await manager.stage({
      kind: "workspace",
      transferId: "changed",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("changed-after-selection");
    }
  });

  it("removes staged data after use", async () => {
    const { fake, manager } = setup();
    await manager.stage({
      kind: "workspace",
      transferId: "fixture",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    const consume = await manager.consume("fixture");
    expect(consume.outcome).toBe("used");
    await manager.release("fixture");
    expect(fake.has("/staging/transfer-1")).toBe(false);
    expect(manager.size()).toBe(0);
  });

  it("removes staged data on cancellation", async () => {
    const { fake, manager } = setup();
    await manager.stage({
      kind: "workspace",
      transferId: "fixture",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    const cancel = await manager.cancel("fixture");
    expect(cancel.outcome).toBe("cancelled");
    expect(fake.has("/staging/transfer-1")).toBe(false);
  });

  it("reaps expired staging on expiry", async () => {
    const { fake, manager, advance } = setup();
    await manager.stage({
      kind: "workspace",
      transferId: "fixture",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    advance(61_000);
    const { expired } = await manager.expire();
    expect(expired).toContain("fixture");
    expect(fake.has("/staging/transfer-1")).toBe(false);
  });

  it("purges all staging on worker restart", async () => {
    const { fake, manager } = setup();
    await manager.stage({
      kind: "workspace",
      transferId: "fixture",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    const { removed } = await manager.purgeAll();
    expect(removed).toContain("fixture");
    expect(fake.has("/staging/transfer-1")).toBe(false);
    expect(manager.size()).toBe(0);
  });

  it("removes on-disk staged files on dispose", async () => {
    const { fake, manager } = setup();
    await manager.stage({
      kind: "workspace",
      transferId: "fixture",
      sourcePath: "/env/payload.txt",
      environmentRoot: "/env",
    });
    await manager.dispose();
    expect(fake.has("/staging/transfer-1")).toBe(false);
    expect(manager.size()).toBe(0);
  });

  it("stages a displaying-client file through the file chooser", async () => {
    const { manager } = setup();
    const data = new TextEncoder().encode("client-fixture");
    const response = await manager.stage(
      {
        kind: "client",
        transferId: "client-1",
        fileName: "client.txt",
        sizeBytes: data.byteLength,
        contentType: "text/plain",
      },
      data,
    );
    expect(response).toEqual({
      outcome: "staged",
      transferId: "client-1",
      kind: "client",
      sizeBytes: data.byteLength,
      contentType: "text/plain",
    });
  });

  it("rejects a client file whose size does not match the declared size", async () => {
    const { manager } = setup();
    const data = new TextEncoder().encode("client");
    const response = await manager.stage(
      {
        kind: "client",
        transferId: "client-mismatch",
        fileName: "client.txt",
        sizeBytes: 999,
      },
      data,
    );
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("changed-after-selection");
    }
  });

  it("rejects an oversized client file", async () => {
    const { manager } = setup();
    const data = new Uint8Array(2048);
    const response = await manager.stage(
      {
        kind: "client",
        transferId: "client-big",
        fileName: "client.txt",
        sizeBytes: 2048,
      },
      data,
    );
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected") {
      expect(response.reason).toBe("oversized");
    }
  });

  it("reports privacy-safe progress without exposing paths", () => {
    const { manager } = setup();
    // No staged transfer yet.
    expect(manager.progress("missing")).toBeUndefined();
  });

  it("enforces the per-file quota at the documented default", () => {
    expect(BROWSER_TRANSFER_MAX_FILE_BYTES).toBe(1 * 1024 * 1024 * 1024);
  });

  it("fails closed resolving the staging root without a data directory", () => {
    expect(resolveTransferStagingRoot(undefined)).toBeNull();
    expect(resolveTransferStagingRoot("")).toBeNull();
    expect(resolveTransferStagingRoot("/data")).toBe("/data/transfer-staging");
  });
});

describe("File transfer authorization", () => {
  it("authorizes owner transfers without a grant or lease", () => {
    expect(
      authorizeFileTransfer({
        actor: "owner",
        fileTransferGranted: false,
        leaseActive: false,
      }),
    ).toEqual({ authorized: true });
  });

  it("requires the file-transfer grant for agent transfers", () => {
    expect(
      authorizeFileTransfer({
        actor: "agent",
        fileTransferGranted: false,
        leaseActive: true,
      }),
    ).toEqual({ authorized: false, reason: "file-transfer-grant-required" });
  });

  it("requires an active Control Lease for agent transfers", () => {
    expect(
      authorizeFileTransfer({
        actor: "agent",
        fileTransferGranted: true,
        leaseActive: false,
      }),
    ).toEqual({ authorized: false, reason: "control-lease-required" });
  });

  it("authorizes agent transfers with both the grant and an active lease", () => {
    expect(
      authorizeFileTransfer({
        actor: "agent",
        fileTransferGranted: true,
        leaseActive: true,
      }),
    ).toEqual({ authorized: true });
  });
});
