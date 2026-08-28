import { createHash } from "node:crypto";

export type BrowserAddress =
  { kind: "address"; url: string } | { kind: "search"; text: string };

export type LoopbackAddressMode = "project-alias" | "raw-localhost";

function explicitBrowserUrl(input: string) {
  if (!/^https?:\/\//iu.test(input)) return null;
  try {
    return new URL(input);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function implicitBrowserUrl(input: string) {
  if (/\s/u.test(input) || !/^[\w.-]+(?::\d+)?(?:\/[^\s]*)?$/u.test(input)) {
    return null;
  }
  const hostname = input.split(/[/:]/u, 1)[0]!;
  if (hostname !== "localhost" && !hostname.includes(".")) return null;
  const scheme =
    hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/u.test(hostname)
      ? "http"
      : "https";
  try {
    return new URL(`${scheme}://${input}`);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function resolveBrowserAddress(input: string): BrowserAddress {
  const text = input.trim();
  const address = explicitBrowserUrl(text) ?? implicitBrowserUrl(text);
  return address === null
    ? { kind: "search", text: input }
    : { kind: "address", url: address.href };
}

function projectLoopbackHostname(projectId: string) {
  const digest = createHash("sha256").update(projectId).digest("hex");
  return `p-${digest.slice(0, 12)}.localhost`;
}

function isRawLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

export function projectLoopbackAddress(
  projectId: string,
  address: string,
  mode: LoopbackAddressMode = "project-alias",
) {
  const url = new URL(address);
  if (mode === "project-alias" && isRawLoopbackHostname(url.hostname)) {
    url.hostname = projectLoopbackHostname(projectId);
  }
  return url.href;
}

export function browserNavigationScript(address: BrowserAddress) {
  const pageSelection = `const tabs = await browser.listPages();
const page = tabs[0]
  ? await browser.getPage(tabs[0].id)
  : await browser.getPage("workspace");`;
  if (address.kind === "address") {
    return `${pageSelection}
await page.goto(${JSON.stringify(address.url)});
console.log(page.url());`;
  }
  return `${pageSelection}
await page.keyboard.press("Control+L");
await page.keyboard.type(${JSON.stringify(address.text)});
await page.keyboard.press("Enter");
await page.waitForLoadState("domcontentloaded");
console.log(page.url());`;
}
