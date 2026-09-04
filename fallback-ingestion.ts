import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const LINUX_O_PATH = 0x200000;
const NO_FOLLOW_ENTRY_FLAGS = LINUX_O_PATH | constants.O_NOFOLLOW;
const NO_FOLLOW_DIRECTORY_FLAGS =
  LINUX_O_PATH | constants.O_NOFOLLOW | constants.O_DIRECTORY;
const COPY_BUFFER_SIZE = 64 * 1024;

export type StagedFallbackPack = {
  rootDirectory: string;
  packDirectory: string;
  executablePath: string;
};

function procFileDescriptor(fileHandle: FileHandle): string {
  return `/proc/self/fd/${fileHandle.fd}`;
}

function invalidEntry(path: string): Error {
  return new Error(
    `Fallback Browser pack entry must be a regular file or directory: ${path}`,
  );
}

async function openDirectoryWithoutSymlinks(
  directoryPath: string,
): Promise<FileHandle> {
  let current = await open("/", NO_FOLLOW_DIRECTORY_FLAGS);
  try {
    for (const component of resolve(directoryPath).split("/").filter(Boolean)) {
      const next = await openDirectoryComponent(
        current,
        component,
        directoryPath,
      );
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

async function openDirectoryComponent(
  parentDirectory: FileHandle,
  component: string,
  directoryPath: string,
): Promise<FileHandle> {
  const componentHandle = await open(
    join(procFileDescriptor(parentDirectory), component),
    NO_FOLLOW_ENTRY_FLAGS,
  );
  try {
    if (!(await componentHandle.stat()).isDirectory()) {
      throw invalidEntry(directoryPath);
    }
    return componentHandle;
  } catch (error) {
    await componentHandle.close();
    throw error;
  }
}

async function openAnchoredEntry(
  directoryHandle: FileHandle,
  name: string,
): Promise<FileHandle> {
  return open(
    join(procFileDescriptor(directoryHandle), name),
    NO_FOLLOW_ENTRY_FLAGS,
  );
}

function sourceMetadataChanged(before: Stats, after: Stats): boolean {
  return (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  );
}

async function copyRegularFile(
  sourceHandle: FileHandle,
  destinationPath: string,
  relativePath: string,
  mode: 0o600 | 0o755,
) {
  const sourceBefore = await sourceHandle.stat();
  const destinationHandle = await open(
    destinationPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await copyAnchoredFile(
      sourceHandle,
      destinationHandle,
      sourceBefore,
      relativePath,
    );
    await destinationHandle.chmod(mode);
  } finally {
    await destinationHandle.close();
  }
}

async function copyAnchoredFile(
  sourceHandle: FileHandle,
  destinationHandle: FileHandle,
  sourceBefore: Stats,
  relativePath: string,
): Promise<void> {
  // The descriptor is already anchored to the source object. Reopening its
  // proc link is safe and gives the regular file a readable descriptor.
  const sourceReader = await open(
    procFileDescriptor(sourceHandle),
    constants.O_RDONLY,
  );
  try {
    await copyFixedBytes(
      sourceReader,
      destinationHandle,
      sourceBefore.size,
      relativePath,
    );
    const sourceAfter = await sourceReader.stat();
    if (sourceMetadataChanged(sourceBefore, sourceAfter)) {
      throw mutableFileError(relativePath);
    }
  } finally {
    await sourceReader.close();
  }
}

async function copyFixedBytes(
  sourceReader: FileHandle,
  destinationHandle: FileHandle,
  byteCount: number,
  relativePath: string,
): Promise<void> {
  const buffer = Buffer.alloc(COPY_BUFFER_SIZE);
  let copied = 0;
  while (copied < byteCount) {
    const length = Math.min(buffer.length, byteCount - copied);
    const read = await sourceReader.read(buffer, 0, length, copied);
    if (read.bytesRead === 0) throw invalidEntry(relativePath);
    await destinationHandle.write(buffer, 0, read.bytesRead, copied);
    copied += read.bytesRead;
  }
  const trailing = await sourceReader.read(buffer, 0, 1, byteCount);
  if (trailing.bytesRead !== 0) throw mutableFileError(relativePath);
}

function mutableFileError(relativePath: string): Error {
  return new Error(
    `Mutable Fallback Browser file changed while staging: ${relativePath}`,
  );
}

async function copyDirectoryContents(
  sourceDirectoryHandle: FileHandle,
  destinationDirectory: string,
  relativeDirectory: string,
  executableName: string,
): Promise<void> {
  const names = await readdir(procFileDescriptor(sourceDirectoryHandle));
  for (const name of names) {
    await copyDirectoryEntry(
      sourceDirectoryHandle,
      destinationDirectory,
      relativeDirectory,
      executableName,
      name,
    );
  }
}

async function copyDirectoryEntry(
  sourceDirectoryHandle: FileHandle,
  destinationDirectory: string,
  relativeDirectory: string,
  executableName: string,
  name: string,
): Promise<void> {
  const relativePath = join(relativeDirectory, name);
  const sourceEntry = await openAnchoredEntry(sourceDirectoryHandle, name);
  try {
    const entryStats = await sourceEntry.stat();
    const destinationPath = join(destinationDirectory, name);
    if (entryStats.isDirectory()) {
      await copyDirectoryEntryDirectory(
        sourceEntry,
        destinationPath,
        relativePath,
        executableName,
      );
      return;
    }
    if (entryStats.isFile()) {
      await copyRegularFile(
        sourceEntry,
        destinationPath,
        relativePath,
        relativePath === executableName ? 0o755 : 0o600,
      );
      return;
    }
    throw invalidEntry(relativePath);
  } finally {
    await sourceEntry.close();
  }
}

async function copyDirectoryEntryDirectory(
  sourceDirectory: FileHandle,
  destinationDirectory: string,
  relativeDirectory: string,
  executableName: string,
): Promise<void> {
  await mkdir(destinationDirectory, { mode: 0o700 });
  await copyDirectoryContents(
    sourceDirectory,
    destinationDirectory,
    relativeDirectory,
    executableName,
  );
}

async function verifyStagedExecutable(
  executablePath: string,
  sourcePath: string,
) {
  const executableHandle = await open(
    executablePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await executableHandle.stat()).isFile())
      throw invalidEntry(sourcePath);
  } finally {
    await executableHandle.close();
  }
}

export async function stageFallbackPack(
  sourcePath: string,
): Promise<StagedFallbackPack> {
  const sourceDirectoryHandle = await openDirectoryWithoutSymlinks(
    dirname(sourcePath),
  );
  try {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-fallback-"));
    try {
      return await createStagedPack(
        sourceDirectoryHandle,
        sourcePath,
        rootDirectory,
      );
    } catch (error) {
      await rm(rootDirectory, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await sourceDirectoryHandle.close();
  }
}

async function createStagedPack(
  sourceDirectoryHandle: FileHandle,
  sourcePath: string,
  rootDirectory: string,
): Promise<StagedFallbackPack> {
  const packDirectory = join(rootDirectory, "pack");
  await mkdir(packDirectory, { mode: 0o700 });
  const executableName = basename(sourcePath);
  await copyDirectoryContents(
    sourceDirectoryHandle,
    packDirectory,
    "",
    executableName,
  );
  const executablePath = join(packDirectory, executableName);
  await verifyStagedExecutable(executablePath, sourcePath);
  return { rootDirectory, packDirectory, executablePath };
}
