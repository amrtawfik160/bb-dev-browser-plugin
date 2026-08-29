import type { OriginScopeMatcher } from "./authorization.js";

/**
 * Origin Scope enforcement during real browser navigation.
 *
 * The server resolves a Profile Grant into an {@link OriginScopeMatcher} and
 * hands it to the host, which injects {@link enforcementPreambleScript} and
 * {@link enforcementPostambleScript} around the QuickJS-sandboxed agent code.
 * A destination the matcher rejects is refused, and the denial is signalled
 * back through a unique stdout marker so the host returns a typed
 * `origin_denied` result and discards whatever the script produced.
 *
 * Enforcement is expressed as a policy check rather than request
 * interception. The sandbox cannot call back into agent-supplied JavaScript,
 * so `BrowserContext.route` never invoked its handler: every intercepted
 * request hung until the script deadline, which meant grant-scoped automation
 * could not navigate at all and no origin was ever actually checked. Two
 * callback-free pieces replace it:
 *
 * 1. `page.goto` on the bound page is guarded, so the common out-of-scope
 *    navigation fails immediately with a clear message. This is a fast path,
 *    not the boundary — the frozen `browser` global cannot be wrapped, so a
 *    page the script fetches itself is not guarded.
 * 2. After the script finishes, every tab that this call opened or moved is
 *    checked against the scope. That is the boundary: a redirect, an in-page
 *    navigation, a link click, or a popup that lands out of scope denies the
 *    call and discards its result.
 *
 * The difference from request interception is honest and worth stating: an
 * out-of-scope page loads before the second check sees it. The agent never
 * receives the result, but the request did happen. Only top-level navigation
 * is in scope either way — ordinary cross-origin subresources are not
 * checked, and neither is reading a tab the call never moved.
 *
 * The matcher is the same normalized policy the server grant store uses, so
 * exact scheme, host, and port matching, explicit subdomain patterns, Project
 * Loopback Aliases, raw localhost fallback, and whole-web access share one
 * policy.
 */

const DENIAL_MARKER_PREFIX = "__bbOriginDenied";

/**
 * Returns the source of a pure function `(origin, matcher) => boolean` that
 * mirrors {@link matcherPermitsOrigin} for the QuickJS sandbox. It is written
 * as a self-contained string so it can be evaluated in a Node `vm` for parity
 * tests and embedded verbatim in the generated preamble.
 *
 * It parses the origin itself rather than reading properties off `new URL`.
 * The sandbox's `URL` exposes only part of the WHATWG surface — `hostname` is
 * absent — so every policy decision that touched it threw a `TypeError` and
 * failed the script. Parsing the scheme, host, and port from the string keeps
 * the policy identical to {@link matcherPermitsOrigin} without depending on
 * which accessors the sandbox happens to implement; the parity tests hold both
 * to the same table.
 */
export function originPermittedFunctionSource(): string {
  return String.raw`function __bbUrlParts(value) {
  var match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(String(value));
  if (match === null) return null;
  var protocol = match[1].toLowerCase();
  var authority = match[2];
  var at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  var hostname = "";
  var port = "";
  if (authority.charAt(0) === "[") {
    var close = authority.indexOf("]");
    if (close === -1) return null;
    hostname = authority.slice(0, close + 1).toLowerCase();
    var rest = authority.slice(close + 1);
    if (rest.charAt(0) === ":") port = rest.slice(1);
    else if (rest !== "") return null;
  } else {
    var colon = authority.indexOf(":");
    hostname = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
    if (colon !== -1) port = authority.slice(colon + 1);
  }
  if (hostname === "") return null;
  if (port !== "" && !/^\d+$/.test(port)) return null;
  if ((protocol === "http" && port === "80") || (protocol === "https" && port === "443")) port = "";
  return {
    protocol: protocol,
    hostname: hostname,
    port: port,
    origin: protocol + "://" + hostname + (port === "" ? "" : ":" + port)
  };
}
function __bbOriginPermitted(origin, matcher) {
  var parts = __bbUrlParts(origin);
  if (parts === null) return false;
  if (matcher.kind === "whole-web") return !__bbIsRawLocalhost(parts.hostname, matcher.rawLocalhostHosts);
  if (matcher.kind === "never") return false;
  if (matcher.kind === "exact") return matcher.origin === parts.origin;
  var portMatches = matcher.port === parts.port || (matcher.port === "" && parts.port === "");
  return parts.protocol === matcher.protocol && portMatches && parts.hostname !== matcher.baseHost && parts.hostname.endsWith("." + matcher.baseHost);
}
function __bbIsRawLocalhost(hostname, rawLocalhostHosts) {
  var h = hostname.toLowerCase();
  if (rawLocalhostHosts && rawLocalhostHosts.indexOf(h) !== -1) return true;
  if (h === "localhost" || h === "localhost.") return true;
  var octets = h.split(".");
  if (octets.length === 4 && octets[0] === "127" && octets.every(function (octet) {
    return /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255;
  })) return true;
  return __bbIsIpv6Loopback(h);
}
function __bbIpv6Hextets(hostname) {
  var value = hostname.charAt(0) === "[" && hostname.charAt(hostname.length - 1) === "]"
    ? hostname.slice(1, -1)
    : hostname;
  if (value.indexOf(":") === -1) return null;
  function parsePart(part) {
    if (part === "") return [];
    var segments = part.split(":");
    var hextets = [];
    for (var index = 0; index < segments.length; index += 1) {
      var segment = segments[index];
      if (segment.indexOf(".") !== -1) {
        if (index !== segments.length - 1) return null;
        var octets = segment.split(".");
        if (octets.length !== 4 || octets.some(function (octet) {
          return !/^\d+$/.test(octet) || Number(octet) < 0 || Number(octet) > 255;
        })) return null;
        hextets.push(Number(octets[0]) * 256 + Number(octets[1]), Number(octets[2]) * 256 + Number(octets[3]));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
      hextets.push(Number.parseInt(segment, 16));
    }
    return hextets;
  }
  var halves = value.split("::");
  if (halves.length > 2) return null;
  var left = parsePart(halves[0]);
  var right = parsePart(halves.length === 2 ? halves[1] : "");
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length >= 8) return null;
  var middle = new Array(8 - left.length - right.length).fill(0);
  return left.concat(middle, right);
}
function __bbIsIpv6Loopback(hostname) {
  var hextets = __bbIpv6Hextets(hostname);
  if (hextets === null) return false;
  if (hextets.slice(0, 7).every(function (hextet) { return hextet === 0; }) && hextets[7] === 1) return true;
  var isIpv4Mapped = hextets.slice(0, 5).every(function (hextet) { return hextet === 0; }) && hextets[5] === 0xffff;
  if (!isIpv4Mapped) return false;
  return hextets[6] >= 0x7f00 && hextets[6] <= 0x7fff;
}`;
}

