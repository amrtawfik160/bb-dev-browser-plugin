import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_BROWSER_RUNTIME } from "./dependency-inventory.js";

const PLAYWRIGHT_PACKAGE_NAME = "playwright";
const PLAYWRIGHT_PACKAGE_VERSION = PINNED_BROWSER_RUNTIME.playwrightVersion;

export type PlaywrightRuntimePaths = {
  packageDirectory: string;
};

export type ResolvePlaywrightRuntimeOptions = {
  fromFileUrl?: string;
  extraSearchRoots?: readonly string[];
};

type RuntimeMismatch = { directory: string; version: string };

function playwrightPackageVersion(directory: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (pkg.name !== PLAYWRIGHT_PACKAGE_NAME) return null;
    return typeof pkg.version === "string" ? pkg.version : "<missing>";
  } catch {
    return null;
  }
}

function directoryFromCandidate(candidate: string): string {
  return candidate.endsWith("package.json") ? dirname(candidate) : candidate;
}

function ancestorPackageDirectories(startDirectory: string): string[] {
  const directories: string[] = [];
  let current = startDirectory;
  for (let depth = 0; depth < 12; depth += 1) {
    directories.push(join(current, "node_modules", PLAYWRIGHT_PACKAGE_NAME));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function requireResolvedDirectory(fromFileUrl: string): string | undefined {
  try {
    const require = createRequire(fromFileUrl);
    return dirname(require.resolve(`${PLAYWRIGHT_PACKAGE_NAME}/package.json`));
  } catch {
    return undefined;
  }
}

function extraSearchCandidates(root: string): string[] {
  const candidates = [
    join(root, "node_modules", PLAYWRIGHT_PACKAGE_NAME),
    join(root, PLAYWRIGHT_PACKAGE_NAME),
  ];
  if (playwrightPackageVersion(root) !== null) candidates.push(root);
  return candidates;
}

function searchPlaywrightRuntime(options: ResolvePlaywrightRuntimeOptions): {
  runtime: PlaywrightRuntimePaths | null;
  mismatches: RuntimeMismatch[];
} {
  const fromFileUrl = options.fromFileUrl ?? import.meta.url;
  const fromFilePath = fromFileUrl.startsWith("file:")
    ? fileURLToPath(fromFileUrl)
    : fromFileUrl;
  const candidates: string[] = [];
  const required = requireResolvedDirectory(fromFileUrl);
  if (required !== undefined) candidates.push(required);
  for (const root of options.extraSearchRoots ?? []) {
    candidates.push(...extraSearchCandidates(root));
  }
  candidates.push(...ancestorPackageDirectories(dirname(fromFilePath)));

  const seen = new Set<string>();
  const mismatches: RuntimeMismatch[] = [];
  for (const candidate of candidates) {
    const directory = directoryFromCandidate(candidate);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const version = playwrightPackageVersion(directory);
    if (version === null) continue;
    if (version !== PLAYWRIGHT_PACKAGE_VERSION) {
      mismatches.push({ directory, version });
      continue;
    }
    return { runtime: { packageDirectory: directory }, mismatches };
  }
  return { runtime: null, mismatches };
}

export function resolvePlaywrightRuntime(
  options: ResolvePlaywrightRuntimeOptions = {},
): PlaywrightRuntimePaths | null {
  return searchPlaywrightRuntime(options).runtime;
}

export function requirePlaywrightRuntime(
  options: ResolvePlaywrightRuntimeOptions = {},
): PlaywrightRuntimePaths {
  const search = searchPlaywrightRuntime(options);
  if (search.runtime !== null) return search.runtime;
  const mismatch = search.mismatches[0];
  if (mismatch !== undefined) {
    throw new Error(
      `Incompatible ${PLAYWRIGHT_PACKAGE_NAME} package at ${mismatch.directory}: expected ${PLAYWRIGHT_PACKAGE_VERSION}, found ${mismatch.version}.`,
    );
  }
  throw new Error(
    `Cannot find the pinned ${PLAYWRIGHT_PACKAGE_NAME} package (expected ${PLAYWRIGHT_PACKAGE_VERSION}).`,
  );
}
