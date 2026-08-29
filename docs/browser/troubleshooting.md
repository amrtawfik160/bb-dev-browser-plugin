# Browser troubleshooting

Diagnosing Browser Panel states and recovering. Every state below is a value
of the `browserStatusSchema` discriminated union in `contracts.ts`. Start with
readiness, then match the state.

## Start here

```text
bb browser status [--profile <id>] [--host <id>] [--json]
bb browser diagnostics [--profile <id>] [--host <id>] [--json]
```

`status` prints the label, message, and a nine-capability checklist. Use
`diagnostics` when the status asks for repair details; the bundle is redacted
(no URLs, cookies, profile data, scripts, screenshots, or form contents).

## State reference

### `setup-required` (code `setup_required`)

Host setup is incomplete. Setup is resumable and idempotent.

```text
bb browser setup [--json]                                   # show the consent-gated plan
bb browser setup --step <id> --confirm <text> [--json]      # apply one step
```

Valid steps: `dedicated-user`, `system-packages`, `protected-storage`. Treat
`setup_required` as **final for the current call** (agents: report it; do not
retry or provision packages).

### `host-offline`

The host is disconnected. Input freezes; the panel shows offline. On reconnect
the host inventory is reconciled to the same profile. Profiles never fail over
between hosts. If the host stays offline, verify BB Connect enrollment and host
reachability.

### `sleeping`

The instance is idle (asleep after 30 minutes without panel or agent activity).
It wakes on demand. A visible panel or active Control Lease keeps an instance
awake; at most three profiles are awake by default.

### `waking`

The instance is starting. This is transient; re-check `status` shortly.

### `safe-login-elsewhere`

Another panel is in Safe Login Mode for this profile. Agents are excluded for the
duration (they receive `safe_login_denied`). Only the initiating panel receives
Safe Login pixels; other panels show an opaque indicator. Wait for the lease to
end (Done, expiry, or final panel close) or use a different profile.

### `repair-required` (code `repair_required`)

The browser stopped after **three crashes within five minutes** or incompatible
dependency drift. The plugin will not relaunch until repaired.

```text
bb browser diagnostics [--profile <id>] [--host <id>] [--json]
```

Recover by rerunning the relevant setup step or resetting the profile:

```text
bb browser setup --step <id> --confirm <text> [--json]
bb browser reset --profile <id> --confirm <text> [--host <id>] [--json]
```

Browser profiles are never downgraded; health checks report drift but never
silently upgrade system packages.

### `unsupported`

The host platform is not supported in v1 (Ubuntu/Debian x86_64 only). The
plugin never silently installs an unsupported configuration. Use a supported
host.

### `healthy`

Ready. If a panel still does not load, check the Browser Panel transport (BB
Connect session, panel capability redemption) and reconnect behavior.

## Common operations

- **Agent denial** — `origin_denied` with a Grant Request: surface to the owner;
  after approval, retry explicitly. The failed call never resumes automatically.
- **Agent contention** — `browser_busy`: an owner has control, or 5 s elapsed
  waiting behind another agent. Do not queue; surface and let the owner act.
- **Tab not found** — `tab_invalid`: tab IDs are runtime-only. List tabs again
  after any browser or worker restart and retry with a fresh ID.
- **Disk pressure** — new instances and downloads are refused below 5 GiB host
  free space; low-disk is classified as `repair-required` without deleting
  cookies or site storage.
- **Disable/re-enable** — `bb browser disable --confirm "Stop Browser processes"`
  stops processes and retains profiles; re-enabling leaves data intact.
- **Full removal** — `bb browser purge --confirm <text>` removes the system user,
  configuration, and authenticated data (destructive).

## Performance complaints

Host-side performance targets are documented in
[verification-report.md](verification-report.md#performance). Only the awake
tool-dispatch overhead target is asserted in this environment; warm/cold first
frame, real loopback input-to-frame p95, interaction FPS, and resident memory of
a real Chrome process require a provisioned host and are recorded as v1
limitations. **Remote measurements add network RTT** and report it separately.
