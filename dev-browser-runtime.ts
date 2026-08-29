import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_BROWSER_PACKAGE_NAME = "dev-browser";

export type DevBrowserRuntimePaths = {
  packageDirectory: string;
  executable: string;
};

export type ResolveDevBrowserRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  fromFileUrl?: string;
  extraSearchRoots?: readonly string[];
};

function packageDirectoryLooksValid(directory: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as { name?: unknown };
    return pkg.name === DEV_BROWSER_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function executablePath(packageDirectory: string) {
  return join(packageDirectory, "bin", "dev-browser.js");
}

function directoryFromCandidate(candidate: string): string {
  if (candidate.endsWith("package.json")) return dirname(candidate);
  if (candidate.endsWith(`${join("bin", "dev-browser.js")}`)) {
    return dirname(dirname(candidate));
  }
  return candidate;
}

function ancestorPackageDirectories(startDirectory: string): string[] {
  const directories: string[] = [];
  let current = startDirectory;
  for (let depth = 0; depth < 12; depth += 1) {
    directories.push(join(current, "node_modules", DEV_BROWSER_PACKAGE_NAME));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function envPackageDirectory(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.BB_DEV_BROWSER_PACKAGE?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

function requireResolvedDirectory(fromFileUrl: string): string | undefined {
  try {
    const require = createRequire(fromFileUrl);
    return dirname(require.resolve(`${DEV_BROWSER_PACKAGE_NAME}/package.json`));
  } catch {
    return undefined;
  }
}

export function resolveDevBrowserRuntime(
  options: ResolveDevBrowserRuntimeOptions = {},
): DevBrowserRuntimePaths | null {
  const env = options.env ?? process.env;
  const fromFileUrl = options.fromFileUrl ?? import.meta.url;
  const fromFilePath = fromFileUrl.startsWith("file:")
    ? fileURLToPath(fromFileUrl)
    : fromFileUrl;
  const fromFileDirectory = dirname(fromFilePath);
  const candidates: string[] = [];
  const envDirectory = envPackageDirectory(env);
  if (envDirectory !== undefined) candidates.push(envDirectory);
  const required = requireResolvedDirectory(fromFileUrl);
  if (required !== undefined) candidates.push(required);
  for (const root of options.extraSearchRoots ?? []) {
    candidates.push(join(root, "node_modules", DEV_BROWSER_PACKAGE_NAME));
    candidates.push(join(root, DEV_BROWSER_PACKAGE_NAME));
    if (packageDirectoryLooksValid(root)) candidates.push(root);
  }
  candidates.push(...ancestorPackageDirectories(fromFileDirectory));
  for (const nodePath of (env.NODE_PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    candidates.push(join(nodePath, DEV_BROWSER_PACKAGE_NAME));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const directory = directoryFromCandidate(candidate);
    if (seen.has(directory)) continue;
    seen.add(directory);
    if (!packageDirectoryLooksValid(directory)) continue;
    const executable = executablePath(directory);
    try {
      accessSync(executable, constants.F_OK);
      return { packageDirectory: directory, executable };
    } catch {
      continue;
    }
  }
  return null;
}

export function requireDevBrowserRuntime(
  options: ResolveDevBrowserRuntimeOptions = {},
): DevBrowserRuntimePaths {
  const resolved = resolveDevBrowserRuntime(options);
  if (resolved === null) {
    throw new Error(
      "Cannot find the pinned dev-browser package. Install it next to the plugin or set BB_DEV_BROWSER_PACKAGE to its directory.",
    );
  }
  return resolved;
}
