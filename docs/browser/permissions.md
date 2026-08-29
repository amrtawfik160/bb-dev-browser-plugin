# Browser permissions

The permissions the **Browser** plugin requests and enforces. This complements
[security.md](security.md) (threat model and guarantees) and
[limitations.md](limitations.md) (what is deliberately absent).

## Host and OS-user permissions

- Creates and owns a dedicated unprivileged **`bb-browser`** OS user
  (`/usr/sbin/nologin` shell). Chrome and display helpers run as this user with
  Chrome's sandbox enabled.
- Profile data lives under **`/var/lib/bb-browser`**, installation- and
  host-scoped, owned by `bb-browser`, mode `0700`, with manifests at `0600`.
- Setup is consent-gated: creating the user, configuring secure storage, and
  installing Chrome/display helpers each require explicit owner confirmation.
  Plugin startup never silently changes privileged host state.
- Privileged changes are shown for a separate explicit confirmation before any
  change. Partial failure does not remove installed system packages.

## Browser permissions (denied by default)

The following are **denied in v1**:

- Saved passwords, address autofill, and payment autofill.
- Installable Chrome extensions and Chrome Sync (including extension-based
  password managers and wallets).
- Camera, microphone, geolocation, notifications, and device permissions.
- Audio streaming and DRM/high-fidelity media.

## Network permissions

- Chrome, CDP, VNC, and internal helper endpoints bind to **loopback only** and
  are never exposed directly.
- The retained worker generation chooses a dynamic loopback gateway port
  (`127.0.0.1`) and declares it only while active.
- Remote panel traffic uses BB Connect's owner-session gate and a rotating Panel
  Capability.
- Version one requires BB Connect enrollment even for a locally displayed panel.
- The host system proxy is honored; no per-profile proxy configuration or proxy
  credentials are stored.

## Agent permissions

- Agents are **denied by default**. A Profile Grant authorizes one BB project to
  fully automate one profile within an Origin Scope.
- File transfer and invalid-certificate access are **separate owner opt-ins** on
  top of a grant.
- Agent scripts run QuickJS-sandboxed with no Node, modules, process, or
  filesystem access; `sandbox_violation` is returned on escape attempts.
- Agent-initiated transfers and exports require the `file-transfer` grant and an
  active Control Lease.

## Data permissions

- The server database owns grants, requests, preferences, and Activity Records;
  it holds no credential-bearing Chrome data.
- Activity Records are metadata-only and exclude scripts, purposes, passwords,
  keystrokes, form contents, page contents, URLs, screenshots, and clipboard
  contents.
- Host Downloads are untrusted quarantine objects, never auto-opened or executed.
- Transfer Staging is one-use and removed after use, cancellation, failure,
  expiry, worker restart, or profile lifecycle operations.
- Backups and restores are mode-600, same-installation credential-equivalent
  archives; treat them as credentials.

## Retention permissions

- Profiles and authenticated data are retained on disable/uninstall; only
  `bb browser purge` removes them.
- Archived Profiles: 30 days. Host Downloads: 7 days. Activity Records: 30 days
  or 10,000 entries per profile. Transfer Staging: one-use.
- Server database migrations are append-only and transactional; host manifests
  are versioned and metadata is backed up before migration. An incompatible
  downgrade fails closed; Chrome profiles are never downgraded.

## External services

- Version one sends no analytics, usage telemetry, crash reports, or browser data
  to any external service.
- Diagnostics are local and owner-triggered and are redacted (no URLs, cookies,
  profile data, scripts, screenshots, or form contents).
- BB Connect is the sole existing authenticated remote transport.
