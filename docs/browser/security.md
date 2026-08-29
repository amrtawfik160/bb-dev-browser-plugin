# Browser security and privacy

This document defines the trust boundaries, threat model, guarantees, and
exclusions for the **Browser** plugin. It is intended for reviewers and security
owners. Every claim is cross-referenced to the evidence in
[verification-report.md](verification-report.md); every exclusion is recorded in
[limitations.md](limitations.md).

## Trust boundaries

The plugin separates three trust domains.

1. **BB server plugin** owns Profile Grants, Grant Requests, preferences, and
   Activity Records in an append-only transactional SQLite database. It holds
   no credential-bearing Chrome data.
2. **Workspace host** owns browser profiles, Host Downloads, runtime manifests,
   and a bounded durable outbox for host events awaiting server
   acknowledgement. Host inventory is reconciled on reconnect.
3. **Displaying clients** (BB web/PWA/desktop) observe and, when holding the
   Control Lease, drive one shared logical viewport. They never receive raw
   automation endpoints.

Credential-bearing Chrome data **never crosses** from the host to the BB
server (ADR 0012). This split accepts reconciliation complexity so that
authorization follows BB projects without centralizing browser sessions.

## Guarantees

### Dedicated user

Chrome and its display helpers run as a dedicated unprivileged `bb-browser`
operating-system user with Chrome's sandbox enabled, even when BB itself runs as
root (ADR 0006). Running authenticated web content as root with `--no-sandbox`
is unsupported. Setup enforces `runAsUser: "bb-browser"`,
`shell: "/usr/sbin/nologin"`, `sandbox: "required"`, `noSandbox: false`
(verified in `browserSetupPlanSchema`).

### Sandbox

- The `browser_script` tool runs **QuickJS-sandboxed** Playwright code with no
  Node, module, process, or arbitrary host-filesystem or workspace access. A
  `sandbox_violation` typed error is returned on escape attempts (verified in
  `browserScriptRuntimeErrorSchema`).
- Profile data lives in an installation- and host-scoped namespace beneath
  `/var/lib/bb-browser`, owned by `bb-browser`, mode `0700`, with manifests at
  `0600` and stable internal identifiers. Another BB installation on the machine
  cannot attach it accidentally.

### Loopback transport

Chrome, CDP, VNC, and internal helper endpoints bind to **loopback only** and
are never exposed directly (ADR 0007). The retained worker generation chooses a
dynamic loopback gateway port (`127.0.0.1`, `PANEL_GATEWAY_BIND_HOST`) and
declares it only while active. The gateway validates message shapes and sizes
(`PANEL_GATEWAY_MESSAGE_MAX_BYTES`), rate-limits input
(`PANEL_GATEWAY_INPUT_MAX_PER_SECOND = 60`), caps panel bandwidth, and drops
stale video frames before delaying input.

## Authorization surfaces

### Profile Grants

A **Profile Grant** authorizes one BB project to fully automate one profile
within its Origin Scope (ADR 0004). Grants bind to the exact BB project
identifier and cover its providers, threads, environments, and worktrees; they
do not follow copied projects. Deleting a project or revoking a grant interrupts
active agent work without closing the owner's page. Profile Grants confer **full
automation** within scope because arbitrary Playwright scripts cannot be
reliably classified as read-only.

### Panel Capabilities

A **Panel Capability** authorizes transport to one Workspace Browser. It is
**single-use**, expires unredeemed after **60 seconds** (`PANEL_CAPABILITY_TTL_MS`),
binds to one owner session, panel instance, host, and profile, and is redeemed in
the first WebSocket message rather than placed in a URL. Connected authorization
rotates every **5 minutes** (`PANEL_AUTH_ROTATION_MS`) and is revoked on panel
close or profile switch. A Panel Capability **never substitutes for an agent
Profile Grant**.

### Origin Scope

Origin Scope uses exact `scheme://host:port` origins and optional explicit
subdomain patterns (ADR 0004, ADR 0013). URL paths do not narrow a grant; each
localhost port is separate; `*` is a distinct whole-web permission. Cross-origin
subresources may render normally. A denied origin produces a typed
`origin_denied` result and a non-blocking Grant Request.

Enforcement is a policy check on navigation, not request interception:

- `page.goto` on the tab bound for the script is guarded, so the common
  out-of-scope navigation fails immediately and never reaches the network.
  This is a fast path, not the boundary — the sandbox `browser` global is
  frozen and cannot be wrapped, so a page the script fetches itself through
  `browser.getPage` is not guarded.
- After the script finishes, **every tab this call opened or navigated** is
  checked against the scope. That is the boundary: a redirect, an in-page
  navigation, a link click, a popup, or a navigation through an unguarded page
  denies the call and discards the result.

Two limits are worth stating plainly:

- An out-of-scope page **loads** before the second check sees it. The agent
  never receives the result, but the request happened.
