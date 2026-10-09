export const REAL_BROWSER_TEST_HOST_ID = "ci-browser-host";

// Real-browser tests create and delete Browser Profiles under the host they
// target. Pointing them at a live host races agent listings of that host's
// profiles folder, so only dedicated `ci-` test hosts are allowed.
export function realBrowserTestHostId() {
  const hostId =
    process.env.BB_BROWSER_REAL_HOST_ID || REAL_BROWSER_TEST_HOST_ID;
  if (!hostId.startsWith("ci-")) {
    throw new Error(
      `BB_BROWSER_REAL_HOST_ID must name a dedicated test host (ci-*), not ${hostId}. Real-browser tests must never write into a live host's Browser Profiles.`,
    );
  }
  return hostId;
}
