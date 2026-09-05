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
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
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
