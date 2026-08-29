import { createHash } from "node:crypto";
import {
  isBrowserLoopbackHostname,
  isRawLocalhostHostname,
} from "./authorization.js";

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
  if (/\s/u.test(input) || input.startsWith("?") || input.startsWith("#")) {
    return null;
  }
  let candidate: URL;
  try {
    candidate = new URL(`http://${input}`);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const hostname = candidate.hostname;
  if (!isBrowserLoopbackHostname(hostname) && !hostname.includes(".")) {
    return null;
  }
  const scheme = isBrowserLoopbackHostname(hostname) ? "http" : "https";
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

export function projectLoopbackAddress(
  projectId: string,
  address: string,
  mode: LoopbackAddressMode = "project-alias",
) {
  const url = new URL(address);
  if (mode === "project-alias" && isRawLocalhostHostname(url.hostname)) {
    url.hostname = projectLoopbackHostname(projectId);
  }
  return url.href;
}

export function browserNavigationScript(
  address: Extract<BrowserAddress, { kind: "address" }>,
  tabId: string,
) {
  return `const page = await browser.getPage(${JSON.stringify(tabId)});
await page.bringToFront();
await page.goto(${JSON.stringify(address.url)});
console.log(JSON.stringify({ tabId: ${JSON.stringify(tabId)}, url: page.url() }));`;
}

export function activeBrowserTabScript() {
  return `const pages = await browser.listPages();
if (pages.length === 0) throw new Error("The Browser Profile has no open tabs");
let active = null;
for (const entry of pages) {
  const candidate = await browser.getPage(entry.id);
  if (await candidate.evaluate(() => document.visibilityState === "visible")) {
    active = entry;
    break;
  }
}
console.log(JSON.stringify(active ?? pages[0]));`;
}
