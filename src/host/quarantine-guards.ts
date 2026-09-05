/**
 * Shared quarantine guards (issues #19 and #20). Transfer Staging and Host
 * Downloads both broker untrusted files with the same low-disk refusal and
 * staged-copy cleanup behavior. This module factors that behavior out so the
 * two brokers do not duplicate it: each supplies a rejection constructor and
 * the rejection-reason value, and the shared helpers provide the policy.
 *
 * Filesystem and disk access remain injected by each caller so the containment
 * and quota behavior stays deterministic and testable without a provisioned
 * host. A host without a `statfs` analogue (in-memory fakes, containers) fails
 * open for the low-disk check so it is never blocked.
 */

export interface QuarantineDiskFilesystem {
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  /** Bytes available on the filesystem holding `path`. */
  availableBytes(path: string): Promise<number>;
}

/**
 * Build a low-disk guard. Returns the given `rejection` when the host does not
 * have enough free space to stage `requiredBytes`, otherwise `undefined`.
 * Failures reading free space fail open (allow staging) so a host without a
 * `statfs` analogue is not blocked.
 */
export function createLowDiskGuard<R, S>(
  filesystem: QuarantineDiskFilesystem,
  root: string,
  marginBytes: number,
  reject: (id: string, reason: R, message: string) => S,
  lowDiskReason: R,
): (id: string, requiredBytes: number) => Promise<S | undefined> {
  return async (id, requiredBytes) => {
    let available: number;
    try {
      available = await filesystem.availableBytes(root);
    } catch {
      return undefined;
    }
    if (available < requiredBytes + marginBytes) {
      return reject(
        id,
        lowDiskReason,
        "The host does not have enough free disk space to stage the transfer.",
      );
    }
    return undefined;
  };
}

/**
 * Build a cleanup-and-reject helper. Removes a destination created during
 * staging so it never leaks when a later guard rejects, then returns the given
 * `rejection`. The staged path is never left behind.
 */
export function createCleanupAndReject<R, S>(
  filesystem: QuarantineDiskFilesystem,
  reject: (id: string, reason: R, message: string) => S,
): (id: string, destination: string, reason: R, message: string) => Promise<S> {
  return async (id, destination, reason, message) => {
    await filesystem.rm(destination, { recursive: true, force: true });
    return reject(id, reason, message);
  };
}
