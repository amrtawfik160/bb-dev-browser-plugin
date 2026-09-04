import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_BROWSER_PACKAGE_NAME = "dev-browser";
export const DEV_BROWSER_PACKAGE_VERSION = "0.2.9";

export type DevBrowserRuntimePaths = {
  packageDirectory: string;
  executable: string;
};

export type ResolveDevBrowserRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  fromFileUrl?: string;
  extraSearchRoots?: readonly string[];
};

function devBrowserPackageVersion(directory: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (pkg.name !== DEV_BROWSER_PACKAGE_NAME) return null;
    return typeof pkg.version === "string" ? pkg.version : "<missing>";
  } catch {
    return null;
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
  return searchDevBrowserRuntime(options).runtime;
}

type RuntimeMismatch = { directory: string; version: string };

function searchDevBrowserRuntime(options: ResolveDevBrowserRuntimeOptions): {
  runtime: DevBrowserRuntimePaths | null;
  mismatches: RuntimeMismatch[];
} {
  const env = options.env ?? process.env;
  const fromFileUrl = options.fromFileUrl ?? import.meta.url;
  const fromFilePath = fromFileUrl.startsWith("file:")
    ? fileURLToPath(fromFileUrl)
    : fromFileUrl;
  const fromFileDirectory = dirname(fromFilePath);
  const candidates: string[] = [];
  const envDirectory = envPackageDirectory(env);
  if (envDirectory !== undefined) {
    const directory = directoryFromCandidate(envDirectory);
    const version = devBrowserPackageVersion(directory);
    if (version !== null && version !== DEV_BROWSER_PACKAGE_VERSION) {
      return { runtime: null, mismatches: [{ directory, version }] };
    }
    candidates.push(envDirectory);
  }
  const required = requireResolvedDirectory(fromFileUrl);
  if (required !== undefined) candidates.push(required);
  for (const root of options.extraSearchRoots ?? []) {
    candidates.push(join(root, "node_modules", DEV_BROWSER_PACKAGE_NAME));
    candidates.push(join(root, DEV_BROWSER_PACKAGE_NAME));
    if (devBrowserPackageVersion(root) !== null) candidates.push(root);
  }
  candidates.push(...ancestorPackageDirectories(fromFileDirectory));
  for (const nodePath of (env.NODE_PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    candidates.push(join(nodePath, DEV_BROWSER_PACKAGE_NAME));
  }

  const seen = new Set<string>();
  const mismatches: RuntimeMismatch[] = [];
  for (const candidate of candidates) {
    const directory = directoryFromCandidate(candidate);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const version = devBrowserPackageVersion(directory);
    if (version === null) continue;
    if (version !== DEV_BROWSER_PACKAGE_VERSION) {
      mismatches.push({ directory, version });
      continue;
    }
    const executable = executablePath(directory);
    try {
      accessSync(executable, constants.F_OK);
      return {
        runtime: { packageDirectory: directory, executable },
        mismatches,
      };
    } catch {
      continue;
    }
  }
  return { runtime: null, mismatches };
}

export function requireDevBrowserRuntime(
  options: ResolveDevBrowserRuntimeOptions = {},
): DevBrowserRuntimePaths {
  const search = searchDevBrowserRuntime(options);
  if (search.runtime === null) {
    const mismatch = search.mismatches[0];
    if (mismatch !== undefined) {
      throw new Error(
        `Incompatible ${DEV_BROWSER_PACKAGE_NAME} package at ${mismatch.directory}: expected ${DEV_BROWSER_PACKAGE_VERSION}, found ${mismatch.version}.`,
      );
    }
    throw new Error(
      `Cannot find the pinned ${DEV_BROWSER_PACKAGE_NAME} package (expected ${DEV_BROWSER_PACKAGE_VERSION}). Install it next to the plugin or set BB_DEV_BROWSER_PACKAGE to its directory.`,
    );
  }
  return search.runtime;
}
