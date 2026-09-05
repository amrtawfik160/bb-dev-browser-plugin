# Browser verification report

This report maps every parent requirement from
[`docs/browser-plugin-spec.md`](../browser-plugin-spec.md) (and the
[`docs/verification-plan.md`](../verification-plan.md) decomposition) to
automated evidence, planned human acceptance, or an explicit version-one
limitation. It cross-references the test/evidence suites from issue #21, the
contract tests from issues #2–#20, and the issue #64 and #66 boundary
corrections.

## Evidence status legend

- **Automated** — exercised by a passing test in `test/`. The test file is
  cited.
- **Planned human acceptance** — requires the owner's authenticated BB Connect
  session and is listed in the manual acceptance plan. Not asserted by a
  deterministic test.
- **Limitation** — a version-one scope decision. Recorded in
  [limitations.md](limitations.md); the limitation test is skipped
  deterministically when the provisioned-host gate is off and does not assert a
  boundary it cannot satisfy.

Baseline at the issue #21 head (`41ad3be`): **637 passed, 13 skipped** across
**48 passed / 3 skipped** test files (`npm run test`). Skips are the
`BB_BROWSER_REAL_INTEGRATION=1` provisioned-host tests, which run under
`npm run test:real-browser` against a healthy enrolled host.

## Requirement-to-evidence mapping

### Goal and launch surfaces

