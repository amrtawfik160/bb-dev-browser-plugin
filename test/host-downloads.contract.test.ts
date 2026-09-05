import { describe, expect, it } from "vitest";
import {
  BROWSER_DOWNLOAD_MAX_FILE_BYTES,
  BROWSER_DOWNLOAD_MAX_PROFILE_BYTES,
  BROWSER_DOWNLOAD_TTL_MS,
} from "../src/shared/contracts.js";
import {
  authorizeDownloadExport,
  createHostDownloadsManager,
  normalizeDownloadName,
  resolveHostDownloadsRoot,
  type HostDownloadFilesystem,
  type TransferStagingStat,
} from "../src/host/host-downloads.js";

/**
 * In-memory Host Downloads filesystem. Resolves realpaths, reports narrow
 * stats, models 0600/0700 modes as flags, and supports appendFile/readFile so
 * streaming downloads and client export are deterministic. `available` controls
 * the low-disk guard; `appendFails`/`copyFails` force failures for the
 * interrupted-download and failed-export paths.
 */
type FakeEntry = {
  kind: "file" | "directory" | "special" | "symlink";
  content?: Uint8Array;
  target?: string;
  mtimeNs: bigint;
  mode?: number;
};
function createFakeFilesystem(
  options: {
    available?: number;
    appendFails?: boolean;
    copyFails?: boolean;
    failReadAfter?: number;
  } = {},
) {
  const entries = new Map<string, FakeEntry>();
  let available = options.available ?? Number.POSITIVE_INFINITY;
  let readCount = 0;
  const disposed = false;
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
  const fs: HostDownloadFilesystem = {
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
      return stat;
    },
    async copyFile(source, destination) {
      if (options.copyFails) throw new Error("copy failed");
      const resolved = realpath(source);
      const entry = entries.get(resolved);
      if (entry?.kind !== "file") throw new Error("not a file");
      entries.set(normalize(destination), {
        kind: "file",
        content: entry.content!.slice(),
        mtimeNs: entry.mtimeNs,
        mode: 0o600,
      });
    },
    async writeFile(path, data, mode) {
      entries.set(normalize(path), {
        kind: "file",
        content: data.slice(),
        mtimeNs: 1_000_000n,
        mode,
      });
    },
    async appendFile(path, data) {
      if (options.appendFails) throw new Error("append failed");
      const key = normalize(path);
      const entry = entries.get(key);
      if (entry?.kind !== "file") throw new Error("not a file");
      const combined = new Uint8Array(
        entry.content!.byteLength + data.byteLength,
      );
      combined.set(entry.content!, 0);
      combined.set(data, entry.content!.byteLength);
      entries.set(key, { ...entry, content: combined, mtimeNs: entry.mtimeNs });
    },
    async readFile(path) {
      const resolved = realpath(path);
      const entry = entries.get(resolved);
      if (entry?.kind !== "file") throw new Error("not a file");
      readCount += 1;
      if (
        options.failReadAfter !== undefined &&
        readCount > options.failReadAfter
      ) {
        throw new Error("read failed");
      }
      return entry.content!.slice();
    },
    async mkdir(path, mode) {
      entries.set(normalize(path), {
        kind: "directory",
        mtimeNs: 1_000_000n,
        mode,
      });
    },
    async chmod(path, mode) {
      const resolved = realpath(path);
      const entry = entries.get(resolved);
      if (entry !== undefined) entries.set(resolved, { ...entry, mode });
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
  function content(path: string): Uint8Array | undefined {
    const entry = entries.get(normalize(path));
    return entry?.kind === "file" ? entry.content : undefined;
  }
  function mode(path: string): number | undefined {
    return entries.get(normalize(path))?.mode;
  }
  function setAvailable(bytes: number) {
    available = bytes;
  }
  return { fs, put, has, content, mode, setAvailable };
}

const OWNER = {
  actor: "owner" as const,
  leaseActive: false,
};
const AGENT_AUTHORIZED = {
  actor: "agent" as const,
  leaseActive: true,
};

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now };
  const fake = createFakeFilesystem();
  const manager = createHostDownloadsManager({
    filesystem: fake.fs,
    quarantineRoot: "/q",
    clock,
    maxFileBytes: 1024,
    maxProfileBytes: 4096,
    expiryMs: 60_000,
    lowDiskMarginBytes: 1024,
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

const PAYLOAD = new TextEncoder().encode("deterministic-download");

async function stageDownload(
  manager: ReturnType<typeof createHostDownloadsManager>,
  overrides: Partial<{
    downloadId: string;
    profileId: string;
    suggestedName: string;
    totalBytes: number | null;
  }> = {},
) {
  const id = overrides.downloadId ?? "download-1";
  const start = await manager.startDownload({
    downloadId: id,
    profileId: overrides.profileId ?? "p1",
    suggestedName: overrides.suggestedName ?? "report.pdf",
    contentType: "application/pdf",
    totalBytes: overrides.totalBytes ?? PAYLOAD.byteLength,
  });
  if (start.outcome !== "quarantined")
    throw new Error(`start failed: ${JSON.stringify(start)}`);
  await manager.appendChunk({
    hostId: "h1",
    downloadId: id,
    data: Buffer.from(PAYLOAD).toString("base64"),
    chunkBytes: PAYLOAD.byteLength,
  });
  await manager.completeDownload({ hostId: "h1", downloadId: id });
  return id;
}

describe("Host Downloads name normalization", () => {
  it("strips path separators and traversal", () => {
    expect(normalizeDownloadName("../../etc/passwd")).toBe("etc passwd");
    expect(normalizeDownloadName("a/b/c.txt")).toBe("a b c.txt");
  });

  it("strips control characters and NUL", () => {
    expect(normalizeDownloadName("name\u0000.txt\u0007")).toBe("name.txt");
  });

  it("falls back to download for empty or dot-only names", () => {
    expect(normalizeDownloadName("")).toBe("download");
    expect(normalizeDownloadName("..")).toBe("download");
    expect(normalizeDownloadName("   ")).toBe("download");
  });

  it("truncates overlong names preserving a short extension", () => {
    const long = "a".repeat(300);
    const out = normalizeDownloadName(`${long}.txt`);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith(".txt")).toBe(true);
  });
});

describe("Host Downloads quarantine", () => {
  it("quarantines a completed download and reports privacy-safe metadata", async () => {
    const { manager } = setup();
    const id = await stageDownload(manager);
    const inspect = manager.inspect(id);
    expect(inspect).toMatchObject({
      phase: "quarantined",
      safeName: "report.pdf",
      sizeBytes: PAYLOAD.byteLength,
      contentType: "application/pdf",
    });
    // Privacy-safe listing never carries the quarantine path or file contents.
    const json = JSON.stringify(inspect);
    expect(json).not.toContain("/q/");
    expect(json).not.toContain("deterministic-download");
  });

  it("rejects an oversized declared download", async () => {
    const { manager } = setup();
    const response = await manager.startDownload({
      downloadId: "big",
      profileId: "p1",
      suggestedName: "big.bin",
      contentType: null,
      totalBytes: 2048,
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected")
      expect(response.reason).toBe("oversized");
  });

  it("rejects when the profile quota is full", async () => {
    const { manager } = setup();
    await manager.configureLimits({
      hostId: "h1",
      profileId: "p1",
      maxProfileBytes: PAYLOAD.byteLength * 2,
    });
    await stageDownload(manager, { downloadId: "d1" });
    await stageDownload(manager, {
      downloadId: "d2",
      suggestedName: "second.pdf",
    });
    const response = await manager.startDownload({
      downloadId: "d3",
      profileId: "p1",
      suggestedName: "third.pdf",
      contentType: null,
      totalBytes: PAYLOAD.byteLength,
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected")
      expect(response.reason).toBe("quota-exceeded");
  });

  it("refuses a download below the low-free-space threshold", async () => {
    const { fake, manager } = setup();
    fake.setAvailable(10);
    const response = await manager.startDownload({
      downloadId: "low",
      profileId: "p1",
      suggestedName: "low.bin",
      contentType: null,
      totalBytes: 100,
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected")
      expect(response.reason).toBe("low-disk");
  });

  it("enforces the per-file quota mid-stream (quota race)", async () => {
    const { manager } = setup();
    const start = await manager.startDownload({
      downloadId: "race",
      profileId: "p1",
      suggestedName: "race.bin",
      contentType: null,
      totalBytes: null,
    });
    expect(start.outcome).toBe("quarantined");
    const chunk = new Uint8Array(512);
    const first = await manager.appendChunk({
      hostId: "h1",
      downloadId: "race",
      data: Buffer.from(chunk).toString("base64"),
      chunkBytes: 512,
    });
    expect(first.outcome).toBe("appended");
    const overshoot = new Uint8Array(600);
    const second = await manager.appendChunk({
      hostId: "h1",
      downloadId: "race",
      data: Buffer.from(overshoot).toString("base64"),
      chunkBytes: 600,
    });
    expect(second.outcome).toBe("rejected");
    if (second.outcome === "rejected") expect(second.reason).toBe("oversized");
    // The overshot quarantine file is cleaned up.
    expect(manager.size()).toBe(0);
  });

  it("cleans up on an interrupted (failed) download and reports the real outcome", async () => {
    const { fake, manager } = setup();
    const id = await stageDownload(manager, { downloadId: "fail" });
    expect(fake.has("/q/p1/fail.pdf")).toBe(false);
    void id;
    const failed = await manager.failDownload({
      hostId: "h1",
      downloadId: "fail",
      reason: "network reset",
    });
    // S1 (issue #20 findings): the fail outcome carries the real result —
    // `failed`, the owning profile, and `removed: 1` — not a fabricated purge.
    expect(failed).toEqual({
      outcome: "failed",
      downloadId: "fail",
      profileId: "p1",
      removed: 1,
    });
    const missing = await manager.failDownload({
      hostId: "h1",
      downloadId: "absent",
      reason: "already gone",
    });
    expect(missing).toEqual({
      outcome: "missing",
      downloadId: "absent",
      profileId: null,
      removed: 0,
    });
    expect(manager.size()).toBe(0);
  });

  it("cleans up on owner cancellation", async () => {
    const { manager } = setup();
    const id = await stageDownload(manager, { downloadId: "cancel" });
    const outcome = await manager.cancelDownload({
      hostId: "h1",
      downloadId: id,
    });
    expect(outcome.outcome).toBe("cancelled");
    expect(manager.size()).toBe(0);
  });

  it("reaps expired downloads without following symlinks", async () => {
    const { manager, advance } = setup();
    const id = await stageDownload(manager, { downloadId: "expire" });
    advance(61_000);
    const { expired } = await manager.expire();
    expect(expired).toContain(id);
    expect(manager.size()).toBe(0);
  });

  it("purges only the targeted profile on reset without affecting siblings", async () => {
    const { manager } = setup();
    await stageDownload(manager, { downloadId: "a", profileId: "p1" });
    await stageDownload(manager, {
      downloadId: "b",
      profileId: "p2",
      suggestedName: "other.pdf",
    });
    const result = await manager.purge({ hostId: "h1", profileId: "p1" });
    expect(result.removed).toBe(1);
    expect(manager.inspect("b")?.phase).toBe("quarantined");
  });

  it("purges all profiles on worker restart / deleted profile", async () => {
    const { manager } = setup();
    await stageDownload(manager, { downloadId: "a", profileId: "p1" });
    await stageDownload(manager, {
      downloadId: "b",
      profileId: "p2",
      suggestedName: "x.pdf",
    });
    const result = await manager.purge({ hostId: "h1" });
    expect(result.removed).toBe(2);
    expect(manager.size()).toBe(0);
  });

  it("removes on-disk quarantine files on dispose", async () => {
    const { fake, manager } = setup();
    await stageDownload(manager, { downloadId: "d1" });
    await manager.dispose();
    expect(manager.size()).toBe(0);
    expect(fake.has("/q/p1/report.pdf")).toBe(false);
  });

  it("owns untrusted quarantine content with restrictive permissions (0600/0700)", async () => {
    const { fake, manager } = setup();
    await stageDownload(manager, { downloadId: "perms" });
    // The quarantine file is created with mode 0600 and the profile directory
    // with 0700; untrusted content is never world- or group-readable.
    expect(fake.mode("/q/p1/report.pdf")).toBe(0o600);
  });
});

describe("Host Downloads export", () => {
  it("exports a quarantined download to the displaying client (owner)", async () => {
    const { manager } = setup();
    const id = await stageDownload(manager);
    const outcome = await manager.exportToClient(
      { hostId: "h1", downloadId: id },
      OWNER,
    );
    expect(outcome.outcome).toBe("exported");
    if (outcome.outcome === "exported") {
      expect(outcome.destination).toBe("client");
      expect(outcome.safeName).toBe("report.pdf");
      expect(outcome.sizeBytes).toBe(PAYLOAD.byteLength);
      expect(new Uint8Array(Buffer.from(outcome.data!, "base64"))).toEqual(
        PAYLOAD,
      );
    }
  });

  it("requires an active Control Lease for agent client export", async () => {
    const { manager } = setup();
    const id = await stageDownload(manager);
    const outcome = await manager.exportToClient(
      { hostId: "h1", downloadId: id },
      { actor: "agent", leaseActive: false },
    );
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected")
      expect(outcome.reason).toBe("unauthorized");
  });

  it("authorizes agent client export with an active Control Lease", async () => {
    const { manager } = setup();
    const id = await stageDownload(manager);
    const outcome = await manager.exportToClient(
      { hostId: "h1", downloadId: id },
      AGENT_AUTHORIZED,
    );
    expect(outcome.outcome).toBe("exported");
  });

  it("exports a download into the workspace environment (owner)", async () => {
    const { fake, manager } = setup();
    fake.put("/env", { kind: "directory", mtimeNs: 1_000_000n });
    const id = await stageDownload(manager);
    const outcome = await manager.exportToWorkspace(
      {
        hostId: "h1",
        downloadId: id,
        environmentRoot: "/env",
        relativePath: "out/report.pdf",
      },
      OWNER,
      "/env",
    );
    expect(outcome.outcome).toBe("exported");
    if (outcome.outcome === "exported") {
      expect(outcome.destination).toBe("workspace");
      expect(fake.content("/env/out/report.pdf")).toEqual(PAYLOAD);
    }
  });

  it("requires separate overwrite confirmation for an existing workspace target", async () => {
    const { fake, manager } = setup();
    fake.put("/env", { kind: "directory", mtimeNs: 1_000_000n });
    fake.put("/env/out", { kind: "directory", mtimeNs: 1_000_000n });
    fake.put("/env/out/report.pdf", {
      kind: "file",
      content: new TextEncoder().encode("existing"),
      mtimeNs: 1_000_000n,
    });
    const id = await stageDownload(manager);
    const refused = await manager.exportToWorkspace(
      {
        hostId: "h1",
        downloadId: id,
        environmentRoot: "/env",
        relativePath: "out/report.pdf",
      },
      OWNER,
      "/env",
    );
    expect(refused.outcome).toBe("rejected");
    if (refused.outcome === "rejected") {
      expect(refused.reason).toBe("exists-without-confirmation");
    }
    // Existing file is untouched without confirmation.
    expect(fake.content("/env/out/report.pdf")).toEqual(
      new TextEncoder().encode("existing"),
    );
    const confirmed = await manager.exportToWorkspace(
      {
        hostId: "h1",
        downloadId: id,
        environmentRoot: "/env",
        relativePath: "out/report.pdf",
        overwriteConfirmed: true,
      },
      OWNER,
      "/env",
    );
    expect(confirmed.outcome).toBe("exported");
    expect(fake.content("/env/out/report.pdf")).toEqual(PAYLOAD);
  });

  it("rejects a workspace export that resolves outside the environment", async () => {
    const { fake, manager } = setup();
    fake.put("/env", { kind: "directory", mtimeNs: 1_000_000n });
    fake.put("/outside", { kind: "directory", mtimeNs: 1_000_000n });
    const id = await stageDownload(manager);
    const outcome = await manager.exportToWorkspace(
      {
        hostId: "h1",
        downloadId: id,
        environmentRoot: "/env",
        relativePath: "../outside/escape.pdf",
      },
      OWNER,
      "/env",
    );
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected") {
      expect(outcome.reason).toBe("outside-environment");
    }
  });

  it("requires an active Control Lease for agent workspace export", async () => {
    const { fake, manager } = setup();
    fake.put("/env", { kind: "directory", mtimeNs: 1_000_000n });
    const id = await stageDownload(manager);
    const outcome = await manager.exportToWorkspace(
      {
        hostId: "h1",
        downloadId: id,
        environmentRoot: "/env",
        relativePath: "out/report.pdf",
      },
      { actor: "agent", leaseActive: false },
      "/env",
    );
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected")
      expect(outcome.reason).toBe("unauthorized");
  });

  it("refuses to export a download that is not completed", async () => {
    const { manager } = setup();
    const start = await manager.startDownload({
      downloadId: "partial",
      profileId: "p1",
      suggestedName: "partial.bin",
      contentType: null,
      totalBytes: 10,
    });
    expect(start.outcome).toBe("quarantined");
    const outcome = await manager.exportToClient(
      { hostId: "h1", downloadId: "partial" },
      OWNER,
    );
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected") expect(outcome.reason).toBe("failed");
  });
});

describe("Host Downloads limits", () => {
  it("defaults to the documented quotas and expiry", () => {
    expect(BROWSER_DOWNLOAD_MAX_FILE_BYTES).toBe(1 * 1024 * 1024 * 1024);
    expect(BROWSER_DOWNLOAD_MAX_PROFILE_BYTES).toBe(5 * 1024 * 1024 * 1024);
    expect(BROWSER_DOWNLOAD_TTL_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it("lets the owner configure bounded limits", async () => {
    const { manager } = setup();
    const limits = await manager.configureLimits({
      hostId: "h1",
      profileId: "p1",
      maxFileBytes: 512,
      maxProfileBytes: 1024,
      expiryMs: 10_000,
    });
    expect(limits).toEqual({
      maxFileBytes: 512,
      maxProfileBytes: 1024,
      expiryMs: 10_000,
    });
    const response = await manager.startDownload({
      downloadId: "bounded",
      profileId: "p1",
      suggestedName: "bounded.bin",
      contentType: null,
      totalBytes: 700,
    });
    expect(response.outcome).toBe("rejected");
    if (response.outcome === "rejected")
      expect(response.reason).toBe("oversized");
  });

  it("clamps an over-bound configured limit to the safe ceiling", async () => {
    const { manager } = setup();
    const limits = await manager.configureLimits({
      hostId: "h1",
      profileId: "p1",
      maxFileBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(limits.maxFileBytes).toBeLessThanOrEqual(16 * 1024 * 1024 * 1024);
  });
});

describe("Host Downloads listing and progress", () => {
  it("lists only the requested profile and reports limits and free space", async () => {
    const { manager } = setup();
    await stageDownload(manager, { downloadId: "a", profileId: "p1" });
    await stageDownload(manager, {
      downloadId: "b",
      profileId: "p2",
      suggestedName: "other.pdf",
    });
    const result = await manager.listDownloads({
      hostId: "h1",
      profileId: "p1",
    });
    expect(result.downloads).toHaveLength(1);
    expect(result.downloads[0]!.downloadId).toBe("a");
    expect(result.limits).toMatchObject({ maxFileBytes: 1024 });
  });

  it("reports progress for an in-flight download", async () => {
    const { manager } = setup();
    await manager.startDownload({
      downloadId: "live",
      profileId: "p1",
      suggestedName: "live.bin",
      contentType: null,
      totalBytes: 100,
    });
    const progress = manager.progress("live");
    expect(progress).toMatchObject({
      downloadId: "live",
      phase: "downloading",
      bytesDownloaded: 0,
      totalBytes: 100,
    });
  });
});

describe("Host Downloads authorization", () => {
  it("authorizes owner export without a lease", () => {
    expect(
      authorizeDownloadExport({
        actor: "owner",
        leaseActive: false,
      }),
    ).toEqual({ authorized: true });
  });

  it("requires an active Control Lease for agent export", () => {
    // S2 (issue #20 findings): the host layer enforces the real Control Lease
    // for agent exports. The file-transfer grant is the single authoritative
    // gate in browser-service (the only layer with grant-store access); the
    // host cannot verify grants, so it does not fabricate them — it enforces
    // the lease it owns. A direct host-RPC caller without a real lease is
    // denied, never unconditionally authorized.
    expect(
      authorizeDownloadExport({
        actor: "agent",
        leaseActive: false,
      }),
    ).toEqual({ authorized: false, reason: "control-lease-required" });
    expect(
      authorizeDownloadExport({
        actor: "agent",
        leaseActive: true,
      }),
    ).toEqual({ authorized: true });
  });

  it("fails closed resolving the quarantine root without a data directory", () => {
    expect(resolveHostDownloadsRoot(undefined)).toBeNull();
    expect(resolveHostDownloadsRoot("")).toBeNull();
    expect(resolveHostDownloadsRoot("/data")).toBe("/data/host-downloads");
  });
});