/**
 * Decides whether a candidate web origin carries a per-origin invalid
 * certificate opt-in. The grant store persists invalid-certificate approvals
 * as normalized exact origins (`new URL(candidate).origin`), so this matches
 * the same normalized form the route handler computes from a navigation URL.
 * An origin that is not a valid URL is never granted a certificate bypass.
 */
export function originRequiresCertificateBypass(
  origin: string,
  invalidCertificateOrigins: readonly string[],
): boolean {
  let destination: URL;
  try {
    destination = new URL(origin);
  } catch {
    return false;
  }
  return invalidCertificateOrigins.includes(destination.origin);
}

/**
 * Returns the source of a pure function `(origin, origins) => boolean` that
 * mirrors {@link originRequiresCertificateBypass} for the QuickJS sandbox. It
 * is written as a self-contained string so it can be evaluated in a Node `vm`
 * for parity tests and embedded verbatim in the generated preamble.
 */
export function originRequiresCertificateBypassSource(): string {
  return String.raw`function __bbOriginRequiresCertificateBypass(origin, origins) {
  var url = __bbUrlParts(origin);
  if (url === null) return false;
  if (!origins) return false;
  for (var index = 0; index < origins.length; index += 1) {
    if (origins[index] === url.origin) return true;
  }
  return false;
}`;
}

/**
 * Builds the QuickJS preamble that establishes one Origin Scope policy.
 *
 * It defines the matcher, the denial reporting, and the snapshot of where
 * every tab sat before the agent code ran. It must run first so the snapshot
 * describes the state this call inherited rather than the state it produced.
 *
 * Per-origin invalid-certificate opt-ins are recorded here so the policy can
 * distinguish an approved bad-certificate origin from an out-of-scope one; the
 * connected browser applies its own certificate handling, which the sandbox
 * cannot override per request.
 */
