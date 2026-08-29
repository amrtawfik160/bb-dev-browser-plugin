import {
  BROWSER_TRANSFER_LOW_DISK_MARGIN_BYTES,
  BROWSER_TRANSFER_MAX_FILE_BYTES,
  BROWSER_TRANSFER_STAGING_DIR_MODE,
  BROWSER_TRANSFER_STAGING_FILE_MODE,
  BROWSER_TRANSFER_STAGING_TTL_MS,
  type BrowserFileTransferAuthorization,
  type BrowserFileTransferDecision,
  type BrowserTransferProgress,
  type BrowserTransferRejection,
  type BrowserTransferStagingRequest,
  type BrowserTransferStagingResponse,
} from "./contracts.js";
import {
  createCleanupAndReject,
  createLowDiskGuard,
} from "./quarantine-guards.js";

/**
 * Transfer Staging (issue #19, ADR 0011). The `bb-browser` user receives no
 * direct repository access: an explicitly selected workspace upload is
 * resolved through BB's environment file API, must remain inside the
 * environment after realpath resolution, and is copied into one-use Transfer
 * Staging with narrow permissions. A displaying-client upload is copied
 * through the active browser file chooser into the same one-use staging. In
 * both cases the staged file is removed after use, cancellation, failure,
 * expiry, worker restart, or profile lifecycle operations.
 *
 * This module is the authoritative policy and one-use store. Filesystem and
 * disk access are injected so the containment, symlink, special-file,
 * changed-after-selection, oversized, low-disk, quota, and cleanup behavior is
 * deterministic and testable without a provisioned host. The real-host command
 * path resolves the staging root under `BB_BROWSER_HOST_DATA_DIR` and fails
 * closed without it; this module never mutates the host when the directory is
 * absent because the caller refuses to construct the staging root first.
 */

export type TransferStagingActor = "owner" | "agent";

export interface TransferStagingStat {
  sizeBytes: number;
  mtimeNs: bigint;
  isFile: boolean;
  isDirectory: boolean;
  isSpecial: boolean;
}

export interface TransferStagingFilesystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<TransferStagingStat>;
  copyFile(source: string, destination: string): Promise<void>;
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  /** Bytes available on the filesystem holding `path`. */
  availableBytes(path: string): Promise<number>;
}

export interface TransferStagingOptions {
  filesystem: TransferStagingFilesystem;
  /** Absolute staging root. Caller must derive it from a provisioned data dir. */
  stagingRoot: string;
  clock?: { now(): number };
  id?: () => string;
  maxFileBytes?: number;
  lowDiskMarginBytes?: number;
  ttlMs?: number;
}

type StagedTransfer = {
  transferId: string;
  kind: "client" | "workspace";
  stagedPath: string;
  sizeBytes: number;
  contentType: string | null;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  cancelled: boolean;
  failed: boolean;
  selectionFingerprint?: { sizeBytes: number; mtimeNs: bigint };
};

const notFoundRejection = (
  transferId: string,
): BrowserTransferStagingResponse => ({
  outcome: "rejected",
  transferId,
  reason: "not-found",
  message: "The selected workspace file does not exist.",
});

function rejection(
  transferId: string,
  reason: BrowserTransferRejection,
  message: string,
): BrowserTransferStagingResponse {
  return { outcome: "rejected", transferId, reason, message };
}

function privacySafe(transfer: StagedTransfer): BrowserTransferStagingResponse {
  return {
    outcome: "staged",
    transferId: transfer.transferId,
    kind: transfer.kind,
    sizeBytes: transfer.sizeBytes,
    contentType: transfer.contentType,
  };
}

/**
 * Decide whether `actor` may initiate a file transfer. An owner always may
 * because the owner already holds the browser; an agent additionally needs
 * the file-transfer elevated grant and an active Control Lease. The decision
 * is privacy-safe and never echoes paths.
 */
export function authorizeFileTransfer(
  authorization: BrowserFileTransferAuthorization,
): BrowserFileTransferDecision {
  if (authorization.actor === "owner") {
    return { authorized: true };
  }
  if (!authorization.fileTransferGranted) {
    return { authorized: false, reason: "file-transfer-grant-required" };
  }
  if (!authorization.leaseActive) {
    return { authorized: false, reason: "control-lease-required" };
  }
  return { authorized: true };
}

