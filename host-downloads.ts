import {
  BROWSER_DOWNLOAD_DIR_MODE,
  BROWSER_DOWNLOAD_FILE_MODE,
  BROWSER_DOWNLOAD_LOW_DISK_MARGIN_BYTES,
  BROWSER_DOWNLOAD_MAX_FILE_BYTES,
  BROWSER_DOWNLOAD_MAX_FILE_BYTES_LIMIT,
  BROWSER_DOWNLOAD_MAX_PROFILE_BYTES,
  BROWSER_DOWNLOAD_MAX_PROFILE_BYTES_LIMIT,
  BROWSER_DOWNLOAD_MIN_LIMIT_BYTES,
  BROWSER_DOWNLOAD_TTL_MS,
  type BrowserDownloadAppendInput,
  type BrowserDownloadAppendOutcome,
  type BrowserDownloadCancelInput,
  type BrowserDownloadCancelOutcome,
  type BrowserDownloadCompleteInput,
  type BrowserDownloadCompleteOutcome,
  type BrowserDownloadExportActor,
  type BrowserDownloadExportClientInput,
  type BrowserDownloadExportOutcome,
  type BrowserDownloadExportWorkspaceInput,
  type BrowserDownloadFailInput,
  type BrowserDownloadFailOutcome,
  type BrowserDownloadListInput,
  type BrowserDownloadListResult,
  type BrowserDownloadListingEntry,
  type BrowserDownloadLimits,
  type BrowserDownloadLimitsInput,
  type BrowserDownloadPhase,
  type BrowserDownloadProgress,
  type BrowserDownloadPurgeInput,
  type BrowserDownloadPurgeOutcome,
  type BrowserDownloadRejection,
  type BrowserDownloadStartRequest,
  type BrowserDownloadStartResponse,
  type BrowserFileTransferDecision,
} from "./contracts.js";
import type { TransferStagingStat } from "./transfer-staging.js";
export type { TransferStagingStat };
import { createLowDiskGuard } from "./quarantine-guards.js";

/**
 * Filesystem effects for Host Downloads. Extends the Transfer Staging
 * filesystem (reused for realpath/stat/copyFile/writeFile/mkdir/chmod/rm/
 * availableBytes) with `appendFile` and `readFile` so a streaming download can
 * append chunks and a client export can read the quarantined bytes.
 */
export interface HostDownloadFilesystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<TransferStagingStat>;
  copyFile(source: string, destination: string): Promise<void>;
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  appendFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  availableBytes(path: string): Promise<number>;
}

/**
 * Host Downloads (issue #20, ADR 0009). Browser downloads enter a
 * profile-scoped Host Downloads quarantine owned by `bb-browser` with
 * restrictive permissions (0600 file / 0700 directory) and are never opened,
 * executed, or exported automatically. The owner may explicitly export a
 * quarantined download to the displaying client or workspace; an existing
 * workspace target requires a separate overwrite confirmation, and an agent
 * export additionally requires the file-transfer grant.
 *
 * This module is the authoritative policy and the quarantine store.
 * Filesystem and disk access are injected (reusing the same
 * {@link TransferStagingFilesystem} interface as Transfer Staging) so the
 * name-normalization, quota-race, low-disk, interrupted-download, expiry,
 * permission, export, and cleanup behavior is deterministic and testable
 * without a provisioned host. Cleanup never follows symlinks or affects
 * unrelated files: each download owns one regular file under a profile-scoped
 * directory, and only that exact path is removed.
 *
 * Defaults are 1 GiB per file, 5 GiB per profile, and a seven-day expiry, with
 * owner-configurable bounded limits. The real-host command path resolves the
 * quarantine root under `BB_BROWSER_HOST_DATA_DIR` and fails closed without
 * it (see {@link resolveHostDownloadsRoot}); this module never mutates the
 * host when the directory is absent because the caller refuses to construct
 * the manager first.
 */

