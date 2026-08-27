# Browser Plugin Verification Plan

## Automated coverage

### Policy and state

- Origin parsing, exact/subdomain/wildcard matching, redirects, popups, frames, loopback aliases, elevated flags, grant expiry, one-retry consumption, and revocation.
- Owner/agent contention, lease expiry/interruption, multi-client takeover, disconnect grace, Safe Login exclusivity, and crash-loop transitions.
- Profile create/rename/archive/reset/delete/import/backup, stable installation namespace, quotas, retention, event outbox acknowledgement, and server/host reconciliation.
- Panel Capability binding, single use, expiry, replay rejection, rotation, profile-switch revocation, malformed messages, input rate limits, and congestion frame dropping.

### Storage and filesystem

- Real SQLite append-only migrations, transaction rollback, metadata backup, incompatible downgrade refusal, and retention pruning.
- Owner-only profile modes, dedicated-user ownership, workspace realpath containment, symlink escape rejection, one-use staging cleanup, overwrite refusal, download expiry, and low-disk refusal.

### Host runtime

- Host worker retain/release, idle eviction, reload/dispose, host disconnect/reconnect, child cleanup, profile locking, lazy wake, LRU sleep, and browser crash recovery.
- Browser/display helpers run as `bb-browser` with Chrome sandboxing; Chrome, CDP, VNC, and gateway listeners bind only to loopback.
- Dependency and platform probes produce Setup required, Unsupported, Repair required, and healthy states without silent package changes.

### Browser integration

- A local authentication fixture exercises sign-in, cookies, local/session storage, popup tabs, dialogs, downloads, and Project Loopback Alias behavior.
- Real Chromium tests prove Restorable Session behavior across graceful stop, crash, host-worker restart, and plugin reload.
- QuickJS scripts cannot access Node or the filesystem, obey time/result limits, fail closed on disallowed origins, and return native text/image Browser Results.
- Automation and Safe Login transitions preserve compatible Chrome state while interrupting agents and hiding sensitive pixels.

### Frontend

- Existing-thread and New thread actions, panel deduplication, profile selection, shared active tab, controller transfer, responsive toolbar, all explicit status states, activity/download drawers, Grant Requests, dialogs, and error recovery.
- Keyboard navigation, labels, focus order, contrast, reduced motion, and BB global-shortcut precedence for plugin chrome.

## Manual remote acceptance

Run through the owner's authenticated BB Connect instance:

1. Open Browser Panels from an existing thread and New thread.
2. Create `bb-personal`, open a project-local authenticated fixture, sign in, and confirm the shared tab from a second panel.
3. Transfer owner control between two clients and verify spectators cannot input.
4. Grant one project an exact origin, run `browser_script`, observe its live purpose, and verify its Browser Result in the thread.
5. Trigger a denied origin, approve one retry, retry explicitly, and verify expiry/revocation behavior.
6. Enter Safe Login, verify every other panel is opaque and agents are denied, then return through **Done** and expiry paths.
7. Upload a client file and workspace file, download into quarantine, export without overwrite, and verify cleanup/expiry controls.
8. Sleep and wake the instance, reload the plugin/worker, and confirm authentication and open tabs restore.
9. Exercise host-offline and browser-crash recovery states.
10. Disable and re-enable the plugin and confirm profile data remains intact.

## Performance targets

Measure on the current host after dependencies are installed:

- warm first frame: at most 2 seconds;
- cold first frame: at most 10 seconds;
- awake tool dispatch overhead: below 1 second, excluding script execution;
- loopback input-to-frame p95: below 200 ms;
- interaction stream: at least 10 FPS under the fixture workload;
- resident memory: at most 1.5 GiB per awake profile.

Remote results report network RTT separately and do not hide host-side regressions.

## Security evidence

- Threat-model tests cover malicious pages, compromised agents/projects, stolen or replayed capabilities, redirects, cross-origin frames, local-path attacks, second-client takeover, sensitive-log scanning, dependency mismatch, and host disconnect.
- Process and socket inspection prove the unprivileged execution and loopback-only boundaries.
- Searches across plugin logs, Activity Records, diagnostics bundles, and server storage prove exclusion of cookies, full URLs, scripts, purposes, screenshots, clipboard data, and form input.
- Browser Results are verified as ordinary BB thread content with no duplicate plugin retention.

## Third-party login smoke test

After deterministic acceptance passes, the owner may select a site and enter credentials personally in Safe Login. The check records only pass/fail compatibility and no credential, screenshot, DOM, or URL details. External-site behavior is not a deterministic release gate.
