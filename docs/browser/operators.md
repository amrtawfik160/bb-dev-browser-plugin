# Browser operator guide

This guide is for the operator of a host that runs the **Browser** plugin. It
covers supported hosts, BB Connect, readiness diagnosis, consent-gated setup,
repair, disable/uninstall retention, explicit purge, backups, restores,
imports, quotas, and redacted diagnostics.

All CLI examples are the exact flags accepted by the registered commands in
`server.ts` (see [cli-reference.md](cli-reference.md) for the full surface).

## Supported hosts

Version one supports **Ubuntu and Debian on x86_64**. Other hosts receive a
capability-gated **Unsupported** state rather than a partial install — the
plugin never silently installs an unsupported configuration. The readiness
checks probe nine capabilities (verified in `contracts.ts`,
`READINESS_CAPABILITIES`):

| Capability          | Label                  |
| ------------------- | ---------------------- |
| `operating-system`  | Operating system       |
| `architecture`      | Architecture           |
| `bb-connect`        | BB Connect             |
| `browser`           | Browser                |
| `sandbox`           | Browser sandbox        |
| `dedicated-user`    | Dedicated browser user |
| `protected-storage` | Protected storage      |
| `disk-headroom`     | Disk headroom          |
| `loopback`          | Loopback networking    |

Official **Chrome Stable** is the primary browser; a compatible pinned Playwright
Chromium is the fallback for ordinary browsing. Chrome Stable updates through
its signed system repository. Compatible `dev-browser` and Playwright fallback
versions are pinned; health checks report incompatible drift but never silently
upgrade system packages. The fallback is read from the Playwright cache through
a private no-follow staging boundary that accepts only regular files and
directories. Protected storage receives the normalized staging tree as
ordinary `bb-browser`-owned files with safe modes; setup never follows cache
symlinks or installs a cache-provided setuid helper. User namespaces or a
separately validated system helper must satisfy the sandbox readiness check.

## BB Connect

Version one **requires BB Connect enrollment even for a locally displayed
panel**, providing one authenticated transport for web/PWA and desktop. BB
mobile is unsupported while it does not mount plugin frontends. BB Connect is
the **only** existing remote authenticated transport; the plugin sends no
analytics, telemetry, crash reports, or browser data to any external service.

## Readiness diagnosis

Check host readiness before diagnosing availability:

```text
bb browser status [--profile <id>] [--host <id>] [--json]
bb browser diagnostics [--profile <id>] [--host <id>] [--json]
```

`bb browser status` reports one of these states (verified in the
`browserStatusSchema` discriminated union):

- `setup-required` (code `setup_required`) — host setup is incomplete.
- `sleeping` — instance idle; will wake on demand.
- `waking` — instance starting.
- `host-offline` — host disconnected.
- `safe-login-elsewhere` — another panel is in Safe Login Mode.
- `repair-required` — the browser stopped after a crash loop or drift.
- `unsupported` — host platform is not supported in v1.
- `healthy` — ready.

