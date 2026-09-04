# BB Embedded Browser Plugin

Status: accepted design, synthesized into the ready-for-agent local tracker specification. Ticket decomposition is the next phase.

Working identity: **Browser**, plugin ID and CLI namespace `browser`, locally installed first under the MIT license and structured for a later marketplace submission.

Initial package: `bb-plugin-browser` version `0.1.0`, MIT licensed, with `dev-browser` 0.2.9 and the compatible BB SDK pinned exactly. The workspace becomes a local Git repository without a remote; the plugin is installed from its path and is not submitted to a marketplace in v1.

## Goal

Add a full-bleed Browser Panel to BB's existing-thread and New thread right-panel launchers. It provides an interactive, host-local browser whose authenticated session can be shared by the owner and explicitly authorized agents across repositories on the same enrolled host.

The plugin must not claim universal login compatibility. Safe Login Mode improves compatibility with sites that reject automation, but hardware-bound passkeys, DRM, and corporate device policies may still prevent a login.

## Runtime architecture

- A plugin host worker owns each browser process, profile, interactive stream, and helper process.
- Browser processes run on the enrolled workspace host so they can reach repository-local services.
- Browser web content and display helpers run as the dedicated unprivileged `bb-browser` operating-system user with Chrome's sandbox enabled. Root browsers using `--no-sandbox` are unsupported.
- Official Chrome Stable is the primary browser. A compatible pinned Playwright Chromium is the fallback for ordinary browsing.
- `dev-browser` attaches to the plugin-owned Automation Mode endpoint. The plugin does not fork its daemon or expose raw automation endpoints.
- The existing `dev-browser` `default` profile remains untouched. The initial plugin profile is `bb-personal`; importing an existing profile is a later explicit operation.
- A Browser Instance sleeps after 30 minutes without panel or agent activity. Its Browser Profile and Restorable Session remain on disk.
- Exactly one Browser Instance may use a profile on a host. At most three profiles are awake by default; a visible panel or active Control Lease keeps its instance awake, and the least-recently-used hidden instance sleeps when capacity is needed.
- Active operations fail on a browser crash. The plugin attempts a clean restart, but stops and exposes repair diagnostics after three crashes within five minutes. Instances wake lazily after BB or host restarts, and updates never restart active work.
- The server plugin SQLite database owns Profile Grants, Grant Requests, preferences, and Activity Records. The host owns browser profiles, Host Downloads, runtime manifests, and a bounded durable outbox for events awaiting acknowledgement; inventory reconciles whenever the host reconnects, and Chrome credential data never reaches the server.

## Profiles and sessions

- A Browser Profile is local to one workspace host and may be reused by BB projects and repositories on that host.
- Profiles are never synchronized between machines.
- Profile data lives in a BB-installation- and host-scoped namespace beneath `/var/lib/bb-browser`, uses stable internal identifiers, is owned by `bb-browser`, and is inaccessible to other unprivileged users. Another BB installation on the machine cannot attach it accidentally.
- Settings can create, rename, archive, and delete profiles.
- An Archived Profile is stopped, loses all Profile Grants, and is retained for 30 days. Immediate permanent deletion requires typing its name, and the current default cannot be removed until another default is selected.
- Existing `dev-browser` profiles are imported only while stopped through a staged, compatibility-checked copy into a new stable identifier. Promotion is atomic, the source remains untouched, and incompatible encrypted state causes a clean abort rather than a weaker Chrome configuration.
- An existing thread resolves the host from its environment. New thread remembers the selected project's last host and profile; ambiguous or projectless compose shows a host picker, and a host without a remembered profile uses `bb-personal`.
- Local development prefers a stable Project Loopback Alias such as `p-<project-hash>.localhost:<port>` so repositories reusing a port do not share cookies or grants. Raw localhost is an explicit compatibility fallback.
- Chrome owns cookies, site storage, and native tab/session restoration. The plugin does not duplicate browsing history or visited URLs in its database.
- Saved-password storage is disabled. Exact navigation history and unsaved form contents are best-effort across process restarts.
- Browser Tabs belong to a Browser Profile, not a BB thread. Every panel using that profile observes the same ordered tab set.
- A clean profile skips welcome pages and opens `about:blank`; later starts restore the active tab. Address input uses a valid URL directly and otherwise delegates to Chrome's configured search engine.
- Profile locale and timezone are captured from the creating owner client, remain stable across displaying clients, and are editable in Settings.
- Ordinary disk cache is capped at 512 MiB per profile. The owner is warned above 2 GiB total profile data; cookies and site storage are never deleted automatically. New instances and downloads are refused below 5 GiB host free space.

