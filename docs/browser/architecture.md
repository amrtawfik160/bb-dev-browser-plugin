# Browser architecture

Runtime architecture and modes for the **Browser** plugin. Architectural
decisions are recorded as ADRs in [`docs/adr/`](../adr/); this document
summarizes the runtime and indexes them.

## Runtime architecture

- A **plugin host worker** owns each browser process, profile, interactive
  stream, and helper process.
- Browser processes run on the **enrolled workspace host** so they can reach
  repository-local services.
- Browser web content and display helpers run as the **dedicated unprivileged
  `bb-browser` OS user** with Chrome's sandbox enabled. Root browsers using
  `--no-sandbox` are unsupported.
- **Official Chrome Stable** is the primary browser; a compatible pinned
  Playwright Chromium is the fallback for ordinary browsing.
- The Playwright fallback is first copied from the mutable cache into a private,
  descriptor-anchored staging tree that accepts only regular files and
  directories, rejecting symlinks and special files. The privileged setup copy
  sees only that normalized tree, then applies `bb-browser` ownership and safe
  modes without promoting mutable cache content into a root-owned setuid sandbox
  helper. Its sandbox requires user namespaces or a separately validated system
  helper.
- `dev-browser` attaches to the plugin-owned Automation Mode endpoint. The
  plugin does not fork its daemon or expose raw automation endpoints. The
  existing `dev-browser` `default` profile remains untouched; the initial plugin
  profile is `bb-personal`.
- The **server plugin SQLite database** owns Profile Grants, Grant Requests,
  preferences, and Activity Records. The **host** owns browser profiles, Host
  Downloads, runtime manifests, and a bounded durable outbox for events awaiting
  acknowledgement. Inventory reconciles whenever the host reconnects; Chrome
  credential data never reaches the server. (ADR 0012)

## Profiles and sessions

- A Browser Profile is local to one workspace host and may be reused by BB
  projects and repositories on that host. Profiles are **never synchronized**
  between machines. (ADR 0001)
- Profile data lives in a BB-installation- and host-scoped namespace beneath
  `/var/lib/bb-browser`, uses stable internal identifiers, is owned by
  `bb-browser`, and is inaccessible to other unprivileged users. Another BB
  installation on the machine cannot attach it accidentally. (ADR 0006)
- Chrome owns cookies, site storage, and native tab/session restoration. The
  plugin does not duplicate browsing history or visited URLs in its database.
  Saved-password storage is disabled. Exact navigation history and unsaved form
  contents are best-effort across restarts. (ADR 0009)
- Browser Tabs belong to a Browser Profile, not a BB thread. Every panel using
  that profile observes the same ordered tab set and one shared active tab.
  (ADR 0005)
- Local development prefers a stable **Project Loopback Alias** such as
  `p-<project-hash>.localhost:<port>`. Raw localhost is an explicit compatibility
  fallback. (ADR 0013)

## Modes

### Automation Mode

- Normal mode for shared owner and authorized-agent observation and control.
- Uses a CDP-backed canvas stream.
- `dev-browser` attaches only in this mode.
- Adaptive 5–15 FPS up to 1920×1080. No audio, DRM, or high-fidelity media in
  v1. (ADR 0007)

### Safe Login Mode

- Owner-only mode for sites that reject automation. Revokes agent observation
  and control and relaunches the same profile without an automation attachment.
- Uses Xvfb, x11vnc, and noVNC for the interactive stream.
- 15-minute lease (extendable once; 30-minute ceiling); warns before expiry;
  exits on **Done**, expiry, or final panel close. (ADR 0002)

See [safe-login.md](safe-login.md) for the full workflow.

## Human and agent control

- All panels receive live state, but only one owner client or agent holds the
  **Control Lease**. Owner interaction has priority and may interrupt an agent at
  any time. (ADR 0005)
- Agent scripts receive visible, interruptible, atomic leases of at most 30
  seconds. Agent calls fail immediately while an owner has control and wait at
  most 30 seconds behind other agents before returning `browser_busy`. Waiting
  calls run in arrival order and are removed on cancellation or owner takeover.
