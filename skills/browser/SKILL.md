---
name: browser
description: Use the host-local Workspace Browser through browser_script or inspect its setup state with bb browser status. Use for browser automation, webpage interaction, screenshots, or Browser setup diagnostics.
---

# Browser

Run `bb browser status --json` before diagnosing Browser availability.

Use `browser_script` for browser automation. Supply:

- `purpose`: a short owner-visible reason for the action.
- `code`: QuickJS-compatible Playwright code without Node or filesystem access.
- `timeoutMs`: at most 30000 when the default is unsuitable.
- `profileId`: optional stable Browser Profile ID. Omit it to use the selected
  host-local profile, or pass an ID returned by `bb browser list --json` to
  target another profile explicitly.
- `destinationOrigin`: the exact HTTP(S) origin being automated. Agent access
  is denied by default until the owner grants that origin to this project,
  host installation, and profile.
- `fileTransfer` and `invalidCertificate`: optional elevation requests. Each
  requires its own owner grant; invalid-certificate approval is per exact
  origin and is never a global bypass.

Use `bb browser list`, `bb browser create`, `bb browser rename`, and `bb browser
select` to manage profiles. Profiles and authenticated state stay on the
workspace host and are not synchronized through BB server storage.

Owners manage access with `bb browser grant create`, `bb browser grant list`,
`bb browser grant inspect`, and `bb browser grant revoke`. Grant exact origins
or explicit subdomain patterns such as `https://*.example.test`; paths are
not grantable. Project loopback aliases are project-specific. Raw
`http://localhost:<port>` is available only when explicitly granted as a
fallback.

Treat `setup_required` as final for the current call. Report that host setup is required; do not retry, provision packages, launch a browser through another path, or seek a raw browser endpoint.