## Modes

### Automation Mode

- Normal mode for shared owner and authorized-agent observation and control.
- Uses a CDP-backed canvas stream.
- `dev-browser` attaches only in this mode.

### Safe Login Mode

- Explicit owner-only mode for sites that reject automation.
- Revokes agent observation and control and relaunches the same profile without an automation attachment.
- Uses Xvfb, x11vnc, and noVNC for the interactive stream.
- A lease lasts 15 minutes, warns before expiry, can be extended, and exits when its final Safe Login panel closes.
- Entering the mode warns about unsaved transient state, interrupts agents, and gracefully restarts Chrome. Choosing **Done**, expiry, or closing the final panel gracefully returns the same profile to Automation Mode.
- Only the initiating panel receives Safe Login pixels. Other owner panels show an opaque mode indicator, while agents receive neither pixels nor DOM access.

## Human and agent control

- All panels receive live state, but only one owner client or agent holds the Control Lease.
- A second owner client is view-only until it explicitly chooses **Take control**.
- Owner interaction has priority and may interrupt an agent at any time.
- Agent scripts receive visible, interruptible, atomic leases no longer than 30 seconds.
- Agent calls fail immediately while an owner has control. They wait at most five seconds behind another agent before returning a typed `browser_busy` error; commands are never retained for later execution.
- Agents are denied by default. A persistent Profile Grant authorizes one BB project to use one profile at explicit web origins; unrestricted origins require a separate owner opt-in.
- Origin Scopes use exact `scheme://host:port` origins and optional explicit subdomain patterns. URL paths do not narrow a grant, each localhost port is separate, and `*` is a distinct whole-web permission.
- Profile Grants confer full automation within their Origin Scope because arbitrary Playwright scripts cannot be reliably classified as read-only. File transfer remains a separate grant flag.
- Disallowed HTTP(S) and embedded-origin `blob:` requests are aborted before
  commit by the host route. Direct agent non-web `Frame.goto` is rejected before
  its Playwright navigation command reaches Chromium; renderer-initiated
  location changes, redirects, popups, and frame documents use the CDP guard and
  fail closed by removing denied pages. Exact `about:blank` is the only safe
  internal exception; other non-web document navigation fails closed. Pinned
  Chromium may expose a non-cancellable precommit event for a raw direct
  `data:` loader, so the guarantee is typed denial plus cleanup on that path.
  Cross-origin subresources may render normally, while agents cannot target a
  cross-origin frame without a matching grant.
- A denied web origin produces a typed `origin_denied` result and a non-blocking Grant Request containing the exact project, profile, origin, and requested elevated flags. Non-web navigation produces the typed denial with no origin or Grant Request. The owner may permit the next matching retry, one hour, or persistent access; the default is one retry, and the failed script never resumes automatically.
- Grant Requests expire after 15 minutes. A one-retry authorization expires after five minutes or use; whole-web, file-transfer, and invalid-certificate access defaults to one hour and requires a second confirmation to persist.
- Grants bind to the exact BB project identifier and cover its providers, threads, environments, and worktrees. They do not follow copied projects; deleting a project or revoking a grant interrupts active agent work without closing the owner's page.
- Agent access is exposed through a native `browser_script` tool, an equivalent `bb browser` CLI, and a bundled browser skill. Those boundaries enforce profile, project, origin, timeout, and lease policy.
- `browser_script` is registered statically and remains callable without restarting provider sessions. It derives host and project from BB context, accepts an optional profile/runtime tab identifier, a required human-readable purpose, QuickJS-sandboxed Playwright code with no Node or filesystem access, and a timeout capped at 30 seconds. The purpose is shown as agent-supplied text only while the lease is live and then discarded.
- Browser Results are structured text/JSON capped at 256 KiB plus explicitly requested native image outputs. They become ordinary BB thread content and may enter provider context; the plugin keeps no additional copy.
- Tab identifiers are opaque and runtime-only. Omitting one uses the active tab; targeting another makes it visibly active, and agents list tabs again after a restart.

## Browser Panel

