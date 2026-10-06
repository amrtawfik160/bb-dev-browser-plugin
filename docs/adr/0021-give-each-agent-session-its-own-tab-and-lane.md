# Give each agent session its own tab and lane

> Supersedes the control rule of [ADR 0005](0005-share-profile-tabs-while-serializing-control.md):
> profiles still share one tab strip and Browser Instance, but control is no
> longer one lease per profile. Amends ADR 0020's named tab: it now stays in
> the background.

The owner could not use the Workspace Browser while an agent worked. Owner
navigation, history, tab actions, and Take control cancelled a running agent
script (`lease_revoked`), and an agent call made while an owner action ran was
refused (`browser_busy`). In the other direction, every agent script brought
its tab to the front, which moved every Browser Panel to the agent's tab, and
parked the owner's out-of-scope tabs (raw `localhost`, `chrome:`, `file:`
pages, or anything outside an exact-origin grant) on `about:blank` for the
length of the call. Two threads on one shared profile also waited for each
other even though each had its own named tab.

chrome-devtools-axi shows the shape agents and people expect: each agent
session drives its own browser session, sessions run side by side, and a
person's browser is never touched.

## Decision

Each agent session works in its own tab and its own lane.

- **Lanes, not one lease.** Control is held per lane. The owner has one lane;
  each agent session (a thread's named tab, or one explicit tab) has its own.
  Lanes on a profile run concurrently. Within a lane, calls still run in
  arrival order, with the 30-second wait and 30-second script limit. Owner
  actions no longer abort agents, and agents are no longer refused while the
  owner acts. Profile stop, sleep, Safe Login, grant revocation, and host
  disconnect still stop every lane on the profile.
- **Background tab.** Agent scripts never bring their tab to the front, and
  the tab strip keeps the owner's selected tab after a script; tabs an agent
  opened are added to the strip. Chromium runs without background timer
  throttling, renderer backgrounding, or occluded-window pausing so a
  background agent tab runs at full speed.
- **Own session.** Each agent lane connects through its own Session CDP Proxy.
  The proxy exposes only the session's targets: pages it created, popups and
  frames they opened, and an explicitly named tab. Every other target is
  hidden from listings and events and cannot be attached to, closed, or
  activated. Out-of-scope owner tabs are therefore unreadable without parking,
  so the Origin Scope guard applies only to the session's own pages and owner
  tabs are never parked, cleared, or held to an agent's scope.
- **Short commands.** `browser_command` (and `bb plugin run browser do`) runs
  one axi-style command per call: open, snapshot, click/fill/hover/select by
  ref, type, press, scroll, back, wait, eval, screenshot. Responses carry the
  page, a compact accessibility snapshot with generation-stamped refs, and
  next steps; a ref from an older snapshot fails with `STALE_REF`. Commands
  compile to ordinary Browser Scripts, so grants, Origin Scope, lanes, and
  Activity Records are unchanged. `browser_script` remains for multi-step
  Playwright logic.

## Consequences

The owner and any number of agents can use one profile at once without
interrupting each other. A Browser Panel follows only the owner's tab choices;
to watch an agent, the owner selects its tab.

An owner who wants an agent to stop now stops the profile, uses Safe Login, or
revokes the grant; Take control only chooses which panel drives the owner's
view. An owner can still act inside an agent's tab, and the agent then sees
the owner's change as it would any page change.

Background tabs can still differ from a focused tab: `document.visibilityState`
reports `hidden`. Pages that pause work when hidden may need a `screenshot`
or explicit waits.

Each lane holds one extra loopback proxy and one helper browser connection
while its Browser Instance runs; both close when the instance stops.