function isInsideEnvironment(resolved: string, root: string) {
  if (resolved === root) return true;
  return resolved.startsWith(`${root}/`);
}

export function createTransferStagingManager(options: TransferStagingOptions) {
  const filesystem = options.filesystem;
  const stagingRoot = options.stagingRoot;
  const clock = options.clock ?? { now: () => Date.now() };
  const maxFileBytes = options.maxFileBytes ?? BROWSER_TRANSFER_MAX_FILE_BYTES;
  const lowDiskMarginBytes =
    options.lowDiskMarginBytes ?? BROWSER_TRANSFER_LOW_DISK_MARGIN_BYTES;
  const ttlMs = options.ttlMs ?? BROWSER_TRANSFER_STAGING_TTL_MS;
  const staged = new Map<string, StagedTransfer>();
  let disposed = false;

  function assertOpen() {
    if (disposed) {
      throw new Error("The Transfer Staging manager has been disposed.");
    }
  }

  async function stagePath(transferId: string): Promise<string> {
    const path = `${stagingRoot}/${transferId}`;
    await filesystem.mkdir(stagingRoot, BROWSER_TRANSFER_STAGING_DIR_MODE);
    return path;
  }

  async function removeStaged(transfer: StagedTransfer) {
    await filesystem.rm(transfer.stagedPath, { recursive: true, force: true });
  }

  // Shared low-disk guard and staged-copy cleanup (issues #19/#20). The
  // helpers live in `quarantine-guards.js` so Transfer Staging and Host
  // Downloads do not duplicate the low-free-space refusal or staged-copy
  // cleanup behavior; both brokers inject the same filesystem and supply a
  // rejection constructor.
  const guardLowDisk = createLowDiskGuard(
    filesystem,
    stagingRoot,
    lowDiskMarginBytes,
    rejection,
    "low-disk",
  );
  const cleanupAndReject = createCleanupAndReject(filesystem, rejection);

  /**
   * Stage an explicitly selected workspace file. The selection must remain
   * inside `environmentRoot` after realpath resolution, must be a regular
   * file, and must not change between selection and copy. Traversal, symlink
   * escape, special files, oversized files, and low-disk conditions fail
   * closed; the staged copy is removed on any rejection after staging began.
   */
  async function stageWorkspaceFile(
    request: Extract<BrowserTransferStagingRequest, { kind: "workspace" }>,
  ): Promise<BrowserTransferStagingResponse> {
    assertOpen();
    const { transferId, sourcePath, environmentRoot, contentType } = request;
    if (disposed) {
      return rejection(
        transferId,
        "cancelled",
        "The Transfer Staging manager is shutting down.",
      );
    }
    let resolvedRoot: string;
    let resolvedSource: string;
    try {
      resolvedRoot = await filesystem.realpath(environmentRoot);
    } catch {
      return rejection(
        transferId,
        "outside-environment",
        "The environment root does not exist.",
      );
    }
    try {
      resolvedSource = await filesystem.realpath(sourcePath);
    } catch {
      return notFoundRejection(transferId);
    }
    if (!isInsideEnvironment(resolvedSource, resolvedRoot)) {
      return rejection(
        transferId,
        "symlink-escape",
        "The selected file resolves outside the environment after realpath resolution.",
      );
    }
    let selectionStat: TransferStagingStat;
    try {
      selectionStat = await filesystem.stat(resolvedSource);
    } catch {
      return notFoundRejection(transferId);
    }
    if (!selectionStat.isFile || selectionStat.isSpecial) {
      return rejection(
        transferId,
        "special-file",
        "Only regular files may be staged.",
      );
    }
    if (selectionStat.sizeBytes > maxFileBytes) {
      return rejection(
        transferId,
        "oversized",
        "The selected file exceeds the per-file transfer quota.",
      );
    }
    const lowDisk = await guardLowDisk(transferId, selectionStat.sizeBytes);
    if (lowDisk !== undefined) return lowDisk;
    let destination: string;
    try {
      destination = await stagePath(transferId);
    } catch (error) {
      return rejection(
        transferId,
        "low-disk",
        error instanceof Error
          ? error.message
          : "The staging directory could not be created.",
      );
    }
    let transfer: StagedTransfer | undefined;
    try {
      await filesystem.copyFile(resolvedSource, destination);
      const afterStat = await filesystem.stat(resolvedSource);
      if (
        afterStat.sizeBytes !== selectionStat.sizeBytes ||
        afterStat.mtimeNs !== selectionStat.mtimeNs
      ) {
        return cleanupAndReject(
          transferId,
          destination,
          "changed-after-selection",
          "The selected file changed between selection and staging.",
        );
      }
      const copiedStat = await filesystem.stat(destination);
      if (!copiedStat.isFile) {
        return cleanupAndReject(
          transferId,
          destination,
          "special-file",
          "The staged copy is not a regular file.",
        );
      }
      if (copiedStat.sizeBytes > maxFileBytes) {
        return cleanupAndReject(
          transferId,
          destination,
          "oversized",
          "The staged copy exceeds the per-file transfer quota.",
        );
      }
      await filesystem.chmod(destination, BROWSER_TRANSFER_STAGING_FILE_MODE);
      const now = clock.now();
      transfer = {
        transferId,
        kind: "workspace",
        stagedPath: destination,
        sizeBytes: copiedStat.sizeBytes,
        contentType: contentType ?? null,
        createdAt: now,
        expiresAt: now + ttlMs,
        used: false,
        cancelled: false,
        failed: false,
        selectionFingerprint: {
          sizeBytes: selectionStat.sizeBytes,
          mtimeNs: selectionStat.mtimeNs,
        },
      };
      staged.set(transferId, transfer);
      return privacySafe(transfer);
    } catch {
      return cleanupAndReject(
        transferId,
        destination,
        "low-disk",
        "The selected file could not be copied into Transfer Staging.",
      );
    }
  }

  /**
   * Stage a displaying-client file received through the active browser file
   * chooser. The browser operating-system user never receives repository
   * access; the bytes are written into one-use staging with narrow
   * permissions and the same quota and low-disk guards.
   */
  async function stageClientFile(
    request: Extract<BrowserTransferStagingRequest, { kind: "client" }> & {
      data: Uint8Array;
    },
  ): Promise<BrowserTransferStagingResponse> {
    assertOpen();
    const { transferId, fileName, contentType, sizeBytes, data } = request;
    if (disposed) {
      return rejection(
        transferId,
        "cancelled",
        "The Transfer Staging manager is shutting down.",
      );
    }
    if (sizeBytes > maxFileBytes) {
      return rejection(
        transferId,
        "oversized",
        "The client file exceeds the per-file transfer quota.",
      );
    }
    if (data.byteLength !== sizeBytes) {
      return rejection(
        transferId,
        "changed-after-selection",
        "The client file size does not match the declared size.",
      );
    }
    const lowDisk = await guardLowDisk(transferId, sizeBytes);
    if (lowDisk !== undefined) return lowDisk;
    let destination: string;
    try {
      destination = await stagePath(transferId);
    } catch (error) {
      return rejection(
        transferId,
        "low-disk",
        error instanceof Error
          ? error.message
          : "The staging directory could not be created.",
      );
    }
    try {
      await filesystem.writeFile(
        destination,
        data,
        BROWSER_TRANSFER_STAGING_FILE_MODE,
      );
      const copiedStat = await filesystem.stat(destination);
      if (!copiedStat.isFile || copiedStat.sizeBytes !== sizeBytes) {
        return cleanupAndReject(
          transferId,
          destination,
          "changed-after-selection",
          "The staged client file does not match the declared size.",
        );
      }
      const now = clock.now();
      const transfer: StagedTransfer = {
        transferId,
        kind: "client",
        stagedPath: destination,
        sizeBytes,
        contentType: contentType ?? null,
        createdAt: now,
        expiresAt: now + ttlMs,
        used: false,
        cancelled: false,
        failed: false,
        // `fileName` is intentionally not retained on the staged record; only
        // privacy-safe metadata is kept and the source filename never leaves
        // the panel through this broker.
      };
      void fileName;
      staged.set(transferId, transfer);
      return privacySafe(transfer);
    } catch {
      return cleanupAndReject(
        transferId,
        destination,
        "low-disk",
        "The client file could not be written into Transfer Staging.",
      );
    }
  }

  async function stage(
    request: BrowserTransferStagingRequest,
    clientData?: Uint8Array,
  ): Promise<BrowserTransferStagingResponse> {
    if (request.kind === "workspace") return stageWorkspaceFile(request);
    if (clientData === undefined) {
      return rejection(
        request.transferId,
        "changed-after-selection",
        "Client uploads require the file bytes from the active file chooser.",
      );
    }
    return stageClientFile({ ...request, data: clientData });
  }

  /**
   * Consume a staged transfer for browser use. The staged file is removed
   * immediately after the browser reads it; the outcome is privacy-safe.
   */
  async function consume(transferId: string): Promise<{
    outcome: "used" | "missing" | "already-used";
    stagedPath?: string;
  }> {
    assertOpen();
    const transfer = staged.get(transferId);
    if (transfer === undefined) return { outcome: "missing" };
    if (transfer.used || transfer.cancelled || transfer.failed) {
      await removeStaged(transfer);
      staged.delete(transferId);
      return { outcome: "missing" };
    }
    transfer.used = true;
    const stagedPath = transfer.stagedPath;
    // The caller reads the file from `stagedPath`; removal happens in
    // `releaseAfterUse` once the browser has read it.
    return { outcome: "used", stagedPath };
  }

  /**
   * Remove a staged transfer after the browser has read it (release), after a
   * failure, or when the controller cancels. Always removes the staged file.
   */
  async function release(transferId: string): Promise<void> {
    const transfer = staged.get(transferId);
    if (transfer === undefined) return;
    await removeStaged(transfer);
    staged.delete(transferId);
  }

  function progress(transferId: string): BrowserTransferProgress | undefined {
    const transfer = staged.get(transferId);
    if (transfer === undefined) return undefined;
    let phase: BrowserTransferProgress["phase"];
    if (transfer.failed) phase = "failed";
    else if (transfer.cancelled) phase = "cancelled";
    else if (transfer.used) phase = "completed";
    else phase = "copying";
    return {
      transferId,
      phase,
      bytesCopied: transfer.sizeBytes,
      totalBytes: transfer.sizeBytes,
    };
  }

  /** Reap transfers whose staging lease has expired. */
  async function expire(): Promise<{ expired: string[] }> {
    const now = clock.now();
    const expired: string[] = [];
    for (const transfer of staged.values()) {
      if (transfer.used || transfer.cancelled || transfer.failed) continue;
      if (transfer.expiresAt <= now) {
        await removeStaged(transfer);
        staged.delete(transfer.transferId);
        expired.push(transfer.transferId);
      }
    }
    return { expired };
  }

  /**
   * Remove all staged transfers. Called on worker restart, dispose, or a
   * profile lifecycle operation so leftover staging data never persists.
   */
  async function purgeAll(): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    for (const transfer of staged.values()) {
      await removeStaged(transfer);
      staged.delete(transfer.transferId);
      removed.push(transfer.transferId);
    }
    return { removed };
  }

  async function cancel(
    transferId: string,
  ): Promise<{ outcome: "cancelled" | "missing" }> {
    const transfer = staged.get(transferId);
    if (transfer === undefined) return { outcome: "missing" };
    transfer.cancelled = true;
    await removeStaged(transfer);
    staged.delete(transferId);
    return { outcome: "cancelled" };
  }

  /**
   * Tear down the manager: remove every staged copy on disk and clear the
   * in-memory index so leftover staging data never persists. Called on worker
   * shutdown; profile lifecycle operations use {@link purgeAll}.
   */
  async function dispose(): Promise<void> {
    disposed = true;
    for (const transfer of staged.values()) {
      await removeStaged(transfer).catch(() => undefined);
    }
    staged.clear();
  }

  return {
    stage,
    stageWorkspaceFile,
    stageClientFile,
    consume,
    release,
    cancel,
    progress,
    expire,
    purgeAll,
    dispose,
    /** Test/inspection only: the count of currently staged transfers. */
    size(): number {
      return staged.size;
    },
  };
}

export type TransferStagingManager = ReturnType<
  typeof createTransferStagingManager
>;

/**
 * Resolve the host-local Transfer Staging root from `BB_BROWSER_HOST_DATA_DIR`.
 * The real-host command fails closed without the directory: this returns
 * `null` rather than creating or mutating any host path, so a non-provisioned
 * host is never mutated by a transfer. Callers must refuse to stage when the
 * root is `null`.
 */
export function resolveTransferStagingRoot(dataDirectory: string | undefined) {
  if (dataDirectory === undefined || dataDirectory === "") return null;
  return `${dataDirectory}/transfer-staging`;
}