- Register both `threadPanelAction` and `experimental_newThreadPanelAction`; v1 does not add a left-navigation browser.
- Use BB's flush panel layout and support panel maximization.
- Use BB components, typography, spacing, light/dark themes, and a built-in globe glyph rather than custom visual branding. Keep the toolbar compact, collapse secondary controls at narrow widths, and dedicate remaining space to the browser canvas.
- Include back, forward, reload, address/search, profile selection, shared tab controls, controller and mode indicators, downloads, and activity.
- Popups become shared Browser Tabs.
- Multiple BB web or desktop clients can observe the same profile state.
- Every profile has one shared active tab. Switching it requires control and all spectator panels follow; popup windows are normalized into the shared tab strip.
- The controlling panel drives one shared logical viewport within supported bounds. Other panels scale and letterbox it, and controller resize events are debounced to keep page layout stable.
- Alert, confirm, prompt, and before-unload dialogs are rendered in BB, with unresolved agent dialogs dismissed when their Control Lease ends. Automation Mode provides common link/image actions but omits native Chrome context menus and DevTools in v1; Safe Login retains native browser UI through VNC.
- Each BB surface keeps at most one Browser Panel tab per profile. Repeated Browser actions focus the existing tab, while selecting another profile opens or focuses that profile's tab.
- The panel has explicit Setup required, Host offline, Waking, Safe Login elsewhere, Repair required, and Unsupported states.
- Plugin chrome targets WCAG AA, supports keyboard and screen readers, honors reduced motion, and yields BB global shortcuts. The streamed webpage canvas is not fully screen-reader accessible in v1 and is documented as such.
- Downloads, Grant Requests, and crashes use BB in-app badges, toasts, and the activity drawer; v1 adds no OS push notifications.

## Transport

- Chrome, CDP, VNC, and internal helper endpoints bind to loopback and are never exposed directly.
- Remote panel traffic uses BB Connect's owner-session gate and a rotating Panel Capability.
- The Panel Capability authorizes transport to one Workspace Browser; it never substitutes for an agent Profile Grant.
- A Panel Capability is single-use, expires unredeemed after 60 seconds, binds to one owner session, panel instance, host, and profile, and is redeemed in the first WebSocket message rather than placed in a URL. Connected authorization rotates every five minutes and is revoked on panel close or profile switch.
- Version one requires BB Connect enrollment even for a locally displayed panel, providing one authenticated transport for web/PWA and desktop. BB mobile is unsupported while it does not mount plugin frontends.
- On connection loss, input freezes immediately and the same panel has ten seconds to reclaim its Control Lease before release. Streams reconnect with bounded backoff and show an offline state; profiles never fail over between hosts.
- Automation Mode adapts between 5 and 15 FPS up to 1920×1080. Version one streams no audio and makes no DRM or high-fidelity media promise.
- Each retained worker generation chooses a dynamic loopback gateway port and declares it only while active. The gateway validates message shapes and sizes, rate-limits input, caps panel bandwidth, and drops stale video frames before delaying input.

## Clipboard, files, and permissions

- Text clipboard exchange is explicit; the plugin never continuously synchronizes clipboards.
- Uploads may come from the displaying client or an explicitly selected workspace file.
- The browser operating-system user never receives repository access. Workspace selections resolve through BB's environment file APIs, must remain inside the environment after realpath resolution, and are copied into one-use Transfer Staging that is removed after use.
- Host Downloads expire after seven days. Defaults are 1 GiB per file and 5 GiB per profile, configurable by the owner.
- Host Downloads are untrusted quarantine objects: the plugin never auto-opens or executes them, and exporting one to a workspace or client is explicit.
- Export never overwrites an existing workspace file without separate owner confirmation, and agent export requires the file-transfer grant.
- Camera, microphone, geolocation, notifications, and device permissions are denied in v1.

## Browser security

- Installable Chrome extensions and Chrome Sync are disabled in v1, including extension-based password managers and wallets.
- Saved passwords, address autofill, and payment autofill are disabled.
- At-rest protection relies on Chrome, installation-scoped owner-only filesystem permissions, and host full-disk encryption; the plugin does not maintain a separate unattended encryption key.
- Exact HTTP localhost and private-network origins may be granted for development. Invalid TLS certificates require a separate per-origin owner opt-in; global certificate-error bypass is forbidden.
- Version one honors the host system proxy but stores no per-profile proxy configuration or proxy credentials.