| Requirement                                                           | Evidence                                                                                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser Panel on existing-thread and New-thread right-panel launchers | Automated: `test/public-plugin.contract.test.tsx` (verifies `threadPanelAction` and `experimental_newThreadPanelAction`, flush layout, Globe glyph).                 |
| Host-local browser shared by owner and authorized agents              | Automated: `test/browser-auth.integration.test.ts` (real-Chromium fixture), `test/evidence/black-box-harness.evidence.test.tsx`.                                     |
| Not a universal login compatibility claim                             | Limitation: [limitations.md](limitations.md#third-party-login); `test/browser-safe-login.integration.test.ts` covers mode behavior without claiming universal login. |

### Runtime architecture

| Requirement                                                                                                                     | Evidence                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin host worker owns processes, profiles, stream, helpers                                                                    | Automated: `test/host-browser-runtime.contract.test.ts`, `test/browser-process.integration.test.ts`, `test/evidence/storage-failure.evidence.test.ts` (clean dispose).                                |
| Web content and helpers run as `bb-browser` with Chrome sandbox                                                                 | Automated: `test/evidence/security.evidence.test.ts`, `test/host-readiness.contract.test.ts`, and `test/host-operations.contract.test.ts` (safe fallback staging).                                    |
| Chrome Stable primary, pinned Playwright Chromium fallback                                                                      | Automated: `test/package-contract.test.ts`, `test/evidence/security.evidence.test.ts`; pinned in `dependency-inventory.ts`.                                                                           |
| `dev-browser` attaches to plugin-owned Automation Mode; `default` profile untouched; `bb-personal` initial                      | Automated: `test/browser-runtime.contract.test.ts`, `test/browser-auth.integration.test.ts`.                                                                                                          |
| Instance sleeps after 30 min; ≤ 3 awake; LRU sleep; lazy wake                                                                   | Automated: `test/evidence/restorable-session.evidence.test.ts` (idle sleep, visible pin prevents sleep); constants in `browser-runtime.ts` (`DEFAULT_IDLE_SLEEP_MS`, `DEFAULT_AWAKE_INSTANCE_LIMIT`). |
| Three crashes in five minutes → repair diagnostics                                                                              | Automated: `browser-runtime.ts` (`CRASH_LIMIT = 3`, `CRASH_WINDOW_MS`); `test/browser-runtime.contract.test.ts`; `test/evidence/storage-failure.evidence.test.ts`.                                    |
| Server DB owns grants/requests/preferences/activity; host owns profiles/downloads/manifests/outbox; reconciliation on reconnect | Automated: `test/host-activity-outbox.contract.test.ts`, `test/evidence/storage-failure.evidence.test.ts` (host-offline → healthy reconciliation).                                                    |

### Profiles and sessions

| Requirement                                                                                                                  | Evidence                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile local to one host; reused across repositories; never synced                                                          | Automated: `test/profile-storage.contract.test.ts`, `test/host-profiles.contract.test.ts`. Limitation: no cross-host sync ([limitations.md](limitations.md#cross-host-sync)).         |
| Installation/host-scoped namespace under `/var/lib/bb-browser`, `0700`, manifests `0600`, stable IDs                         | Automated: `test/profile-storage.contract.test.ts`; `browserSetupPlanSchema` literals.                                                                                                |
| Create/rename/archive/delete profiles; archived 30 days; delete requires typing name; default removal blocked                | Automated: `test/profile-lifecycle.contract.test.ts`, `test/profile-recovery.contract.test.ts`; `PROFILE_ARCHIVE_RETENTION_DAYS`.                                                     |
| Import stopped `dev-browser` profile via staged compatibility-checked copy; atomic promotion; clean abort on encrypted state | Automated: `test/profile-recovery.contract.test.ts`; `browserProfileRecoveryProgressSchema` (`validating→copying→promoting→completed`).                                               |
| Existing thread resolves host from environment; New thread remembers last host/profile; host picker; `bb-personal` default   | Automated: `test/public-plugin.contract.test.tsx` (host choices); `DEFAULT_PROFILE_ID`.                                                                                               |
| Project Loopback Alias preferred; raw localhost explicit fallback                                                            | Automated: `test/origin-scope.contract.test.ts`, `test/browser-origin-scope.integration.test.ts`.                                                                                     |
| Chrome owns cookies/storage/tab restoration; plugin duplicates no URLs/history; saved passwords disabled                     | Automated: `test/evidence/sensitive-data.evidence.test.ts` (no URL/script retention); Limitation: best-effort session history ([limitations.md](limitations.md#session-restoration)). |
| Tabs belong to profile, not thread; one shared active tab; popups normalized                                                 | Automated: `test/browser-tabs.contract.test.ts`, `test/browser-navigation.contract.test.ts`.                                                                                          |
| Clean profile skips welcome, opens `about:blank`; later starts restore active tab                                            | Automated: `browserProfileStartupSchema` literals (`about:blank`, `--no-first-run`, `--no-default-browser-check`); `test/browser-auth.integration.test.ts`.                           |
| Locale/timezone captured from creating client, stable, editable                                                              | Automated: `test/profile-lifecycle.contract.test.ts`.                                                                                                                                 |
| Refuse new instances/downloads below 5 GiB host free space                                                                   | Automated: `readiness.ts` (`FIVE_GIB`, `disk-headroom` capability → `repair-required`); `test/host-readiness.contract.test.ts`; `test/evidence/storage-failure.evidence.test.ts`.     |

### Memory, retention, and host cgroup boundaries

| Claim                                                                                                                            | Evidence                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser Instances run in the BB host daemon's shared cgroup; no per-instance memory slice is reserved                            | Limitation: [limitations.md](limitations.md#memory); the host worker owns the process boundary (`browser-process.ts`).                                                                                              |
| `--renderer-process-limit=8` is a soft Chromium process-reuse hint, not a renderer ceiling                                       | Automated: `test/browser-process.integration.test.ts` launches pinned Chromium 145 with the flag and observes more than eight renderers; Limitation: [limitations.md](limitations.md#memory).                       |
| The production boundary fails closed when more than eight live renderer descendants are observed or the count cannot be verified | Automated: `test/browser-process.integration.test.ts` (pinned Chromium process-tree enforcement); `browser-process.ts` and `browser-runtime.ts` enforce launch, recovery, operation, navigation, and restart paths. |
| `--js-flags=--max-old-space-size=512` remains a per-renderer V8 old-space setting, not a total-browser memory cap                | Automated: `test/browser-runtime.contract.test.ts` (launch arguments); Limitation: [limitations.md](limitations.md#memory) (native and total-memory scope).                                                         |
| The shared 64-tab retention cap closes evicted live pages and is separate from renderer-process enforcement                      | Automated: `test/browser-tabs.contract.test.ts`, `test/host-browser-runtime.contract.test.ts`; implementation in `browser-tabs.ts` and `browser-runtime.ts`.                                                        |
| Native, GPU, other non-renderer memory, and shared-cgroup pressure remain outside the renderer/V8 bound                          | Limitation: [limitations.md](limitations.md#memory).                                                                                                                                                                |
| Operators may apply a host-daemon `MemoryMax`; Chromium renderer `oom_score_adj` behavior remains host-kernel policy             | Limitation: [limitations.md](limitations.md#memory).                                                                                                                                                                |

### Modes — Automation

| Requirement                                                | Evidence                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CDP-backed canvas stream; `dev-browser` attaches only here | Automated: `test/browser-screencast.contract.test.ts`, `test/browser-panel-transport.integration.test.ts`. |

### Modes — Safe Login

| Requirement                                                                  | Evidence                                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Owner-only; revokes agent observation/control; relaunches without automation | Automated: `test/safe-login.contract.test.ts`, `test/browser-safe-login.integration.test.ts`.                    |
| Xvfb/x11vnc/noVNC stream                                                     | Automated: `test/browser-safe-login.integration.test.ts` (display helpers run as `bb-browser`, loopback).        |
| 15-min lease, expiry warning, extendable, exits on Done/expiry/final close   | Automated: `safe-login.ts` constants; `test/safe-login.contract.test.ts`.                                        |
| Only initiating panel gets pixels; others opaque; agents denied              | Automated: `test/browser-safe-login.integration.test.ts`; `browserScriptRuntimeErrorSchema` `safe_login_denied`. |

### Human and agent control

| Requirement                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One Control Lease; owner priority; second owner view-only until Take control                                                                                                                            | Automated: `test/control-lease.contract.test.ts`, `test/panel-control-state.contract.test.ts`, `test/panel-multi-client.contract.test.ts`.                                                                                       |
| Agent leases ≤ 30 s, visible, interruptible, atomic                                                                                                                                                     | Automated: `test/control-lease.contract.test.ts`; `BROWSER_SCRIPT_MAX_TIMEOUT_MS`.                                                                                                                                               |
| Agent fails immediately while owner has control; ≤ 30 s behind other agents → `browser_busy`; expired/cancelled waiters never run                                                                       | Automated: `test/control-lease.contract.test.ts`, `test/public-plugin.contract.test.tsx`; `CONTROL_LEASE_AGENT_WAIT_MS`.                                                                                                         |
| Default Access records a whole-web Profile Grant on first use; revoking it restores the Grant Request flow; elevations separate opt-in                                                                  | Automated: `test/authorization.contract.test.ts`, `test/origin-scope.contract.test.ts`, `test/grant-requests.contract.test.ts`.                                                                                                  |
| Origin Scope exact origins + subdomain patterns; paths don't narrow; localhost ports separate; `*` whole-web                                                                                            | Automated: `test/origin-scope.contract.test.ts`, `test/origin-scope-host.contract.test.ts`, `test/browser-origin-scope.integration.test.ts`.                                                                                     |
| Grants confer full automation; file transfer separate flag                                                                                                                                              | Automated: `test/authorization.contract.test.ts`.                                                                                                                                                                                |
| Navigation policy uses route, protocol, and CDP boundaries; cleanup and exceptions preserved                                                                                                            | Automated: `test/origin-scope-host.contract.test.ts`, `test/agent-script.contract.test.ts`, `test/origin-scope-runtime.integration.test.ts`.                                                                                     |
| Web `origin_denied` + non-blocking Grant Request; non-web typed denial without a request; retry/1 h/persistent; default one retry; no auto-resume                                                       | Automated: `test/grant-requests.contract.test.ts`, `test/public-plugin.contract.test.tsx`, `test/origin-scope-host.contract.test.ts`.                                                                                            |
| Grant Request expiry 15 min; one-retry 5 min; whole-web/file-transfer/invalid-cert default 1 h + second confirm                                                                                         | Automated: `test/grant-requests.contract.test.ts`; `grant-requests.ts` constants.                                                                                                                                                |
| Grants bind to project id; cover providers/threads/environments/worktrees; don't follow copied projects; revoke interrupts work                                                                         | Automated: `test/authorization.contract.test.ts`, `test/grant-requests.contract.test.ts`.                                                                                                                                        |
| CLI has no owner authority; grant administration fails closed to authenticated Settings; URL open is agent-attributed; no-URL open discloses no tab state                                               | Automated: `test/public-plugin.contract.test.tsx` (privilege escalation, Activity attribution, no-URL disclosure, expired file-transfer elevation).                                                                              |
| `browser_script` native tool + `bb browser` CLI + bundled skill; boundaries enforce policy                                                                                                              | Automated: `test/public-plugin.contract.test.tsx` (tool registration, skill config); `server.ts` `registerCli`/`registerAgentTool`.                                                                                              |
| `browser_script` statically registered; derives host/project from context; optional profile/tab; required purpose; QuickJS sandbox; 30 s cap; page-to-browser root cut; purpose shown only during lease | Automated: `test/browser-runtime.contract.test.ts`, `test/agent-script.contract.test.ts`, `test/evidence/security.evidence.test.ts` (QuickJS isolation), `test/evidence/sensitive-data.evidence.test.ts` (purpose not retained). |
| Accepted script timeouts are 1–30 s; shared-context Playwright deadlines retain host headroom for existing and future supported pages                                                                   | Automated: `test/agent-script.contract.test.ts`, `test/agent-script.playwright.integration.test.ts`, `test/public-plugin.contract.test.tsx` (999 ms rejection and 1,000 ms boundary).                                            |
| Browser Results ≤ 256 KiB + explicit screenshots; ordinary thread content; no plugin copy                                                                                                               | Automated: `BROWSER_SCRIPT_RESULT_LIMIT_BYTES`, `browserScriptResultSchema`; `test/evidence/sensitive-data.evidence.test.ts`.                                                                                                    |
| Tab IDs opaque, runtime-only; omit = active tab; list again after restart                                                                                                                               | Automated: `test/browser-tabs.contract.test.ts`; SKILL guidance.                                                                                                                                                                 |

### Browser Panel

| Requirement                                                                                                                            | Evidence                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both `threadPanelAction` and `experimental_newThreadPanelAction`; no left-nav browser in v1                                            | Automated: `test/public-plugin.contract.test.tsx`.                                                                                                                   |
| Flush layout; maximization; BB components/themes; globe glyph; compact toolbar                                                         | Automated: `test/public-plugin.contract.test.tsx`.                                                                                                                   |
| Toolbar: back/forward/reload/address/profile/tabs/controller/mode/downloads/activity                                                   | Automated: `test/public-plugin.contract.test.tsx`, `test/panel-dialogs-ui.test.tsx`, `test/panel-downloads-ui.test.tsx`.                                             |
| Popups become shared tabs; multiple clients observe same profile state                                                                 | Automated: `test/browser-navigation.contract.test.ts`, `test/panel-multi-client.contract.test.ts`.                                                                   |
| One shared active tab; switch requires control; spectators follow; popups normalized                                                   | Automated: `test/browser-tabs.contract.test.ts`, `test/panel-control-state.contract.test.ts`.                                                                        |
| Controller drives shared viewport ≤ 1920×1080; spectators scale/letterbox; resize debounced                                            | Automated: `PANEL_MAX_VIEWPORT_*`; `test/panel-stream.contract.test.ts`.                                                                                             |
| Dialogs rendered in BB; unresolved agent dialogs dismissed at lease end; Automation omits context menus/DevTools; Safe Login native UI | Automated: `test/browser-dialogs.contract.test.ts`, `test/panel-dialogs-transport.contract.test.ts`, `test/panel-dialogs-ui.test.tsx`.                               |
| One Browser Panel tab per profile per surface; repeat focuses existing                                                                 | Automated: `test/public-plugin.contract.test.tsx`.                                                                                                                   |
| Explicit states: Setup required, Host offline, Waking, Safe Login elsewhere, Repair required, Unsupported                              | Automated: `browserStatusSchema` discriminated union; `test/public-plugin.contract.test.tsx`.                                                                        |
| WCAG AA, keyboard/screen readers (chrome), reduced motion, yields BB global shortcuts; canvas not fully screen-reader accessible       | Automated: `test/public-plugin.contract.test.tsx` (chrome accessibility); Limitation: canvas screen-reader access ([limitations.md](limitations.md#screen-readers)). |
| Downloads/grant requests/crashes use in-app badges/toasts/drawer; no OS push in v1                                                     | Automated: `test/panel-downloads-ui.test.tsx`, `test/public-plugin.contract.test.tsx`.                                                                               |

### Transport

| Requirement                                                                                                                                   | Evidence                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome/CDP/VNC/helpers bind loopback; never exposed directly                                                                                  | Automated: `test/evidence/security.evidence.test.ts`, `test/panel-gateway.contract.test.ts`; `PANEL_GATEWAY_BIND_HOST = "127.0.0.1"`.    |
| BB Connect owner-session gate + rotating Panel Capability                                                                                     | Automated: `test/panel-gateway.contract.test.ts`, `test/panel-owner-session.contract.test.ts`, `test/panel-capability.contract.test.ts`. |
| Capability single-use, 60 s, bound to owner session/panel/host/profile, redeemed in first WS message, rotation 5 min, revoked on close/switch | Automated: `test/panel-capability.contract.test.ts`; `PANEL_CAPABILITY_TTL_MS`, `PANEL_AUTH_ROTATION_MS`.                                |
| BB Connect enrollment required even locally; BB mobile unsupported                                                                            | Automated: `readinessCapabilityIdSchema` includes `bb-connect`; Limitation: mobile ([limitations.md](limitations.md#mobile-mounting)).   |
| Connection loss: input freezes; 10 s reclaim; bounded backoff; profiles never fail over                                                       | Automated: `test/panel-transport.contract.test.ts`, `test/evidence/restorable-session.evidence.test.ts`; `PANEL_RECLAIM_WINDOW_MS`.      |
| Automation 5–15 FPS ≤ 1920×1080; no audio/DRM/media promise                                                                                   | Automated: `PANEL_MIN/MAX_FRAMES_PER_SECOND`, `PANEL_MAX_VIEWPORT_*`; Limitation: media ([limitations.md](limitations.md#media)).        |
| Dynamic loopback gateway port per generation; validates shapes/sizes; rate-limits input; caps bandwidth; drops stale frames                   | Automated: `test/panel-gateway.contract.test.ts`, `test/panel-gateway-pool.contract.test.ts`, `test/panel-stream.contract.test.ts`.      |

### Clipboard, files, and permissions

| Requirement                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text clipboard explicit; never continuously synced; byte counts only                                               | Automated: `test/clipboard-exchange.contract.test.ts`; `BROWSER_CLIPBOARD_MAX_BYTES`.                                                                                                                                                                                                                                                                       |
| Uploads from client or workspace file; `bb-browser` no repo access; realpath containment; one-use Transfer Staging | Automated: `test/transfer-staging.contract.test.ts`, `test/host-operations.contract.test.ts`.                                                                                                                                                                                                                                                               |
| Host Downloads expire 7 days; defaults 1 GiB/file, 5 GiB/profile; configurable                                     | Automated: `test/host-downloads.contract.test.ts`, `test/host-downloads-boundary.contract.test.ts`; `BROWSER_DOWNLOAD_*`.                                                                                                                                                                                                                                   |
| Host Downloads untrusted quarantine; never auto-open/exec; export explicit                                         | Automated: `test/host-downloads.contract.test.ts`.                                                                                                                                                                                                                                                                                                          |
| Export never overwrites without confirmation; agent export needs file-transfer grant                               | Automated: `test/host-downloads.contract.test.ts`.                                                                                                                                                                                                                                                                                                          |
| Camera/mic/geolocation/notifications/device permissions denied                                                     | Limitation: backed by [spec](../browser-plugin-spec.md) (denied in v1), [ADR 0009](../adr/0009-minimize-browser-derived-persistence.md), and [limitations.md](limitations.md#device-permissions); no grant path exists, and `--disable-notifications` in `browser-runtime.ts` is the only explicit code flag. Not asserted by the automated evidence suite. |

### Browser security

| Requirement                                                                                             | Evidence                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Extensions and Chrome Sync disabled; extension password managers/wallets disabled                       | Limitation: [limitations.md](limitations.md#extensions).                                                                           |
| Saved passwords/autofill/payment autofill disabled                                                      | Limitation: [limitations.md](limitations.md#passwords).                                                                            |
| At-rest relies on Chrome + owner-only FS + host FDE; no unattended key                                  | Automated: `test/profile-storage.contract.test.ts` (owner-only modes); documented in [security.md](security.md).                   |
| Exact HTTP localhost/private-network origins grantable; invalid TLS per-origin opt-in; no global bypass | Automated: `test/authorization.contract.test.ts`, `test/origin-scope.contract.test.ts`, `test/origin-scope-host.contract.test.ts`. |
| Host system proxy honored; no per-profile proxy config or credentials                                   | Limitation: [limitations.md](limitations.md#proxies).                                                                              |

### Profile maintenance

| Requirement                                                                         | Evidence                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clear one origin's site data / caches / reset after confirmation + stop             | Automated: `test/profile-lifecycle.contract.test.ts`, `test/profile-storage.contract.test.ts`.                                                                           |
| Full reset archives prior profile, creates fresh, revokes grants                    | Automated: `test/profile-lifecycle.contract.test.ts`.                                                                                                                    |
| Backup = explicit stopped-profile, mode-600, same-installation, best-effort restore | Automated: `test/profile-recovery.contract.test.ts`; `credentialEquivalent: true`. Limitation: no cross-host restore ([limitations.md](limitations.md#cross-host-sync)). |

### Activity records

| Requirement                                                                                                                                             | Evidence                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Agent ops retain only actor/project/profile/origin/timing/outcome/interruption metadata                                                                 | Automated: `test/activity-records.contract.test.ts`, `test/evidence/sensitive-data.evidence.test.ts`.        |
| Grant/control/mode/setup/lifecycle/export also produce records                                                                                          | Automated: `test/activity-records.contract.test.ts`, `test/host-activity-outbox.contract.test.ts`.           |
| Exclude scripts/passwords/keystrokes/forms/page contents/screenshots/clipboard/ordinary browsing/URLs                                                   | Automated: `test/evidence/sensitive-data.evidence.test.ts` (scans logs, DB, outbox, diagnostics, manifests). |
| Expire after 30 days or 10,000 entries per profile                                                                                                      | Automated: `ACTIVITY_RETENTION_DAYS`, `ACTIVITY_RECORD_LIMIT`.                                               |
| Owner export/clear                                                                                                                                      | Automated: `test/activity-records.contract.test.ts`.                                                         |
| Redacted diagnostics bundle (versions, capabilities, processes, resources, redacted exit logs); excludes URLs/cookies/profile/scripts/screenshots/forms | Automated: `browserDiagnosticsSchema`; `test/evidence/sensitive-data.evidence.test.ts`.                      |

### Setup and support

| Requirement                                                                                                                | Evidence                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Ubuntu/Debian x86_64 only; others → unsupported state                                                                      | Automated: `test/host-readiness.contract.test.ts`.                                                |
| Setup checklist in Settings; `bb browser setup` CLI equivalent                                                             | Automated: `server.ts` `setup` command; `test/host-readiness.contract.test.ts`.                   |
| Creating `bb-browser`, secure storage, Chrome/display helpers require explicit confirmation; no silent privileged change   | Automated: `test/host-readiness.contract.test.ts`; consent-gated plan schema.                     |
| Pinned `dev-browser`/Playwright; Chrome Stable via signed repo; health reports drift, never silent upgrade                 | Automated: `test/package-contract.test.ts`, `test/host-readiness.contract.test.ts`.               |
| Setup resumable/idempotent; partial failure doesn't remove packages                                                        | Automated: `test/evidence/storage-failure.evidence.test.ts` (partial setup → setup-required).     |
| Disable/uninstall retain profiles; only `bb browser purge` removes user/config/data                                        | Automated: `browserLifecycleResponseSchema` (`profilesRetained: true`); `browserPurgePlanSchema`. |
| Migrations append-only/transactional; manifests versioned + backed up; downgrade fails closed; Chrome never downgraded     | Automated: `test/evidence/storage-failure.evidence.test.ts` (incompatible downgrade refusal).     |
| Code/non-privileged verification before provisioning; exact user/packages/dirs/permissions shown for separate confirmation | Automated: `test/host-readiness.contract.test.ts`; `browserSetupPlanSchema`.                      |

### Privacy and external services

| Requirement                                                                                                                 | Evidence                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No analytics/telemetry/crash reports/browser data to external services; diagnostics local; BB Connect sole remote transport | Automated: `test/evidence/sensitive-data.evidence.test.ts`; documented in [security.md](security.md). Limitation: [limitations.md](limitations.md#diagnostics). |

## Performance targets

Targets from the spec, measured on the current host after dependencies are
installed. Evidence status from `test/evidence/performance.evidence.test.ts`:

| Target                            | Threshold                          | Evidence status                                                                                                       |
| --------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Awake tool-dispatch overhead      | < 1 s (excluding script execution) | **Automated** — passes against the real dispatch path.                                                                |
| Warm first frame                  | ≤ 2 s                              | **Limitation** — requires a provisioned Chrome/host; skipped deterministically when the provisioned-host gate is off. |
| Cold first frame                  | ≤ 10 s                             | **Limitation** — same as warm.                                                                                        |
| Loopback input-to-frame p95       | < 200 ms                           | **Limitation** — real-stream threshold; skipped deterministically.                                                    |
| Interaction stream                | ≥ 10 FPS                           | **Limitation** — real-Chrome stream; skipped deterministically.                                                       |
| Resident memory per awake profile | ≤ 1.5 GiB                          | **Limitation** — real-Chrome process; skipped deterministically.                                                      |

The mandatory provisioned-host gate (`browser-auth.integration.test.ts` under
`BB_BROWSER_REAL_INTEGRATION=1` via `npm run test:real-browser`) proves the
real-process boundaries with a healthy enrolled host; the real-process
performance thresholds are registered with `it.runIf(integrationEnabled)` so
they surface as **skipped tests naming the missing capability** (not passed
boundaries) when the gate is off. This environment does not provision Chrome or
mutate the host, so those thresholds are skipped rather than asserted against
flaky host-dependent numbers.

**Remote measurements add network RTT** and report it separately so host-side
regressions are not hidden. This is documented in
[troubleshooting.md](troubleshooting.md#performance-complaints) and
[limitations.md](limitations.md#performance-measurement).

## Security evidence

From `test/evidence/security.evidence.test.ts` and
`test/evidence/sensitive-data.evidence.test.ts` (issue #21 AC3 and AC5):

- Origin-scope enforcement at the context level (new pages share interception).
- Direct non-web `Frame.goto` is rejected at the pinned Playwright connection
  boundary before a navigation command is sent; boxed method/URL values are
  covered by `test/agent-script.contract.test.ts`, and the typed denial remains
  sticky after a caught navigation error.
- Pinned Chromium runtime checks prove that `data:` navigation can bypass a
  Playwright route, while the CDP guard observes the precommit signal, returns
  the typed non-web denial, and closes the denied page. Renderer location
  changes and data popups are covered without closing the owner page; approved
  HTTP(S)-backed `blob:` remains usable.
- QuickJS isolation: sandbox browser global frozen with no `newContext`.
- Agent-visible Playwright Browser, BrowserType, BrowserContext, and connection
  aliases cannot create an unguarded context; future host BrowserContexts are
  registered by the Origin Scope guard, while same-context `browser.newPage()`
  remains available (`test/agent-script.contract.test.ts`,
  `test/origin-scope-host.contract.test.ts`).
- The shared Playwright context applies action and navigation deadlines to the
  initial page, existing pages, and future `browser.getPage`/`browser.newPage`
  pages, with useful call-log tails (`test/agent-script.playwright.integration.test.ts`).
- (Provisioned-host) unprivileged execution and loopback-only socket boundaries.
- Sensitive-data scans across Activity Records, database, durable outbox, logs,
  diagnostics, and manifests prove exclusion of cookies, full URLs, scripts,
  purposes, passwords, keystrokes, form contents, screenshots, and clipboard
  data.
- Transport error messages never leak sensitive data on capability replay or
  malformed input.
- Sandbox escape (`test/sandbox-escape.contract.test.ts`), path traversal/symlink
  (`test/transfer-staging.contract.test.ts`,
  `test/host-downloads-boundary.contract.test.ts`), second-client takeover and
  disconnect grace (`test/panel-multi-client.contract.test.ts`).

## Restorable session and failure evidence

From `test/evidence/restorable-session.evidence.test.ts` and
`test/evidence/storage-failure.evidence.test.ts` (issue #21 AC2 and AC4):

- Graceful stop returns the instance to sleeping without losing the profile.
- Idle sleep retires an unmanaged instance after the idle window; a visible
  panel pin prevents idle sleep.
- Host disconnect freezes work and reconnect reconciles to the same profile.
- Incompatible downgrade refused (older plan never downgrades the schema).
- Partial setup classified as `setup-required`; low disk classified as
  `repair-required` without deleting cookies/site storage.
- Host loss → `host-offline` then `healthy` on reconnect.
- Clean disposal of retained instances and panel slots on cleanup.

## Planned human acceptance

The remote acceptance plan in
[`docs/verification-plan.md`](../verification-plan.md#manual-remote-acceptance)
runs through the owner's authenticated BB Connect instance and covers both
panel actions, profile creation, local-app login persistence, shared tabs and
control, agent access and denial, Safe Login opacity, transfers, sleep/wake,
and recovery. These steps are **planned human acceptance**, not deterministic
tests. After the deterministic suite passes, the owner may perform a manual
third-party login smoke test against a site of their choice, recording only
pass/fail (no credentials, screenshots, DOM, or URL details).

## Documentation review

This report's commands and claims were checked against a clean install of the
source and the public contracts:

- **CLI commands and flags** — every `bb browser` invocation in
  [cli-reference.md](cli-reference.md), [quickstart.md](quickstart.md),
  [operators.md](operators.md), and [agent-reference.md](agent-reference.md)
  matches the registered command usage in `server.ts` (`registerCli`) and the
  argument parser (`parseCliArguments`, `runTransferCli`, `runDownloadsCli`).
  The `transfer` workspace form uses `--environment <id> --path <relative-path>`
  as the code requires (the older `--source`/`--environment-root` form is not
  documented).
- **Schemas and typed results** — status states, error codes, capability
  targets, setup/purge plan literals, and result bounds are taken from
  `contracts.ts` (`browserStatusSchema`, `browserScriptRuntimeErrorSchema`,
  `browserOriginDeniedErrorSchema`, `readinessCapabilityIdSchema`,
  `browserSetupPlanSchema`, `browserPurgePlanSchema`,
  `browserProfileRecoveryProgressSchema`, `BROWSER_SCRIPT_*` constants).
- **Bundled skill** — `skills/browser/SKILL.md` is referenced as-is; its
  guidance (`setup_required` is final; readiness-first; explicit retry) aligns
  with `server.ts` and the schemas.
- **Constants** — lease/retention/transport/quota constants are taken from
  `contracts.ts`, `control-lease.ts`, `safe-login.ts`, `grant-requests.ts`, and
  `browser-runtime.ts`.
- **ADRs** — architecture and security claims cite the accepted ADRs in
  `docs/adr/`; no claim contradicts an accepted ADR.
- **Dependencies and license** — [third-party-notices.md](third-party-notices.md)
  versions are taken from `package.json`, `package-lock.json`, and
  `dependency-inventory.ts`.
- **Limitations** — every version-one limitation is recorded in
  [limitations.md](limitations.md) with its evidence status; none are documented
  as working features.

### Validation run

The issue #64 boundary corrections and their documentation were validated with
the repository gates:

- `npm run typecheck` — passes.
- `npm run lint` — passes.
- `npx prettier --check .` — passes (new Markdown is Prettier-clean).
- `npm run test` — 678 passed, 38 skipped across 67 test files (provisioned-host tests).
- `npm run build` — production build of plugin source.