export interface HostDownloadsOptions {
  filesystem: HostDownloadFilesystem;
  /** Absolute quarantine root. Caller derives it from a provisioned data dir. */
  quarantineRoot: string;
  clock?: { now(): number };
  id?: () => string;
  maxFileBytes?: number;
  maxProfileBytes?: number;
  expiryMs?: number;
  lowDiskMarginBytes?: number;
}

type DownloadRecord = {
  downloadId: string;
  profileId: string;
  safeName: string;
  contentType: string | null;
  totalBytes: number | null;
  bytesDownloaded: number;
  quarantinePath: string;
  createdAt: number;
  expiresAt: number;
  phase: BrowserDownloadPhase;
  error: string | null;
};

export interface HostDownloadExportAuthorization {
  actor: BrowserDownloadExportActor;
  /**
   * Real, host-verified Control Lease state. The host owns the Control Lease
   * manager, so it computes this from real state — it never trusts the caller
   * for it (issue #20 findings, S2).
   */
  leaseActive: boolean;
}

function rejection(
  downloadId: string,
  reason: BrowserDownloadRejection,
  message: string,
) {
  return {
    outcome: "rejected" as const,
    downloadId,
    reason,
    message,
  };
}

function isInsideEnvironment(resolved: string, root: string) {
  if (resolved === root) return true;
  return resolved.startsWith(`${root}/`);
}

/**
 * Lexically collapse `..`/`.` in `path` relative to `root`, returning the
 * resolved path when it stays inside `root` and `null` when it escapes.
 */
function collapseWithin(path: string, root: string): string | null {
  const rootParts = root.split("/").filter((part) => part !== "");
  const stack: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length <= rootParts.length) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const resolved = `/${stack.join("/")}`;
  return isInsideEnvironment(resolved, root) ? resolved : null;
}

/**
 * Normalize an untrusted suggested filename into a safe, single-segment
 * basename. Path separators, traversal, control characters, NUL, leading
 * dots/spaces, and overlong names are rejected or stripped; the result never
 * resolves above the profile directory and never contains a path separator. An
 * empty result falls back to `download` so a malicious or empty name cannot
 * collide with the directory or escape it.
 */
export function normalizeDownloadName(suggested: string): string {
  // Strip control characters and NUL first. Stripping control chars is
  // intentional (a malicious name cannot smuggle control bytes), so disable
  // the lint rule inline.
  // eslint-disable-next-line no-control-regex
  let name = suggested.replace(/[\u0000-\u001f\u007f]/gu, "");
  // Remove every path separator so the name cannot contain a segment.
  name = name.replace(/[/\\]+/gu, " ").trim();
  name = name.replace(/\s+/gu, " ").trim();
  // Reject leading dots so the result cannot be `.`/`..` or a hidden escape.
  name = name.replace(/^[.\s]+/u, "").replace(/[.\s]+$/u, "");
  if (name.length === 0) return "download";
  if (name === "." || name === "..") return "download";
  // Bound the length; preserve a short extension when present.
  if (name.length > 240) {
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 16) {
      const ext = name.slice(dot);
      name = name.slice(0, 240 - ext.length) + ext;
    } else {
      name = name.slice(0, 240);
    }
  }
  return name;
}

/** Resolve the host-local Host Downloads root from a data directory. */
export function resolveHostDownloadsRoot(dataDirectory: string | undefined) {
  if (dataDirectory === undefined || dataDirectory === "") return null;
  return `${dataDirectory}/host-downloads`;
}

/**
 * Decide whether `actor` may export a quarantined download at the host
 * layer. The owner always may because the owner already holds the browser; an
 * agent additionally needs an active Control Lease. The host owns the Control
 * Lease manager, so it passes the REAL lease state here — never a fabricated
 * `true` (issue #20 findings, S2).
 *
 * The file-transfer elevated grant is NOT enforced at this layer. The host
 * worker has no access to the grant store (it lives in the server-side browser
 * service, the only layer with grant-store access), so the host cannot verify
 * grants without fabricating them. The grant remains the single authoritative
 * gate in `authorizeAgentDownloadExport` (browser-service), which checks both
 * the grant and the lease before the host is ever called. Enforcing the real
 * lease here means a direct host-RPC caller claiming `actor: "agent"` without
 * a real active Control Lease is denied — it never gets unconditional
 * authorization.
 */
