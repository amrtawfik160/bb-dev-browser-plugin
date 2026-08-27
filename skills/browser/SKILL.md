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

Use `bb browser list`, `bb browser create`, `bb browser rename`, and `bb browser
select` to manage profiles. Profiles and authenticated state stay on the
workspace host and are not synchronized through BB server storage.

Treat `setup_required` as final for the current call. Report that host setup is required; do not retry, provision packages, launch a browser through another path, or seek a raw browser endpoint.
