import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import type { HostDownloadFilesystem } from "./host-downloads.js";
import type { TransferStagingStat } from "./transfer-staging.js";

/**
 * Node `fs/promises`-backed Host Downloads filesystem. Used by the host on a
 * provisioned data directory; tests inject an in-memory fake instead so the
 * name-normalization, quota-race, low-disk, interrupted-download, expiry,
 * permission, export, and cleanup behavior is deterministic without touching
 * disk. Reuses the same realpath/stat/copyFile/writeFile/mkdir/chmod/rm/
 * availableBytes semantics as Transfer Staging and adds `appendFile`/`readFile`
 * for streaming downloads and client export.
 */
export function createNodeHostDownloadsFilesystem(): HostDownloadFilesystem {
  async function toStat(path: string): Promise<TransferStagingStat> {
    const stats = await stat(path);
    const isFile = stats.isFile();
    const isDirectory = stats.isDirectory();
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
    appendFile: (path, data) =>
      // startDownload creates the quarantine file with "wx".
      // Use "a" here: exclusive append ("ax") would fail with EEXIST.
      appendFile(path, data, { flag: "a" }).then(() => undefined),
    readFile: (path) => readFile(path).then((buf) => new Uint8Array(buf)),
    mkdir: (path, mode) =>
      mkdir(path, { recursive: true, mode }).then(() => undefined),
    chmod: (path, mode) => chmod(path, mode).then(() => undefined),
    rm: (path, options) => rm(path, options).then(() => undefined),
    async availableBytes(path) {
      try {
        const info = await statfs(path);
        return Number(info.bavail) * Number(info.bsize);
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    },
  };
}