Without `--json`, `bb browser status` prints the label, message, and a checklist
of the nine capabilities with a `✓` (ready) or `-` marker and reason per line.
`bb browser diagnostics` returns a **redacted** bundle (see
[Diagnostics bundle](#diagnostics-bundle)) when a status asks for repair
details.

## Setup

The setup checklist is exposed in authenticated Browser Settings; `bb browser
setup` provides the CLI equivalent. Setup is **resumable and idempotent**.

Creating the `bb-browser` user, configuring secure storage, and installing Chrome
or display helpers require **explicit owner confirmation**. Plugin startup never
silently changes privileged host state. Code and non-privileged verification
complete **before** current-host provisioning; the exact OS user, packages,
directories, and permissions are shown for a separate explicit confirmation
before any privileged change. Partial failure does not silently remove
installed system packages.

The three setup steps (verified in `SETUP_STEP_IDS`):

```text
bb browser setup [--json]                                   # show the consent-gated plan
bb browser setup --step <id> --confirm <text> [--json]       # apply one step
```

- `dedicated-user` — create the unprivileged `bb-browser` OS user
  (`/usr/sbin/nologin` shell, Chrome sandbox required, no `--no-sandbox`).
- `system-packages` — install Chrome or display helpers.
- `protected-storage` — create installation- and host-scoped storage under
  `/var/lib/bb-browser`, owned by `bb-browser`, mode `0700`, manifests `0600`.

Storage and user facts (verified in `browserSetupPlanSchema`):
`storageOwner: "bb-browser"`, `storageMode: "0700"`,
`runAsUser: "bb-browser"`, `shell: "/usr/sbin/nologin"`,
`sandbox: "required"`, `noSandbox: false`.

## Repair

`repair-required` is reached after **three browser crashes within five minutes**
(the plugin then stops relaunching) or after incompatible dependency drift.
Generate a redacted diagnostics bundle to identify the cause:

```text
bb browser diagnostics [--profile <id>] [--host <id>] [--json]
```

Health checks report incompatible drift but never silently upgrade system
packages. To recover, rerun the relevant setup step or reset the profile (see
[Profile maintenance](#profile-maintenance)). Browser profiles are never
downgraded.

## Disable and uninstall (retention)

Disabling or uninstalling the plugin **stops its processes but retains
profiles**. These are non-destructive:

```text
bb browser disable --confirm "Stop Browser processes"
bb browser uninstall --confirm "Stop Browser processes"
```

Both return `profilesRetained: true` (verified in
`browserLifecycleResponseSchema`). Only an explicit purge removes authenticated
data.

## Explicit purge

`bb browser purge` is the **only** destructive operation. It removes
Browser-owned processes, browser data, configuration, and the dedicated `bb-browser`
system user.

```text
bb browser purge [--json]                       # show the destructive plan (no changes)
bb browser purge --confirm <text> [--json]     # apply the plan
```

The plan (verified in `browserPurgePlanSchema`) lists four targets with
`pending`/`in-progress`/`partial-failure`/`purged` state:
`stop-owned-processes`, `browser-data`, `configuration`, and `dedicated-user`.

> The current default profile cannot be removed until another default is
> selected. Immediate permanent deletion of a single profile requires typing
> its name (`bb browser delete --profile <id> --confirm <name>`).

## Backups, restores, and imports

These are **owner operations performed through authenticated Settings or the
CLI**, on **stopped** profiles. Each produces a mode-600 credential-equivalent
archive for best-effort restore to the **same host and BB installation**. There
is no automatic, portable, or cross-host session backup.

```text
bb browser backup  --profile <id> --archive <path> [--host <id>] [--json]
bb browser restore --profile <id> --archive <path> [--host <id>] [--json]
bb browser import  --name <name> --source <path> [--host <id>] [--json]
```

- **Backup/restore** run a `validating → copying → promoting → completed`
  recovery pipeline (verified in `browserProfileRecoveryProgressSchema`) and
  mark the archive `credentialEquivalent: true`.
- **Import** copies an existing stopped `dev-browser` profile through a staged,
  compatibility-checked copy into a new stable identifier; promotion is atomic,
  the source remains untouched, and incompatible encrypted state causes a clean
  abort rather than a weaker Chrome configuration.

Archived Profile lifecycle:

```text
bb browser archive --profile <id> [--host <id>] [--json]              # view archived state; mutation via Settings
bb browser restore-archived --profile <id> [--host <id>] [--json]     # restore within 30 days via Settings
```

An Archived Profile is stopped, loses all Profile Grants, and is retained for
**30 days** (`PROFILE_ARCHIVE_RETENTION_DAYS`).

## Profile maintenance

```text
bb browser reset  --profile <id> --confirm <text> [--host <id>] [--json]
bb browser delete --profile <id> --confirm <name> [--host <id>] [--json]
```

- A full **reset** archives the prior profile, creates a fresh stable profile,
  and revokes the prior grants (confirmed in authenticated Settings).
- **Delete** permanently removes a profile and requires typing its name. The
  current default cannot be removed until another default is selected.

Settings can also clear one origin's site data, clear caches, or reset a profile
after confirmation and stopping its instance.

## Quotas

Profile and transfer quotas (verified in `contracts.ts`):

| Resource                     | Default        | Configurable up to |
| ---------------------------- | -------------- | ------------------ |
| Host free space floor        | 5 GiB          | —                  |
| Host Download per file       | 1 GiB          | 16 GiB             |
| Host Download per profile    | 5 GiB          | 64 GiB             |
| Host Download expiry         | 7 days         | —                  |
| Transfer Staging per file    | 1 GiB          | —                  |
| Clipboard per exchange       | 4 MiB          | —                  |
| Activity Records per profile | 10,000 entries | —                  |
| Activity Records retention   | 30 days        | —                  |
| Archived Profile retention   | 30 days        | —                  |

Adjust download limits from a thread:

```text
bb browser downloads limits [--max-file-bytes <n>] [--max-profile-bytes <n>] [--expiry-ms <n>] [--profile <id>] [--host <id>] [--json]
```

## Diagnostics bundle

`bb browser diagnostics` generates a **redacted** diagnostics bundle. It
includes dependency versions, capability results, process states, resource use,
and redacted exit logs (each log entry capped at 500 characters, at most 50
entries). It **excludes** URLs, cookies, profile data, scripts, screenshots,
form contents, and agent-supplied purposes.

The bundle shape (verified in `browserDiagnosticsSchema`): `readiness` (a
`BrowserStatus`), `dependencies`, `processes` (each `running`/`stopped`/`failed`
with optional pid), `resourceUse` (disk free/total, worker RSS), `exitLogs`,
and an optional `controlLease`.

## Retention summary

- **Profiles and authenticated data** are retained on disable/uninstall; only
  `bb browser purge` removes them.
- **Archived Profiles** are retained 30 days.
- **Host Downloads** expire after 7 days unless explicitly deleted or purged.
- **Activity Records** expire after 30 days or 10,000 entries per profile.
- **Transfer Staging** is one-use and removed after use, cancellation, failure,
  expiry, worker restart, or profile lifecycle operations.
- **Server database migrations** are append-only and transactional; host
  manifests are versioned and metadata is backed up before migration. An
  incompatible downgrade fails closed, and Chrome profiles are never
  downgraded.
