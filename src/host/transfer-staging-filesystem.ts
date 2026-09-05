import {
  chmod,
  copyFile,
  mkdir,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import type {
  TransferStagingFilesystem,
  TransferStagingStat,
} from "./transfer-staging.js";

/**
 * Node `fs/promises`-backed Transfer Staging filesystem. Used by the host on a
 * provisioned data directory; tests inject an in-memory fake instead so the
 * containment, symlink, special-file, changed-after-selection, oversized, and
 * low-disk behavior is deterministic without touching disk.
 */
export function createNodeTransferStagingFilesystem(): TransferStagingFilesystem {
  async function toStat(path: string): Promise<TransferStagingStat> {
    const stats = await stat(path);
    const isFile = stats.isFile();
    const isDirectory = stats.isDirectory();
    // Special: anything that is neither a regular file nor a directory (fifo,
    // socket, block/char device). Only regular files may be staged.
    const isSpecial = !isFile && !isDirectory;
    return {
      sizeBytes: stats.size,
      mtimeNs: BigInt(Math.round(stats.mtimeMs)) * 1_000_000n,
      isFile,
      isDirectory,
      isSpecial,
    };
  }

  return {
    realpath: (path) => realpath(path),
    stat: toStat,
    copyFile: (source, destination) =>
      copyFile(source, destination).then(() => undefined),
    writeFile: (path, data, mode) =>
      writeFile(path, data, { mode, flag: "wx" }).then(() => undefined),
    mkdir: (path, mode) =>
      mkdir(path, { recursive: true, mode }).then(() => undefined),
    chmod: (path, mode) => chmod(path, mode).then(() => undefined),
    rm: (path, options) => rm(path, options).then(() => undefined),
    async availableBytes(path) {
      try {
        const info = await statfs(path);
        // bfree counts free blocks available to privileged users; bavail counts
        // blocks available to unprivileged users. Use bavail so the staging
        // quota reflects what the `bb-browser` user can actually write.
        return Number(info.bavail) * Number(info.bsize);
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    },
  };
}
