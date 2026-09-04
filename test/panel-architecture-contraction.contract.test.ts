/**
 * Issue #63: after every caller has migrated, superseded Panel compatibility
 * paths must have no production callers. This search is the architecture
 * completion evidence required by spec #51.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

type Hit = {
  file: string;
  lineNumber: number;
  line: string;
};

function productionSources() {
  return readdirSync(ROOT)
    .filter((name) => /\.(?:ts|tsx)$/u.test(name))
    .map((name) => join(ROOT, name));
}

function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const path of productionSources()) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push({
          file: relative(ROOT, path).replace(/\\/gu, "/"),
          lineNumber: index + 1,
          line: line.trim(),
        });
      }
      pattern.lastIndex = 0;
    });
  }
  return hits;
}

describe("contracted Browser Panel compatibility paths", () => {
  it("has no production callers of superseded Panel parsing, registries, route wording, or relays", () => {
    expect(
      scan(
        /decodeLegacyAliases|legacyControlSchema|legacyErrorSchema|legacyErrorCategory/u,
      ),
      "legacy Panel protocol aliases remain in production",
    ).toEqual([]);
    expect(
      scan(/createPanelControlState/u),
      "the Control Lease compatibility adapter remains in production",
    ).toEqual([]);
    expect(
      scan(/session\?: \{ tabStrip\(\)/u),
      "the Browser Tab registry compatibility adapter remains in production",
    ).toEqual([]);
    expect(
      scan(/\{ type: "error"/u),
      "unversioned Panel error frames remain in production",
    ).toEqual([]);
    expect(
      scan(/type: z\.literal\("control"\)/u),
      "unversioned Panel control snapshots remain in production",
    ).toEqual([]);
    expect(
      scan(/function sendJson\(/u),
      "unchecked Panel JSON sending remains in production",
    ).toEqual([]);

    const routeWording = scan(
      /"(?:Connecting to the browser|Reconnecting to the browser|Take control|Let another panel take over)/u,
    ).filter((hit) => hit.file === "app.tsx");
    expect(
      routeWording,
      "the app route still derives owner-facing Panel wording",
    ).toEqual([]);

    const panelRelays = [
      "navigate",
      "history",
      "tabAction",
      "tabs",
      "panelControl",
      "takeControl",
      "reclaimControl",
      "releaseControl",
      "panelTransport",
      "panelVisibility",
      "panelRelease",
    ];
    const relayHits = scan(
      new RegExp(`host\\.call\\("(?:${panelRelays.join("|")})"`, "u"),
    ).filter((hit) => hit.file === "browser-service.ts");
    expect(
      relayHits,
      "Browser Panel operations still relay through browser-service instead of the typed dispatch module",
    ).toEqual([]);
  });
});
