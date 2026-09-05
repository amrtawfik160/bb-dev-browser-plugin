export const PINNED_BROWSER_RUNTIME = {
  playwrightVersion: "1.58.2",
  chromiumRevision: "1208",
  chromiumVersion: "145.0.7632.6",
} as const;

const DEPENDENCY_VERSIONS = [
  { name: "bb-plugin-browser", version: "0.1.0" },
  { name: "@get-bb/plugin-sdk", version: "0.4.21" },
  { name: "dev-browser", version: "0.2.9" },
  { name: "playwright", version: PINNED_BROWSER_RUNTIME.playwrightVersion },
  { name: "ws", version: "8.21.3" },
  { name: "zod", version: "4.3.6" },
] as const;

export function dependencyInventory() {
  return DEPENDENCY_VERSIONS.map((dependency) => ({ ...dependency }));
}