export function enforcementPreambleScript(
  matcher: OriginScopeMatcher,
  denialMarker: string,
  invalidCertificateOrigins: readonly string[] = [],
): string {
  const matcherJson = JSON.stringify(matcher);
  const permitted = originPermittedFunctionSource();
  const bypass = originRequiresCertificateBypassSource();
  const originsJson = JSON.stringify(invalidCertificateOrigins);
  return `${permitted}
${bypass}
const __bbMatcher = ${matcherJson};
const __bbDenialMarker = ${JSON.stringify(denialMarker)};
const __bbInvalidCertificateOrigins = ${originsJson};
let __bbDeniedOrigin = null;
function __bbReportOriginDenied(origin) {
  console.log(JSON.stringify({ ${JSON.stringify(DENIAL_MARKER_PREFIX)}: __bbDenialMarker, origin }));
}
function __bbPageOrigin(value) {
  const parts = __bbUrlParts(value);
  return parts === null ? null : parts.origin;
}
/** Origins that carry no page content and are never worth denying. */
function __bbIsBlankLocation(value) {
  return typeof value !== "string" || value === "" || value === "about:blank" || value.indexOf("about:") === 0 || value.indexOf("chrome://") === 0;
}
function __bbDenyNavigation(target) {
  const origin = __bbPageOrigin(target);
  __bbDeniedOrigin = origin === null ? String(target) : origin;
  const error = new Error("Origin Scope denies navigation to " + __bbDeniedOrigin + ".");
  error.__bbOriginDenied = true;
  throw error;
}
function __bbGuardNavigation(target) {
  if (__bbIsBlankLocation(target)) return;
  const origin = __bbPageOrigin(target);
  if (origin === null || !__bbOriginPermitted(origin, __bbMatcher)) __bbDenyNavigation(target);
}
/**
 * Where every tab sat before the agent code ran.
 *
 * The browser global is frozen, so its accessors cannot be wrapped and the
 * tabs a script binds cannot be recorded. Comparing this snapshot against the
 * final state identifies exactly what the call changed — a tab it navigated
 * or a tab it opened — without depending on any patch, and without denying
 * over an unrelated tab the owner left open and the call never moved.
 */
const __bbTabsBefore = await browser.listPages();
function __bbUrlBefore(id) {
  for (const __bbEntry of __bbTabsBefore) {
    if (__bbEntry.id === id) return typeof __bbEntry.url === "string" ? __bbEntry.url : "";
  }
  return null;
}
`;
}

/**
 * Guards `page.goto` on the tab bound for the agent script.
 *
 * Page objects are patchable even though the `browser` global is frozen, so
 * the common case — the script navigating the page it was handed — fails
 * immediately with a clear message instead of running to completion and being
 * denied afterwards. This is a fast path, not the boundary: a page the script
 * fetches itself through `browser.getPage` cannot be patched, which is why
 * {@link enforcementPostambleScript} is what actually enforces the scope.
 */
export function boundPageGuardScript(): string {
  return `if (typeof page === "object" && page !== null) {
  const __bbOriginalGoto = page.goto.bind(page);
  page.goto = function (target, options) { __bbGuardNavigation(target); return __bbOriginalGoto(target, options); };
}
`;
}

/**
 * Builds the QuickJS postamble that re-checks where the browser actually
 * ended up.
 *
 * A refused `page.goto` throws out of the agent code carrying the denied
 * origin; anything else — a redirect, a link click, a script-driven
 * navigation — is caught afterwards by re-reading the tabs this call bound,
 * plus any tab it opened. Tabs the call never touched are left alone, because
 * denying over an unrelated tab the owner happens to have open would make a
 * narrow grant unusable. Either way the denial marker goes to stdout and the
 * host discards the script result.
 */
export function enforcementPostambleScript(): string {
  return `if (__bbDeniedOrigin === null) {
  for (const __bbEntry of await browser.listPages()) {
    const __bbBefore = __bbUrlBefore(__bbEntry.id);
    // A tab this call neither opened nor moved is not this call's doing.
    if (__bbBefore === __bbEntry.url) continue;
    if (__bbIsBlankLocation(__bbEntry.url)) continue;
    const __bbEntryOrigin = __bbPageOrigin(__bbEntry.url);
    if (__bbEntryOrigin === null || !__bbOriginPermitted(__bbEntryOrigin, __bbMatcher)) {
      __bbDeniedOrigin = __bbEntryOrigin === null ? String(__bbEntry.url) : __bbEntryOrigin;
      break;
    }
  }
}
if (__bbDeniedOrigin !== null) __bbReportOriginDenied(__bbDeniedOrigin);
`;
}

/**
 * Extracts a denial marker line from a script result.
 *
 * Returns the denied origin when the unique marker the host generated appears
 * in the script output (a plain string result, or the `output` field of a
 * structured screenshot result). The marker is opaque to the agent: it is
 * generated by the host and embedded in the preamble, so an agent cannot forge
 * it. The result is left untouched because a denial discards the result.
 */
export function extractOriginDenial(
  result: unknown,
  denialMarker: string,
): { origin: string } | null {
  const output = readOutput(result);
  if (output === null) return null;
  for (const line of output.split("\n")) {
    const origin = parseDenialLine(line, denialMarker);
    if (origin !== null) return { origin };
  }
  return null;
}

function readOutput(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (
    typeof result === "object" &&
    result !== null &&
    "output" in result &&
    typeof (result as { output?: unknown }).output === "string"
  ) {
    return (result as { output: string }).output;
  }
  return null;
}

function parseDenialLine(line: string, denialMarker: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed === "undefined") return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !(DENIAL_MARKER_PREFIX in parsed)
    ) {
      return null;
    }
    const marker = (parsed as Record<string, unknown>)[DENIAL_MARKER_PREFIX];
    const origin = (parsed as Record<string, unknown>).origin;
    return marker === denialMarker && typeof origin === "string"
      ? origin
      : null;
  } catch {
    return null;
  }
}