## Profile maintenance

- Settings can clear one origin's site data, clear caches, or reset a profile after confirmation and stopping its instance.
- A full reset archives the prior profile, creates a fresh stable profile, and revokes the prior grants.
- Profile backup is an explicit stopped-profile operation producing a mode-600 credential-equivalent archive for best-effort restore to the same host and BB installation. There is no automatic, portable, or cross-host session backup.

## Activity records

- Agent operations retain only actor, project, profile, destination origin, timing, outcome, and interruption metadata.
- Grant changes, control transfers, mode transitions, setup, profile lifecycle, and file exports also produce Activity Records.
- Full scripts, passwords, keystrokes, form contents, page contents, screenshots, and clipboard contents are not retained.
- Ordinary owner browsing and full URLs are not retained.
- Records expire after 30 days or 10,000 entries per profile, whichever comes first.
- The owner can export or clear retained metadata.
- An explicitly generated diagnostics bundle may include dependency versions, capability results, process states, resource use, and redacted exit logs. It excludes URLs, cookies, profile data, scripts, screenshots, and form contents.

## Setup and support

- Version one supports Ubuntu and Debian on x86_64. Other hosts receive a capability-gated unsupported state rather than a partial install.
- Settings exposes a setup checklist; `bb browser setup` provides the CLI equivalent.
- Creating `bb-browser`, configuring secure storage, and installing Chrome or display helpers requires explicit owner confirmation. Plugin startup never silently changes privileged host state.
- Compatible `dev-browser` and Playwright fallback versions are pinned. Chrome Stable updates through its signed system repository.
- Health checks report incompatible drift; the plugin never silently upgrades system packages.
- Setup is resumable and idempotent. Partial failure does not silently remove installed system packages.
- Disabling or uninstalling the plugin stops its processes but retains profiles. Only an explicit destructive `bb browser purge` removes the system user, configuration, and authenticated browser data.
- Server database migrations are append-only and transactional; host manifests are versioned and metadata is backed up before migration. An incompatible downgrade fails closed, and Chrome profiles are never downgraded.
- Code and non-privileged verification complete before current-host provisioning. The exact operating-system user, packages, directories, and permissions are shown for a separate explicit owner confirmation before any privileged change.

## Privacy and external services

- Version one sends no analytics, usage telemetry, crash reports, or browser data to an external service.
- Diagnostics are local and owner-triggered. BB Connect remains the sole existing authenticated remote transport.

## Delivery contract

- Implement in tested vertical slices: storage/policy/setup; profile runtime and agent interface; Automation Mode and Browser Panel; Safe Login and transfers; then recovery, hardening, and documentation.
- Required automated coverage includes policy and state units, real SQLite migrations, host-worker lifecycle, frontend interactions and accessibility, and real Chromium integration against a local authenticated fixture, including browser and worker restart persistence.
- Required remote acceptance through the owner's current BB Connect instance covers both panel actions, profile creation, local-app login persistence, shared tabs and control, agent access and denial, Safe Login opacity, transfers, sleep/wake, and recovery.
- Real third-party credentials never enter automated fixtures. After the deterministic suite passes, the owner may perform a manual smoke test against a site of their choice.
- Target performance on the current host is: warm first frame within two seconds, cold first frame within ten seconds, awake agent-tool overhead below one second excluding script work, local input-to-frame p95 below 200 ms, at least 10 FPS during interaction, and at most 1.5 GiB RAM per awake profile. Remote measurements add network RTT.
- Security evidence covers malicious pages, compromised agents/projects, capability replay, hostile redirects and frames, path traversal and symlinks, second-client takeover, log leakage, dependency drift, and host loss. Tests prove helpers are unprivileged, profile data is owner-only, and browser/CDP/VNC endpoints never bind externally.
- Failure tests exercise browser crashes and crash loops, host reconnect, worker reload, expiry and revocation, failed import, low disk, corrupt manifests, incompatible downgrade, partial setup, and interrupted Safe Login transitions.
- Release gates are formatting, linting, type checking, all tests, production build, clean-code review, test-quality review, documentation review, and a blast-radius check, followed by fixes and reruns for confirmed findings.
- Shipping documentation includes quickstart, setup and purge, architecture, threat model, permissions, CLI/tool reference, Safe Login, troubleshooting, limitations, third-party notices, and a verification report.
