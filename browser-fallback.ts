import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PINNED_BROWSER_RUNTIME } from "./dependency-inventory.js";

export const fallbackBrowserManifestSchema = z
  .object({
    playwrightVersion: z.literal(PINNED_BROWSER_RUNTIME.playwrightVersion),
    chromiumRevision: z.literal(PINNED_BROWSER_RUNTIME.chromiumRevision),
    chromiumVersion: z.literal(PINNED_BROWSER_RUNTIME.chromiumVersion),
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export function fallbackBrowserPaths(hostStoragePath: string) {
  const directory = join(hostStoragePath, "browsers", "chromium");
  return {
    directory,
    executablePath: join(directory, "chrome"),
    manifestPath: join(directory, "version.json"),
  };
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function inspectFallbackBrowser(input: {
  hostStoragePath: string;
  uid: number;
  gid: number;
}) {
  const paths = fallbackBrowserPaths(input.hostStoragePath);
  try {
    const [executableMetadata, manifestMetadata, manifest] = await Promise.all([
      lstat(paths.executablePath),
      lstat(paths.manifestPath),
      readFile(paths.manifestPath, "utf8").then((contents) =>
        fallbackBrowserManifestSchema.parse(JSON.parse(contents)),
      ),
    ]);
    const secureExecutable =
      executableMetadata.isFile() &&
      executableMetadata.uid === input.uid &&
      executableMetadata.gid === input.gid &&
      (executableMetadata.mode & 0o7777) === 0o755;
    const secureManifest =
      manifestMetadata.isFile() &&
      manifestMetadata.uid === input.uid &&
      manifestMetadata.gid === input.gid &&
      (manifestMetadata.mode & 0o7777) === 0o600;
    const intact =
      (await sha256(paths.executablePath)) === manifest.executableSha256;
    return secureExecutable && secureManifest && intact
      ? { paths, manifest }
      : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return null;
    throw error;
  }
}