- A persistent **Profile Grant** authorizes one BB project to use one profile
  within an Origin Scope (ADR 0004). A project's first agent operation on a
  profile records a whole-web grant automatically; revoking it in Settings puts
  that project on the Grant Request flow (ADR 0015).
- Agent access is exposed through a native `browser_script` tool, an equivalent
  `bb browser` CLI, and a bundled skill. Those boundaries enforce profile,
  project, origin, timeout, and lease policy. (ADR 0008)

## Transport

- Chrome, CDP, VNC, and internal helper endpoints bind to **loopback** and are
  never exposed directly. (ADR 0007)
- Remote panel traffic uses BB Connect's owner-session gate and a rotating
  **Panel Capability** (single-use, 60 s, redeemed in the first WebSocket
  message; rotation every 5 min; revoked on panel close or profile switch).
- Version one requires BB Connect enrollment even for a locally displayed panel.
  BB mobile is unsupported while it does not mount plugin frontends.
- On connection loss, input freezes immediately and the same panel has 10
  seconds to reclaim its Control Lease before release. Streams reconnect with
  bounded backoff; profiles never fail over between hosts.

## Clipboard, files, and permissions

- Text clipboard exchange is explicit; the plugin never continuously
  synchronizes clipboards.
- The browser OS user never receives repository access. Workspace selections
  resolve through BB's environment file APIs, must remain inside the environment
  after realpath resolution, and are copied into one-use **Transfer Staging**.
  (ADR 0011)
- **Host Downloads** expire after 7 days (defaults 1 GiB/file, 5 GiB/profile),
  are untrusted quarantine objects, and exporting one to a workspace or client
  is explicit.
- Camera, microphone, geolocation, notifications, and device permissions are
  denied in v1.

## Browser security

- Installable Chrome extensions and Chrome Sync are disabled in v1, including
  extension-based password managers and wallets.
- Saved passwords, address autofill, and payment autofill are disabled.
- At-rest protection relies on Chrome, installation-scoped owner-only filesystem
  permissions, and host full-disk encryption; no separate unattended key.
- Exact HTTP localhost and private-network origins may be granted for
  development. Invalid TLS certificates require a separate per-origin owner
  opt-in; global certificate-error bypass is forbidden.
- Version one honors the host system proxy but stores no per-profile proxy
  configuration or proxy credentials.

## Privacy and external services

Version one sends no analytics, usage telemetry, crash reports, or browser data
to any external service. Diagnostics are local and owner-triggered. BB Connect
is the sole existing authenticated remote transport.

## ADR index

| ADR                                                                    | Decision                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| [0001](../adr/0001-run-browser-profiles-on-workspace-hosts.md)         | Run browser profiles on workspace hosts         |
| [0002](../adr/0002-separate-automation-and-safe-login-modes.md)        | Separate automation and safe-login modes        |
| [0003](../adr/0003-let-the-plugin-own-the-browser-runtime.md)          | Let the plugin own the browser runtime          |
| [0004](../adr/0004-treat-agent-access-as-an-explicit-profile-grant.md) | Treat agent access as an explicit profile grant |
| [0005](../adr/0005-share-profile-tabs-while-serializing-control.md)    | Share profile tabs while serializing control    |
| [0006](../adr/0006-run-web-content-as-a-dedicated-user.md)             | Run web content as a dedicated user             |
| [0007](../adr/0007-use-hybrid-owner-gated-streaming.md)                | Use hybrid owner-gated streaming                |
| [0008](../adr/0008-expose-agent-control-through-plugin-boundaries.md)  | Expose agent control through plugin boundaries  |
| [0009](../adr/0009-minimize-browser-derived-persistence.md)            | Minimize browser-derived persistence            |
| [0010](../adr/0010-provision-browser-hosts-explicitly.md)              | Provision browser hosts explicitly              |
| [0011](../adr/0011-broker-files-without-mounting-workspaces.md)        | Broker files without mounting workspaces        |
| [0012](../adr/0012-split-control-state-from-browser-state.md)          | Split control state from browser state          |
| [0013](../adr/0013-namespace-loopback-origins-by-project.md)           | Namespace loopback origins by project           |
