import type { BrowserProfileInventory } from "../shared/contracts.js";

export function presentBrowserSessions(
  inventory: BrowserProfileInventory,
  options: {
    site?: string;
    includeArchived: boolean;
    offset: number;
    limit: number;
  },
  recentOrigins: (profileId: string) => string[],
) {
  const site = options.site?.toLowerCase();
  const matches = (origin: string) =>
    site === undefined || origin.toLowerCase().includes(site);
  const sessions = inventory.profiles
    .filter(
      (profile) => options.includeArchived || profile.state !== "archived",
    )
    .map((profile) => ({
      profileId: profile.profileId,
      name: profile.name,
      state: profile.state,
      selected: profile.selected,
      reusable: profile.reusable === true,
      sites: (profile.sites ?? []).filter(({ origin }) => matches(origin)),
      recentOrigins: recentOrigins(profile.profileId).filter(matches),
    }))
    .filter(
      (session) =>
        site === undefined ||
        session.sites.length > 0 ||
        session.recentOrigins.length > 0,
    )
    .sort((a, b) => {
      const signedIn = (session: typeof a) =>
        session.sites.some(({ status }) => status === "signed-in") ? 1 : 0;
      return (
        signedIn(b) - signedIn(a) ||
        Number(b.selected) - Number(a.selected) ||
        a.profileId.localeCompare(b.profileId)
      );
    });
  const end = options.offset + options.limit;
  return {
    hostId: inventory.hostId,
    selectedProfileId: inventory.selectedProfileId,
    sessions: sessions.slice(options.offset, end),
    total: sessions.length,
    nextOffset: end < sessions.length ? end : null,
    note: "Sites are dated sign-in confirmations, not live authentication checks. recentOrigins are prior agent activity, not proof of sign-in. Verify the site with browser_script before use. Cookies stay in the profile on this host.",
  };
}
