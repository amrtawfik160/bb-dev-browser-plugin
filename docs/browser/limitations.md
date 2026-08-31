# Browser version-one limitations

Explicit version-one limitations. Each is a deliberate scope decision recorded
in the design spec and ADRs, not a missing feature. The
[verification report](verification-report.md) records the evidence status for
each.

## Session restoration

- A **Restorable Session** restores durable site authentication, storage, and
  open-tab locations after a Browser Instance restart. **Transient form state
  and exact navigation history are best-effort**, not exact.
- The plugin does not duplicate visited URLs or durable tab identifiers into
  its database; Chrome owns session restoration. (ADR 0009)

## Screen readers

- Plugin chrome targets WCAG AA and supports keyboard and screen readers, honors
  reduced motion, and yields BB global shortcuts. However, **the streamed
  webpage canvas is not fully screen-reader accessible in v1** and is documented
  as such. Safe Login retains native browser UI; Automation Mode omits native
  Chrome context menus and DevTools.

## Mobile mounting

- **BB mobile is unsupported** while it does not mount plugin frontends. Version
  one requires BB Connect enrollment even for a locally displayed panel.
  (ADR 0007)

## Third-party login

- The plugin **does not claim universal login compatibility**. Safe Login Mode
  improves compatibility with sites that reject automation, but hardware-bound
  passkeys, DRM, and corporate device policies may still prevent a login.
  External-site compatibility is not a deterministic release gate; after the
  deterministic suite passes, the owner may perform a manual smoke test against a
  site of their choice, recording only pass/fail (no credentials, screenshots,
  DOM, or URL details). (ADR 0002)

## Passkeys

- Hardware-bound passkeys may not work even in Safe Login Mode. Software passkeys
  behave like other credential storage under the same limitations as saved
  passwords (which are disabled in v1).

## DRM

- Version one streams **no audio** and makes **no DRM or high-fidelity media
  promise**. DRM-protected content may not play. (ADR 0007)

## Media

- Automation Mode is adaptive 5–15 FPS up to 1920×1080 with no audio. Safe Login
  uses an X display and VNC stream. Neither promises high-fidelity media.

## Origin Scope enforcement

- Origin Scope applies to HTTP(S) document navigation and to `blob:` documents
  when the browser exposes an embedded HTTP(S) origin. The host route blocks
  denied HTTP(S) requests before commit. Direct agent `Frame.goto` calls to
  non-web addresses are rejected before the Playwright command reaches
  Chromium; renderer location changes, popups, redirects, and frame documents
  use the CDP guard and fail closed by removing the denied page when needed. If
  cleanup fails, the typed denial is surfaced and the Browser Instance is retired
  before another call can reuse it. Pinned Chromium can report a precommit event
  for a raw direct `data:` loader without exposing a cancellable loader command,
  so this path guarantees typed denial and cleanup rather than a universal
  no-commit event guarantee.
  Ordinary cross-origin subresources may render. Cross-origin frame documents
  therefore need their own grant.
- Exact `about:blank` is allowed as a safe internal page. Other `about:`,
  `data:`, `file:`, `chrome:`, `javascript:`, malformed, and unknown non-web
  document navigations fail closed; they are never treated as an unscoped
  destination.
- Invalid-certificate access is an exact-origin elevation. It does not disable
  certificate validation globally or for another allowed origin.

## Anti-automation defenses

- Major search engines and other sites serve bot-detection challenges to an
  automated Chromium from a datacenter address. This is the remote site's
  policy, not a plugin failure; the browser is driven normally and the
  challenge page is what loads.

## Device permissions

- Camera, microphone, geolocation, notifications, and device permissions are
  **denied in v1**.

## Extensions

- Installable Chrome extensions are **disabled in v1**, including
  extension-based password managers and wallets.

## Sync

- Chrome Sync is **disabled in v1**.
- Profiles are **never synchronized between hosts**; a profile is local to one
  workspace host. (ADR 0001)

## Passwords

- Saved-password storage is **disabled**. Site authentication persists in the
  profile's cookie/storage, but Chrome's saved-password feature is off.

## Autofill

- Address autofill and payment autofill are **disabled** in v1.

## Cross-host sync

- There is **no automatic, portable, or cross-host session backup**. Profile
  backups are explicit stopped-profile, mode-600, same-installation artifacts
  for best-effort restore to the same host and BB installation. (ADR 0009)

## Proxies

- Version one honors the host system proxy but stores **no per-profile proxy
  configuration or proxy credentials**.

## Performance measurement

- On the current host, only the **awake tool-dispatch overhead** target
  (< 1 s, excluding script execution) is asserted in this environment.
- Warm/cold first frame, real loopback input-to-frame p95, interaction FPS, and
  resident memory of a real Chrome process require a provisioned Chrome/host and
  are recorded as v1 limitations (skipped deterministically when the
  provisioned-host gate is off). The mandatory provisioned-host gate
  (`browser-auth.integration.test.ts` under `BB_BROWSER_REAL_INTEGRATION=1`)
  proves the real-process boundaries with a healthy enrolled host.
- **Remote network latency is reported separately** and does not hide host-side
  regressions.

## Marketplace

- The plugin is locally installed from its path in v1 and is **not submitted to
  a marketplace**. The workspace is a local Git repository without a remote.

## Diagnostics

- Diagnostics are local and owner-triggered and are **redacted**; they exclude
  URLs, cookies, profile data, scripts, screenshots, and form contents. They
  are not a full forensic export.
