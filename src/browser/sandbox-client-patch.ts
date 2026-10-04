import { readFile, stat, writeFile } from "node:fs/promises";

/**
 * dev-browser's QuickJS Playwright client closes a BrowserContext with
 * `browser._browserType._contexts`. The shared pre-launched browser never
 * receives a browser type, so that read throws inside `__transport_receive`
 * and fails the script. The replacement is the same length so it can also be
 * applied inside the packaged executable, which embeds this source.
 */
export const SANDBOX_CONTEXT_CLOSE_BROKEN = `this._browser?._browserType._contexts.delete(this);
      this._browser?._browserType._playwright.selectors._contextsForSelectors.delete(this);`;

export const SANDBOX_CONTEXT_CLOSE_FIXED = `this._browser?._browserType?._contexts.delete(this);
    this._browser?._browserType?._playwright.selectors._contextsForSelectors.delete(this);`;

export function patchSandboxClientSource(source: string): string {
  if (
    SANDBOX_CONTEXT_CLOSE_BROKEN.length !== SANDBOX_CONTEXT_CLOSE_FIXED.length
  ) {
    throw new Error("Sandbox client context-close patch changed length.");
  }
  if (!source.includes(SANDBOX_CONTEXT_CLOSE_BROKEN)) {
    if (source.includes(SANDBOX_CONTEXT_CLOSE_FIXED)) return source;
    throw new Error(
      "Dev-browser sandbox client is missing the context-close bookkeeping this plugin patches.",
    );
  }
  return source.replaceAll(
    SANDBOX_CONTEXT_CLOSE_BROKEN,
    SANDBOX_CONTEXT_CLOSE_FIXED,
  );
}

export function patchSandboxClientBytes(bytes: Buffer): Buffer {
  const broken = Buffer.from(SANDBOX_CONTEXT_CLOSE_BROKEN);
  if (!bytes.includes(broken)) return bytes;
  const fixed = Buffer.from(SANDBOX_CONTEXT_CLOSE_FIXED);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const index = bytes.indexOf(broken, offset);
    if (index < 0) {
      chunks.push(bytes.subarray(offset));
      break;
    }
    chunks.push(bytes.subarray(offset, index));
    chunks.push(fixed);
    offset = index + broken.length;
  }
  return Buffer.concat(chunks);
}

type FileStamp = {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

const unchangedPatches = new Map<string, FileStamp>();

function stampOf(current: {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}): FileStamp {
  return {
    dev: current.dev,
    ino: current.ino,
    mtimeMs: current.mtimeMs,
    size: current.size,
  };
}

function stampsMatch(left: FileStamp, right: FileStamp) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

async function patchIsUnchanged(path: string) {
  const current = await stat(path);
  const previous = unchangedPatches.get(path);
  return previous !== undefined && stampsMatch(previous, stampOf(current));
}

async function rememberUnchanged(path: string) {
  try {
    unchangedPatches.set(path, stampOf(await stat(path)));
  } catch {
    unchangedPatches.delete(path);
  }
}

export async function patchSandboxClientFile(path: string): Promise<boolean> {
  if (await patchIsUnchanged(path)) return false;
  const source = await readFile(path, "utf8");
  const patched = patchSandboxClientSource(source);
  if (patched === source) {
    await rememberUnchanged(path);
    return false;
  }
  await writeFile(path, patched);
  await rememberUnchanged(path);
  return true;
}

export async function patchSandboxClientBinary(path: string): Promise<boolean> {
  if (await patchIsUnchanged(path)) return false;
  const bytes = await readFile(path);
  const patched = patchSandboxClientBytes(bytes);
  if (patched === bytes) {
    await rememberUnchanged(path);
    return false;
  }
  await writeFile(path, patched);
  await rememberUnchanged(path);
  return true;
}