- A tab the call never moved is not checked, so Origin Scope constrains
  agent-controlled **navigation**, not reading a tab the owner already had
  open. Checking untouched tabs instead would deny every call whenever an
  unrelated tab sits outside the scope — including a raw `localhost` tab under
  a whole-web grant.

This is a deliberate change from the earlier design, which registered a
`BrowserContext.route` intended to abort out-of-scope navigation before commit.
The sandbox does not call back into agent-supplied JavaScript, so that handler
never ran: every intercepted request hung until the script deadline,
grant-scoped automation could not navigate at all, and no origin was ever
actually checked.

The same limitation removed the per-origin invalid-certificate bypass. Approved
origins are still recorded and reach the policy, but the fulfil-through-fetch
path that was supposed to load them despite a bad certificate depended on the
same route handler and never executed.

### Control Leases

Input is serialized through a **Control Lease** (ADR 0005). Owner interaction
has priority and may interrupt an agent at any time. An agent script receives a
visible, interruptible atomic lease of **at most 30 seconds**. Agent calls fail
immediately while an owner has control and wait at most **5 seconds**
(`CONTROL_LEASE_AGENT_WAIT_MS`) behind another agent before returning a typed
`browser_busy` error; queued work is never retained. On disconnect, the same
panel has **10 seconds** (`PANEL_RECLAIM_WINDOW_MS`) to reclaim its lease before
release.

## Retained data

The plugin minimizes browser-derived persistence (ADR 0009). Chrome owns
cookies, site storage, and native tab/session restoration; the plugin does not
duplicate visited URLs or durable tab identifiers.

**Activity Records** retain metadata only: actor, project, profile, destination
origin, timing, outcome, and interruption state. They **exclude**:

- full scripts and agent-supplied purposes,
- passwords, keystrokes, and form contents,
- page contents, full URLs, and screenshots,
- clipboard contents,
- ordinary owner browsing.

Records expire after **30 days** or **10,000 entries** per profile. The owner
can export or clear them. Grant changes, control transfers, mode transitions,
setup, profile lifecycle, and file exports also produce Activity Records.

**Host Downloads** are untrusted quarantine objects, never auto-opened or
executed, expiring after 7 days. **Transfer Staging** is one-use and removed
after use, cancellation, failure, expiry, worker restart, or profile lifecycle
operations.

## Exclusions

Version one **deliberately does not** do the following (full list in
[limitations.md](limitations.md)):

- Save passwords, address autofill, or payment autofill.
- Enable installable Chrome extensions or Chrome Sync (including extension-based
  password managers and wallets).
- Add a separate unattended encryption key — at-rest protection relies on Chrome,
  installation-scoped owner-only filesystem permissions, and host full-disk
  encryption.
- Bypass TLS certificate errors globally; invalid certificates require a
  separate per-origin owner opt-in.
- Grant camera, microphone, geolocation, notifications, or device permissions.
- Stream audio, or make any DRM or high-fidelity media promise.
- Maintain per-profile proxy configuration or proxy credentials (the host system
  proxy is honored).
- Synchronize profiles between hosts.
- Send analytics, usage telemetry, crash reports, or browser data to any
  external service.

## Incident considerations

- **Generate redacted diagnostics** with `bb browser diagnostics`. The bundle
  excludes URLs, cookies, profile data, scripts, screenshots, and form
  contents; exit logs are capped at 500 characters and 50 entries.
- **Revoke suspect grants** in authenticated Browser Settings. Revocation
  interrupts active agent work without closing the owner's page.
- **Archive or reset** a compromised profile. A full reset archives the prior
  profile, creates a fresh stable profile, and revokes the prior grants. Immediate
  permanent deletion requires `bb browser delete --profile <id> --confirm <name>`
  (typing the profile name).
- **Purge** to remove the system user, configuration, and authenticated browser
  data: `bb browser purge --confirm <text>`.
- **Activity Records** provide an audit trail of who operated which profile, at
  what origin, when, with what outcome and interruption state — without
  sensitive content. Export with `bb browser activity-export`.
- **Credential-bearing archives** (backup/restore) are mode-600,
  same-installation artifacts. Treat a leaked archive as a credential.

## Threat model (summary)

The security evidence suite (`test/evidence/security.evidence.test.ts`,
`test/evidence/sensitive-data.evidence.test.ts`) covers:

- malicious pages and compromised agents/projects,
- stolen or replayed Panel Capabilities,
- hostile redirects and cross-origin frames,
- local-path attacks (path traversal, symlink escape, special files),
- second-client takeover and disconnect-grace behavior,
- sensitive-log scanning across retained surfaces,
- dependency mismatch/drift,
- host disconnect,
- unprivileged execution and loopback-only socket boundaries.

See [verification-report.md](verification-report.md) for the requirement-to-
evidence mapping.
