---
name: browser
description: Use the host-local Workspace Browser for authorized webpage interaction, bounded Playwright automation, native screenshots, or setup and diagnostics checks.
---

# Browser

Check readiness with `bb browser status --json` before diagnosing availability. Use
`bb browser diagnostics --json` when the status asks for repair details.

## Agent tool

Use the statically registered `browser_script` tool. Supply:

- `purpose`: required, human-readable reason shown to the owner only while the
  Control Lease is live.
- `code`: QuickJS Playwright code. It has no Node, modules, process access, or
  arbitrary host-filesystem or workspace access.
- `profileId`: optional host-local Browser Profile ID. Omit it to use the
  selected profile.
- `tabId`: optional opaque ID from `browser.listPages()`. Omit it to use the
  active tab; list tabs again after a Browser runtime restart because tab IDs
  are runtime-only.
- `destinationOrigin`: the exact HTTP(S) origin being automated. Access is
  denied until the owner grants that origin to this project, installation, and
  profile. Grant changes apply to the next call and never resume a denied call.
- `timeoutMs`: optional integer from 1 through 30000; the default is 30000.
- `screenshot`: set `true` to request native screenshot output explicitly.
- `fileTransfer` and `invalidCertificate`: separate optional elevation
  requests; each needs its own owner grant, and certificate approval is per
  exact origin.

Return text or bounded JSON from the tool. An explicitly requested screenshot
is ordinary thread image output; the plugin does not persist a second copy.

## Equivalent CLI

Run the same boundary from a project thread:

```text
bb browser script --purpose "Read the checkout total" --code "..." [--profile <id>] [--tab <id>] [--origin <origin>] [--timeout <ms>] [--screenshot] [--file-transfer] [--invalid-certificate] [--json]
```

The CLI derives project and host from BB context and does not accept `--host`.
Without `--json`, text results are printed directly. Use `--json` for a JSON
result or the screenshot envelope. `bb browser status` and
`bb browser diagnostics` expose the same host readiness and live lease state.

## Control and records

Every script holds one atomic Control Lease for its host and profile. Owner
navigation takes priority immediately. A competing agent waits at most five
seconds, then receives typed `browser_busy`; queued work is never retained.
Timeout and revocation are typed runtime failures. The live actor and purpose
appear in status, diagnostics, and the Browser Panel only while the lease is
active. Activity Records retain metadata and interruption status, never the
purpose, source code, page contents, or screenshots.

Use `bb browser list`, `bb browser create`, `bb browser rename`, and `bb browser
select` to manage profiles. Profiles and authenticated state stay on the
workspace host and are not synchronized through BB server storage.

Owners manage grants in authenticated Browser Settings. Grant exact origins or
explicit subdomain patterns such as `https://*.example.test`; paths are not
grantable. Project loopback aliases are project-specific. Raw
`http://localhost:<port>` is available only when explicitly granted as a
fallback.

Treat `setup_required` as final for the current call. Report that host setup is required; do not retry, provision packages, launch a browser through another path, or seek a raw browser endpoint.

## Files and clipboard

The browser operating-system user has no ambient repository access. An
explicit workspace upload resolves through BB environment file APIs, must
remain inside the environment after realpath resolution, and is copied into
one-use Transfer Staging that is removed after use, cancellation, failure,
expiry, worker restart, or profile lifecycle operations. Traversal, symlink
escape, special files, changed-after-selection files, oversized files, and
low-disk conditions all fail closed.

Stage or cancel a workspace transfer from a project thread:

```text
bb browser transfer --kind workspace --source <path> --environment-root <path> [--profile <id>] [--json]
bb browser transfer --cancel --transfer-id <id> [--profile <id>] [--json]
```

The output is privacy-safe: it shows the transfer ID, kind, size, content
type, and outcome only. The staged path and unrelated workspace paths are
never printed. Agent-initiated transfers additionally require the
`file-transfer` grant and an active Control Lease; owner transfers require
neither.

Clipboard text moves only through explicit owner copy or paste actions in the
Browser Panel; the plugin never continuously synchronizes clipboards. Outcomes
report byte counts, never contents.
