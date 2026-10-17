/**
 * Small client-side helpers shared by the Browser Panel and Browser Settings.
 * They live apart from both so neither surface imports the other.
 */

export function administrationErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Browser administration failed.";
}

export function browserClientLocale() {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
}

export function browserClientTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Whether BB itself is open on a loopback address, which means the panel is
 * shown on the workspace host. BB Connect and every other address count as
 * remote, and so does anything this cannot read: the cost of guessing wrong
 * toward remote is a softer picture, toward local a slower one.
 */
export function panelViewedOnHost(
  hostname: string | undefined = globalThis.location?.hostname,
) {
  if (hostname === undefined) return false;
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

/**
 * Hand the owner a file through the browser's own download path. Test
 * renderers lack object URLs; there the preview the caller also shows is the
 * whole result, so nothing is lost by skipping the download.
 */
function saveBlob(name: string, blob: Blob) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Decode base64 into bytes, natively where the browser offers it. A frame is
 * hundreds of kilobytes, so the fallback fills the array in one pass instead
 * of mapping each character through a callback.
 */
export function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const withNative = Uint8Array as unknown as {
    fromBase64?: (value: string) => Uint8Array<ArrayBuffer>;
  };
  if (typeof withNative.fromBase64 === "function")
    return withNative.fromBase64(data);
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1)
    bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

/**
 * Save exported client bytes as a browser download so the owner receives the
 * file. Privacy-safe: the bytes are the owner's own quarantined file, and
 * leaving quarantine took an explicit owner decision to get here.
 */
export function saveExportedBytes(
  safeName: string,
  contentType: string | null | undefined,
  data: string | undefined,
) {
  if (data === undefined) return;
  const bytes = base64Bytes(data);
  saveBlob(
    safeName,
    new Blob([bytes], {
      type: contentType === null ? undefined : (contentType ?? undefined),
    }),
  );
}

export function saveJsonFile(name: string, value: unknown) {
  saveBlob(
    name,
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
}