export function authorizeDownloadExport(
  authorization: HostDownloadExportAuthorization,
): BrowserFileTransferDecision {
  if (authorization.actor === "owner") {
    return { authorized: true };
  }
  if (!authorization.leaseActive) {
    return { authorized: false, reason: "control-lease-required" };
  }
  return { authorized: true };
}

export function createHostDownloadsManager(options: HostDownloadsOptions) {
  const filesystem = options.filesystem;
  const quarantineRoot = options.quarantineRoot;
  const clock = options.clock ?? { now: () => Date.now() };
  const defaultMaxFileBytes =
    options.maxFileBytes ?? BROWSER_DOWNLOAD_MAX_FILE_BYTES;
  const defaultMaxProfileBytes =
    options.maxProfileBytes ?? BROWSER_DOWNLOAD_MAX_PROFILE_BYTES;
  const defaultExpiryMs = options.expiryMs ?? BROWSER_DOWNLOAD_TTL_MS;
  const lowDiskMarginBytes =
    options.lowDiskMarginBytes ?? BROWSER_DOWNLOAD_LOW_DISK_MARGIN_BYTES;
  const downloads = new Map<string, DownloadRecord>();
  /** Name-collision index: profileId\u0000safeName → downloadId. */
  const byProfileName = new Map<string, string>();
  /** Owner-configured per-profile limits, bounded to safe ceilings. */
  const profileLimits = new Map<string, BrowserDownloadLimits>();
  let disposed = false;

  const guardLowDisk = createLowDiskGuard(
    filesystem,
    quarantineRoot,
    lowDiskMarginBytes,
    rejection,
    "low-disk",
  );

  function assertOpen() {
    if (disposed) {
      throw new Error("The Host Downloads manager has been disposed.");
    }
  }

  function limitsFor(profileId: string): BrowserDownloadLimits {
    const configured = profileLimits.get(profileId);
    return {
      maxFileBytes: configured?.maxFileBytes ?? defaultMaxFileBytes,
      maxProfileBytes: configured?.maxProfileBytes ?? defaultMaxProfileBytes,
      expiryMs: configured?.expiryMs ?? defaultExpiryMs,
    };
  }

  function profileBytes(profileId: string): number {
    let total = 0;
    for (const download of downloads.values()) {
      if (download.profileId !== profileId) continue;
      if (
        download.phase === "downloading" ||
        download.phase === "quarantined" ||
        download.phase === "exported"
      ) {
        total += download.bytesDownloaded;
      }
    }
    return total;
  }

  function quarantineProfileDir(profileId: string): string {
    return `${quarantineRoot}/${profileId}`;
  }

  function quarantineFilePath(profileId: string, safeName: string): string {
    return `${quarantineProfileDir(profileId)}/${safeName}`;
  }

  async function ensureProfileDir(profileId: string): Promise<string> {
    const dir = quarantineProfileDir(profileId);
    await filesystem.mkdir(dir, BROWSER_DOWNLOAD_DIR_MODE);
    return dir;
  }

  async function removeDownload(download: DownloadRecord) {
    // Remove only the exact quarantine file. Never recurse, never follow
    // symlinks, and never touch siblings: cleanup is path-exact.
    await filesystem.rm(download.quarantinePath, {
      recursive: false,
      force: true,
    });
  }

  function privacySafe(download: DownloadRecord): BrowserDownloadListingEntry {
    return {
      downloadId: download.downloadId,
      profileId: download.profileId,
      safeName: download.safeName,
      contentType: download.contentType,
      sizeBytes: download.bytesDownloaded,
      totalBytes: download.totalBytes,
      phase: download.phase,
      createdAt: new Date(download.createdAt).toISOString(),
      expiresAt: new Date(download.expiresAt).toISOString(),
      error: download.error,
    };
  }

  /**
   * Begin a download into quarantine. The suggested name is normalized
   * safely, the per-file and per-profile quotas and low-disk refusal apply, and
   * the quarantine file is created with restrictive permissions. The download
   * is never opened, executed, or exported automatically.
   */
  async function startDownload(
    request: BrowserDownloadStartRequest,
  ): Promise<BrowserDownloadStartResponse> {
    assertOpen();
    const limits = limitsFor(request.profileId);
    const safeName = normalizeDownloadName(request.suggestedName);
    if (
      request.totalBytes !== null &&
      request.totalBytes > limits.maxFileBytes
    ) {
      return rejection(
        request.downloadId,
        "oversized",
        "The download exceeds the per-file quarantine limit.",
      );
    }
    if (profileBytes(request.profileId) >= limits.maxProfileBytes) {
      return rejection(
        request.downloadId,
        "quota-exceeded",
        "The profile quarantine quota is full.",
      );
    }
    const lowDisk = await guardLowDisk(
      request.downloadId,
      request.totalBytes ?? 0,
    );
    if (lowDisk !== undefined) return lowDisk;
    let dir: string;
    try {
      dir = await ensureProfileDir(request.profileId);
    } catch (error) {
      return rejection(
        request.downloadId,
        "low-disk",
        error instanceof Error
          ? error.message
          : "The quarantine directory could not be created.",
      );
    }
    // Choose a non-colliding safe name within the profile directory so a
    // repeated suggested name does not overwrite an unrelated quarantined
    // file. Collision is resolved by appending a short suffix.
    let safeNameFinal = safeName;
    let suffix = 0;
    while (
      byProfileName.has(`${request.profileId}\u0000${safeNameFinal}`) ||
      (await pathExists(quarantineFilePath(request.profileId, safeNameFinal)))
    ) {
      suffix += 1;
      safeNameFinal = addNameSuffix(safeName, suffix);
      if (suffix > 999) {
        return rejection(
          request.downloadId,
          "invalid-name",
          "A safe quarantine name could not be allocated.",
        );
      }
    }
    const path = `${dir}/${safeNameFinal}`;
    try {
      await filesystem.writeFile(
        path,
        new Uint8Array(0),
        BROWSER_DOWNLOAD_FILE_MODE,
      );
    } catch (error) {
      return rejection(
        request.downloadId,
        "low-disk",
        error instanceof Error
          ? error.message
          : "The quarantine file could not be created.",
      );
    }
    const now = clock.now();
    const record: DownloadRecord = {
      downloadId: request.downloadId,
      profileId: request.profileId,
      safeName: safeNameFinal,
      contentType: request.contentType,
      totalBytes: request.totalBytes,
      bytesDownloaded: 0,
      quarantinePath: path,
      createdAt: now,
      expiresAt: now + limits.expiryMs,
      phase: "downloading",
      error: null,
    };
    downloads.set(request.downloadId, record);
    byProfileName.set(
      `${request.profileId}\u0000${safeNameFinal}`,
      request.downloadId,
    );
    return {
      outcome: "quarantined",
      downloadId: request.downloadId,
      safeName: safeNameFinal,
    };
  }

  async function pathExists(path: string): Promise<boolean> {
    try {
      await filesystem.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  function addNameSuffix(name: string, suffix: number): string {
    const dot = name.lastIndexOf(".");
    const tag = `-${suffix}`;
    if (dot > 0 && name.length - dot <= 16) {
      return `${name.slice(0, dot)}${tag}${name.slice(dot)}`;
    }
    return `${name}${tag}`;
  }

  /**
   * Append a chunk to an in-progress download. The per-file quota is enforced
   * on every chunk so a streaming download that overshoots is rejected and the
   * quarantine file is cleaned up (quota race). A mismatched chunk size is
   * rejected as a changed stream.
   */
  async function appendChunk(
    input: BrowserDownloadAppendInput,
  ): Promise<BrowserDownloadAppendOutcome> {
    assertOpen();
    const record = downloads.get(input.downloadId);
    if (record === undefined) {
      return rejection(
        input.downloadId,
        "not-found",
        "The download is not in quarantine.",
      );
    }
    if (record.phase !== "downloading") {
      return rejection(
        input.downloadId,
        "already-completed",
        "The download is no longer accepting bytes.",
      );
    }
    const data = new Uint8Array(Buffer.from(input.data, "base64"));
    if (data.byteLength !== input.chunkBytes) {
      return rejection(
        input.downloadId,
        "failed",
        "The chunk byte length does not match the decoded bytes.",
      );
    }
    const limits = limitsFor(record.profileId);
    const next = record.bytesDownloaded + data.byteLength;
    if (next > limits.maxFileBytes) {
      record.phase = "failed";
      record.error = "The download exceeded the per-file quarantine limit.";
      await removeDownload(record);
      downloads.delete(record.downloadId);
      byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
      return rejection(
        input.downloadId,
        "oversized",
        "The download exceeded the per-file quarantine limit.",
      );
    }
    if (
      profileBytes(record.profileId) + data.byteLength >
      limits.maxProfileBytes
    ) {
      record.phase = "failed";
      record.error = "The download exceeded the profile quarantine quota.";
      await removeDownload(record);
      downloads.delete(record.downloadId);
      byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
      return rejection(
        input.downloadId,
        "quota-exceeded",
        "The download exceeded the profile quarantine quota.",
      );
    }
    try {
      await filesystem.appendFile(record.quarantinePath, data);
    } catch (error) {
      record.phase = "failed";
      record.error =
        error instanceof Error
          ? error.message
          : "The quarantine file could not be written.";
      await removeDownload(record);
      downloads.delete(record.downloadId);
      byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
      return rejection(
        input.downloadId,
        "failed",
        "The quarantine file could not be written.",
      );
    }
    record.bytesDownloaded = next;
    return {
      outcome: "appended",
      downloadId: input.downloadId,
      bytesDownloaded: next,
    };
  }

  /**
   * Finalize a download. The quarantine file is chmod'd to 0600 and the phase
   * becomes `quarantined`. A finalized download is never opened or executed.
   */
  async function completeDownload(
    input: BrowserDownloadCompleteInput,
  ): Promise<BrowserDownloadCompleteOutcome> {
    assertOpen();
    const record = downloads.get(input.downloadId);
    if (record === undefined) {
      return { outcome: "missing", downloadId: input.downloadId };
    }
    if (record.phase !== "downloading") {
      return rejection(
        input.downloadId,
        "already-completed",
        "The download is no longer accepting bytes.",
      );
    }
    try {
      await filesystem.chmod(record.quarantinePath, BROWSER_DOWNLOAD_FILE_MODE);
    } catch {
      // chmod is best-effort on filesystems that do not model it.
    }
    record.phase = "quarantined";
    return { outcome: "quarantined", downloadId: input.downloadId };
  }

  /**
   * Fail a download: clean up the quarantine file and mark the record failed.
   * Called on an interrupted download or a host-reported failure. Returns the
   * real outcome (issue #20 findings, S1) — `failed` with the owning profile
   * and `removed: 1` when a record existed, `missing` with `removed: 0` and
   * `profileId: null` otherwise. Never fabricates a purge outcome.
   */
  async function failDownload(
    input: BrowserDownloadFailInput,
  ): Promise<BrowserDownloadFailOutcome> {
    const record = downloads.get(input.downloadId);
    if (record === undefined) {
      return {
        outcome: "missing",
        downloadId: input.downloadId,
        profileId: null,
        removed: 0,
      };
    }
    const profileId = record.profileId;
    record.phase = "failed";
    record.error = input.reason;
    await removeDownload(record);
    downloads.delete(record.downloadId);
    byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
    return {
      outcome: "failed",
      downloadId: input.downloadId,
      profileId,
      removed: 1,
    };
  }

  /**
   * Cancel a download at the controller's request, removing the quarantine
   * file. Distinct from failure: cancellation is an owner decision.
   */
  async function cancelDownload(
    input: BrowserDownloadCancelInput,
  ): Promise<BrowserDownloadCancelOutcome> {
    const record = downloads.get(input.downloadId);
    if (record === undefined) {
      return { outcome: "missing", downloadId: input.downloadId };
    }
    record.phase = "cancelled";
    await removeDownload(record);
    downloads.delete(record.downloadId);
    byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
    return { outcome: "cancelled", downloadId: input.downloadId };
  }

  function progress(downloadId: string): BrowserDownloadProgress | undefined {
    const record = downloads.get(downloadId);
    if (record === undefined) return undefined;
    return {
      downloadId,
      phase: record.phase,
      bytesDownloaded: record.bytesDownloaded,
      totalBytes: record.totalBytes,
    };
  }

  async function listDownloads(
    input: BrowserDownloadListInput,
  ): Promise<BrowserDownloadListResult> {
    const entries: BrowserDownloadListingEntry[] = [];
    for (const record of downloads.values()) {
      if (record.profileId !== input.profileId) continue;
      entries.push(privacySafe(record));
    }
    let freeSpaceBytes: number | null;
    try {
      const bytes = await filesystem.availableBytes(quarantineRoot);
      freeSpaceBytes = Number.isFinite(bytes) ? bytes : null;
    } catch {
      freeSpaceBytes = null;
    }
    return {
      downloads: entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      limits: limitsFor(input.profileId),
      freeSpaceBytes,
    };
  }

  /**
   * Configure owner-configurable bounded limits for a profile. Each supplied
   * limit is clamped to a safe ceiling so the owner cannot raise a limit past
   * the documented bound or below the minimum.
   */
  async function configureLimits(
    input: BrowserDownloadLimitsInput,
  ): Promise<BrowserDownloadLimits> {
    assertOpen();
    const current = limitsFor(input.profileId);
    const maxFileBytes = clampLimit(
      input.maxFileBytes ?? current.maxFileBytes,
      BROWSER_DOWNLOAD_MAX_FILE_BYTES_LIMIT,
    );
    const maxProfileBytes = clampLimit(
      input.maxProfileBytes ?? current.maxProfileBytes,
      BROWSER_DOWNLOAD_MAX_PROFILE_BYTES_LIMIT,
    );
    const expiryMs = input.expiryMs ?? current.expiryMs;
    const limits: BrowserDownloadLimits = {
      maxFileBytes,
      maxProfileBytes,
      expiryMs,
    };
    profileLimits.set(input.profileId, limits);
    return limits;
  }

  function clampLimit(value: number, ceiling: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return BROWSER_DOWNLOAD_MIN_LIMIT_BYTES;
    }
    return Math.max(BROWSER_DOWNLOAD_MIN_LIMIT_BYTES, Math.min(value, ceiling));
  }

  /**
   * Shared export preamble (issue #20 findings, S5): assert the manager is
   * open, authorize the actor against the real Control Lease, look up the
   * quarantine record, and verify it is in an exportable phase. Returns the
   * resolved record when the export may proceed, or a rejection outcome
   * otherwise. Both `exportToClient` and `exportToWorkspace` route through
   * this so the authorize → get → phase-check sequence stays identical.
   */
  function resolveExportable(
    downloadId: string,
    authorization: HostDownloadExportAuthorization,
  ): { record: DownloadRecord } | { rejection: BrowserDownloadExportOutcome } {
    assertOpen();
    const decision = authorizeDownloadExport(authorization);
    if (!decision.authorized) {
      return {
        rejection: rejection(
          downloadId,
          "unauthorized",
          "Agent export requires an active Control Lease.",
        ),
      };
    }
    const record = downloads.get(downloadId);
    if (record === undefined) {
      return {
        rejection: rejection(
          downloadId,
          "not-found",
          "The download is not in quarantine.",
        ),
      };
    }
    if (record.phase !== "quarantined" && record.phase !== "exported") {
      return {
        rejection: rejection(
          downloadId,
          "failed",
          "Only a completed download may be exported.",
        ),
      };
    }
    return { record };
  }

  /**
   * Export a quarantined download to the displaying client. The bytes leave
   * quarantine only on this explicit owner decision; the quarantine file
   * remains for later expiry or deletion. Agent export requires an active
   * Control Lease (the file-transfer grant is enforced by browser-service).
   */
  async function exportToClient(
    input: BrowserDownloadExportClientInput,
    authorization: HostDownloadExportAuthorization,
  ): Promise<BrowserDownloadExportOutcome> {
    const resolved = resolveExportable(input.downloadId, authorization);
    if ("rejection" in resolved) return resolved.rejection;
    const record = resolved.record;
    const data = await readQuarantineBytes(record);
    if (data === null) {
      return rejection(
        input.downloadId,
        "failed",
        "The quarantine file could not be read for export.",
      );
    }
    record.phase = "exported";
    return {
      outcome: "exported",
      downloadId: input.downloadId,
      destination: "client",
      safeName: record.safeName,
      contentType: record.contentType,
      sizeBytes: record.bytesDownloaded,
      data: Buffer.from(data).toString("base64"),
    };
  }

  /**
   * Export a quarantined download into the workspace environment. The target
   * resolves through BB's environment file API and must remain inside the
   * environment after realpath resolution; an existing target requires a
   * separate overwrite confirmation, and agent export requires an active
   * Control Lease (the file-transfer grant is enforced by browser-service).
   * The quarantine file remains for later expiry.
   */
  async function exportToWorkspace(
    input: BrowserDownloadExportWorkspaceInput,
    authorization: HostDownloadExportAuthorization,
    environmentRoot: string,
  ): Promise<BrowserDownloadExportOutcome> {
    const resolved = resolveExportable(input.downloadId, authorization);
    if ("rejection" in resolved) return resolved.rejection;
    const record = resolved.record;
    let resolvedRoot: string;
    try {
      resolvedRoot = await filesystem.realpath(environmentRoot);
    } catch {
      return rejection(
        input.downloadId,
        "outside-environment",
        "The environment root does not exist.",
      );
    }
    // Compose the target by joining the resolved root with the relative path
    // after collapsing `..`/`.` lexically. This stays inside the environment
    // when the relative path does not traverse above it.
    const relative = input.relativePath.replace(/^[\\/]+/u, "");
    const composed = `${resolvedRoot}/${relative}`;
    const lexicalTarget = collapseWithin(composed, resolvedRoot);
    if (lexicalTarget === null) {
      return rejection(
        input.downloadId,
        "outside-environment",
        "The export target resolves outside the environment.",
      );
    }
    // If the target already exists, realpath it so a symlink cannot escape the
    // environment. A non-existent target uses the lexical check above.
    let resolvedTarget = lexicalTarget;
    let exists = false;
    try {
      const real = await filesystem.realpath(lexicalTarget);
      if (!isInsideEnvironment(real, resolvedRoot)) {
        return rejection(
          input.downloadId,
          "outside-environment",
          "The export target resolves outside the environment.",
        );
      }
      resolvedTarget = real;
      const targetStat = await filesystem.stat(real);
      exists = targetStat.isFile;
    } catch {
      // Target does not exist; `exists` keeps its prior (false) value.
    }
    if (exists && input.overwriteConfirmed !== true) {
      return rejection(
        input.downloadId,
        "exists-without-confirmation",
        "The workspace target exists and requires separate overwrite confirmation.",
      );
    }
    const parentDir = resolvedTarget.slice(0, resolvedTarget.lastIndexOf("/"));
    if (parentDir !== "" && parentDir !== resolvedRoot) {
      try {
        await filesystem.mkdir(parentDir, BROWSER_DOWNLOAD_DIR_MODE);
      } catch {
        // Parent may already exist; the copy below reports a real failure.
      }
    }
    try {
      await filesystem.copyFile(record.quarantinePath, resolvedTarget);
      await filesystem.chmod(resolvedTarget, BROWSER_DOWNLOAD_FILE_MODE);
    } catch {
      return rejection(
        input.downloadId,
        "failed",
        "The download could not be copied into the workspace.",
      );
    }
    record.phase = "exported";
    return {
      outcome: "exported",
      downloadId: input.downloadId,
      destination: "workspace",
      safeName: record.safeName,
      contentType: record.contentType,
      sizeBytes: record.bytesDownloaded,
    };
  }

  async function readQuarantineBytes(
    record: DownloadRecord,
  ): Promise<Uint8Array | null> {
    try {
      return await filesystem.readFile(record.quarantinePath);
    } catch {
      return null;
    }
  }

  /** Reap downloads whose quarantine lease has expired. */
  async function expire(): Promise<{ expired: string[] }> {
    const now = clock.now();
    const expired: string[] = [];
    for (const record of [...downloads.values()]) {
      if (record.phase === "cancelled" || record.phase === "failed") continue;
      if (record.expiresAt <= now) {
        record.phase = "expired";
        await removeDownload(record);
        downloads.delete(record.downloadId);
        byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
        expired.push(record.downloadId);
      }
    }
    return { expired };
  }

  /**
   * Remove every download for a profile (or all profiles). Called on a profile
   * reset, archived-profile expiry, deleted-profile, or worker restart so
   * leftover quarantine data never persists. Never follows symlinks or affects
   * unrelated files: only the exact quarantine file for each record is removed.
   */
  async function purge(
    input: BrowserDownloadPurgeInput,
  ): Promise<BrowserDownloadPurgeOutcome> {
    const targetProfile = input.profileId ?? null;
    let removed = 0;
    for (const record of [...downloads.values()]) {
      if (targetProfile !== null && record.profileId !== targetProfile) {
        continue;
      }
      await removeDownload(record);
      downloads.delete(record.downloadId);
      byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
      removed += 1;
    }
    return {
      outcome: "purged",
      profileId: targetProfile,
      removed,
    };
  }

  /**
   * Tear down the manager: remove every quarantine file on disk and clear the
   * in-memory index so leftover quarantine data never persists. Called on
   * worker shutdown; profile lifecycle operations use {@link purge}.
   */
  async function dispose(): Promise<void> {
    disposed = true;
    for (const record of [...downloads.values()]) {
      await removeDownload(record).catch(() => undefined);
      downloads.delete(record.downloadId);
      byProfileName.delete(`${record.profileId}\u0000${record.safeName}`);
    }
    downloads.clear();
    byProfileName.clear();
  }

  return {
    startDownload,
    appendChunk,
    completeDownload,
    failDownload,
    cancelDownload,
    progress,
    listDownloads,
    configureLimits,
    exportToClient,
    exportToWorkspace,
    expire,
    purge,
    dispose,
    /** Test/inspection only: the count of currently quarantined downloads. */
    size(): number {
      return downloads.size;
    },
    /** Test/inspection only: a privacy-safe view of a record. */
    inspect(downloadId: string): BrowserDownloadListingEntry | undefined {
      const record = downloads.get(downloadId);
      return record === undefined ? undefined : privacySafe(record);
    },
  };
}

export type HostDownloadsManager = ReturnType<
  typeof createHostDownloadsManager
>;
