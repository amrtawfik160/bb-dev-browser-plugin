import type { OriginScopeMatcher } from "./authorization.js";

/**
 * Origin Scope enforcement during real browser navigation.
 *
 * The server resolves a Profile Grant into an {@link OriginScopeMatcher} and
 * hands it to the host, which injects the {@link enforcementPreambleScript}
 * into the QuickJS-sandboxed Playwright code before the agent script runs. The
 * preamble registers context-level request interception that aborts any
 * navigation request whose destination origin is outside the matcher before
 * its content commits, then signals the denial back to the host through a
 * unique stdout marker so the host can return a typed `origin_denied` result.
 *
 * Only navigation requests (top-level documents, redirects, popups, and
 * sub-document frames) are checked; ordinary cross-origin subresources such as
 * images, scripts, styles, fonts, and XHR continue to render. The matcher is
 * the same normalized policy the server grant store uses, so exact scheme,
 * host, and port matching, explicit subdomain patterns, Project Loopback
 * Aliases, raw localhost fallback, and whole-web access share one policy.
 */

const DENIAL_MARKER_PREFIX = "__bbOriginDenied";

/**
 * Returns the source of a pure function `(origin, matcher) => boolean` that
 * mirrors {@link matcherPermitsOrigin} for the QuickJS sandbox. It is written
 * as a self-contained string so it can be evaluated in a Node `vm` for parity
 * tests and embedded verbatim in the generated preamble.
 */
export function originPermittedFunctionSource(): string {
  return String.raw`function __bbOriginPermitted(origin, matcher) {
  var url;
  try { url = new URL(origin); } catch (error) { return false; }
  var hostname = url.hostname.toLowerCase();
  if (matcher.kind === "whole-web") return !__bbIsRawLocalhost(hostname, matcher.rawLocalhostHosts);
  if (matcher.kind === "never") return false;
  if (matcher.kind === "exact") return matcher.origin === url.origin;
  var protocol = matcher.protocol + ":";
  var portMatches = matcher.port === url.port || (matcher.port === "" && url.port === "");
  return url.protocol === protocol && portMatches && hostname !== matcher.baseHost && hostname.endsWith("." + matcher.baseHost);
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
  var url;
  try { url = new URL(origin); } catch (error) { return false; }
  if (!origins) return false;
  for (var index = 0; index < origins.length; index += 1) {
    if (origins[index] === url.origin) return true;
  }
  return false;
}`;
}

/**
 * Builds the QuickJS preamble that enforces one Origin Scope during real
 * navigation. The preamble registers a context-level route that aborts any
 * navigation request whose destination origin the matcher rejects, and prints
 * a unique denial marker line to stdout so the host can surface a typed
 * `origin_denied` result. A context-level route covers top-level documents,
 * redirects, sub-document frames, and popup pages that share the context, so
 * no per-popup re-registration is needed. It must wrap the agent code so the
 * route is registered first.
 *
 * Per-origin invalid-certificate opt-ins use the same normalized policy: a
 * navigation to an in-scope origin that the grant also approved for invalid
 * certificates is fetched through the shared context request context with
 * `ignoreHTTPSErrors` and fulfilled to the page so it loads despite a bad
 * certificate, while every other navigation continues normally so a bad
 * certificate still surfaces naturally. The dev-browser sandbox strips
 * `ignoreHTTPSErrors` from `route.continue`, so the context request context is
 * the one mechanism that honors per-origin certificate bypass for a connected
 * browser.
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
function __bbReportOriginDenied(origin) {
  console.log(JSON.stringify({ ${JSON.stringify(DENIAL_MARKER_PREFIX)}: __bbDenialMarker, origin }));
}
async function __bbEnforceOriginScope(context) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) {
      await route.continue();
      return;
    }
    let origin;
    try { origin = new URL(request.url()).origin; }
    catch { await route.continue(); return; }
    if (!__bbOriginPermitted(origin, __bbMatcher)) {
      __bbReportOriginDenied(origin);
      await route.abort("blockedbyclient");
      return;
    }
    if (__bbOriginRequiresCertificateBypass(origin, __bbInvalidCertificateOrigins)) {
      const response = await context.request.fetch(request.url(), {
        ignoreHTTPSErrors: true,
        method: request.method(),
        headers: request.headers(),
        // Let redirects re-fire the route so each hop is re-checked against scope.
        maxRedirects: 0,
        timeout: 30000
      });
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
}
const __bbEnforcementPages = await browser.listPages();
if (__bbEnforcementPages.length === 0) throw new Error("The Browser Profile has no open tabs");
const __bbEnforcementPage = await browser.getPage(__bbEnforcementPages[0].id);
await __bbEnforceOriginScope(__bbEnforcementPage.context());
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
