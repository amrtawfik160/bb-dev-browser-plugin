# Host provisioning — owner confirmation (issue #24, AC1)

> **Who performs this:** the human owner of the current enrolled host. The
> agent produces this artifact only; it **does not execute** any privileged
> command, install packages, create users, change storage, or enroll BB
> Connect. Every privileged step below requires the owner's explicit
> confirmation before it runs.

This document is the **exact supported-host diagnosis** and the **proposed
privileged commands** for provisioning only the current enrolled host with the
release candidate. It is derived from the real readiness probes in
[`readiness.ts`](../../../readiness.ts) and the operator
[setup guide](../operators.md#setup). Read it end-to-end, then confirm each
item in the [confirmation checklist](#confirmation-checklist) before running a
single privileged command.

Issue #24 is labelled `ready-for-human`. The deterministic acceptance,
performance, and privacy suites that verify a provisioned host live in
`test/host-setup-verification.test.ts`,
`test/host-acceptance.evidence.test.ts`,
`test/host-performance.evidence.test.ts`, and
`test/host-privacy-scan.test.ts`. They are gated behind
`BB_BROWSER_REAL_INTEGRATION=1` and **skip deterministically** (never fail)
without a provisioned host. The [`scripts/host-provisioning-wizard.sh`](../../../scripts/host-provisioning-wizard.sh)
walks the owner through the privileged steps in order and never auto-executes a
privileged command without confirmation.

---

## 1. Exact supported-host diagnosis

The readiness boundary probes nine capabilities (the
`READINESS_CAPABILITIES` in [`contracts.ts`](../../../contracts.ts)). Each
must report `ready` before the host is provisioned. The table below is the
**exact** readiness logic from [`readiness.ts`](../../../readiness.ts) — these
are the real checks the owner must satisfy, not a paraphrase.

| #   | Capability          | "ready" means (exact probe)                                                                                                                                                                                                                                                                                  | How the owner verifies                                                                                                       |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | `operating-system`  | `/etc/os-release` `ID` is `ubuntu` or `debian` (case-insensitive).                                                                                                                                                                                                                                           | `bb browser status --json` shows `operating-system` = `ready`, or `grep ^ID= /etc/os-release`.                               |
| 2   | `architecture`      | `process.arch` is `x64` or `amd64`.                                                                                                                                                                                                                                                                          | `uname -m` prints `x86_64`.                                                                                                  |
| 3   | `bb-connect`        | The host's BB Connect `config.json` contains a non-empty `machineCredential` (the host is enrolled).                                                                                                                                                                                                         | `bb connect status` (or the BB desktop client) shows the host enrolled.                                                      |
| 4   | `browser`           | A compatible browser is available: Google Chrome Stable (`/usr/bin/google-chrome-stable` or `/usr/bin/google-chrome`) with an installed `google-chrome-stable` dpkg version, **or** the pinned Playwright Chromium fallback installed under the protected storage root.                                      | `bb browser status --json` shows `browser` = `ready` with a non-null `version`.                                              |
| 5   | `sandbox`           | User namespaces are enabled (`/proc/sys/kernel/unprivileged_userns_clone` reads `1`), **or** a valid suid `chrome-sandbox` helper exists (`/opt/google/chrome/chrome-sandbox` or `/usr/lib/chromium/chrome-sandbox`: a file, owned by root, executable, setuid, world-executable, not group/world-writable). | `cat /proc/sys/kernel/unprivileged_userns_clone` prints `1`, or `ls -l /opt/google/chrome/chrome-sandbox` shows setuid root. |
| 6   | `dedicated-user`    | The `bb-browser` user exists in `/etc/passwd` with a positive uid/gid and a no-login shell (`/usr/sbin/nologin`, `/sbin/nologin`, or `/bin/false`).                                                                                                                                                          | `getent passwd bb-browser` shows a positive uid and a nologin shell.                                                         |
| 7   | `protected-storage` | The installation- and host-scoped storage directory exists under `/var/lib/bb-browser`, is a directory owned by `bb-browser`, has mode `0700` (no group/other access), and contains a valid `host-state.json` whose `installationId` and `hostId` match this installation and host.                          | `bb browser status --json` shows `protected-storage` = `ready`.                                                              |
| 8   | `disk-headroom`     | The filesystem holding the protected storage root has at least **5 GiB** free (`statfs` `bavail * bsize ≥ 5 * 1024³`).                                                                                                                                                                                       | `df -h /var/lib/bb-browser` shows ≥ 5 GiB available.                                                                         |
| 9   | `loopback`          | A test listener can bind to `127.0.0.1` (loopback networking is healthy).                                                                                                                                                                                                                                    | `bb browser status --json` shows `loopback` = `ready`.                                                                       |

The overall state is `healthy` only when the platform is supported (1+2) and
**all nine** capabilities are `ready`. Any non-ready capability yields
`setup-required` (missing/incomplete) or `repair-required` (failed). The host
must reach `healthy` before the deterministic acceptance suites run.

### Run the diagnosis (non-privileged)

The owner runs these read-only commands first. They change nothing:

```sh
bb browser status --json          # nine-capability checklist + overall state
bb browser diagnostics --json     # redacted bundle: deps, processes, resource use, exit logs
```

Both are read-only and safe at any time. Capture their output; the wizard and
the acceptance report reference it.

---

## 2. Proposed privileged commands (DO NOT RUN until confirmed)

The three setup steps (`SETUP_STEP_IDS`) map to the privileged operations
below. They are **idempotent and resumable**. The owner runs each through the
consent-gated CLI, which shows the exact command before applying it:

```sh
bb browser setup --json                                   # show the plan (no changes)
bb browser setup --step dedicated-user     --confirm "create bb-browser user" --json
bb browser setup --step system-packages    --confirm "install browser packages" --json
bb browser setup --step protected-storage  --confirm "create protected storage" --json
```

The plan (`browserSetupPlanSchema`) enforces: `storageOwner: "bb-browser"`,
`storageMode: "0700"`, `runAsUser: "bb-browser"`, `shell: "/usr/sbin/nologin"`,
`sandbox: "required"`, `noSandbox: false`.

### 2a. Packages to install

- **Google Chrome Stable** (primary browser). Add the signed Google repository
  and install `google-chrome-stable`. Chrome Stable updates through its signed
  system repository only; the plugin **never silently upgrades** system
  packages and reports incompatible drift via the `browser` capability.
- **Display helpers** (only if a display is needed): `Xvfb`, `x11vnc`, and the
  `noVNC` web client, used by Safe Login Mode. These run as `bb-browser` and
  bind loopback only.
- **Pinned Playwright Chromium** (fallback): installed under the protected
  storage root by the `system-packages` step when Chrome Stable is not chosen;
  pinned by `dependency-inventory.ts` (`PINNED_BROWSER_RUNTIME`), not a system
  package.

> Partial failure does **not** silently remove installed system packages.
> Re-run the affected step to resume.

### 2b. Dedicated-user changes

Create the unprivileged `bb-browser` OS user. Proposed equivalent privileged
commands (the `dedicated-user` setup step performs these with owner
confirmation):

```sh
# Proposed only — do NOT run without confirming the checklist below.
useradd --system --shell /usr/sbin/nologin --home /var/lib/bb-browser bb-browser
```

Invariants the `dedicated-user` capability enforces (and the acceptance test
`assertDedicatedIdentity` verifies): uid > 0, gid > 0, no-login shell, Chrome
launched **with the sandbox** (never `--no-sandbox`). Running authenticated web
content as root with `--no-sandbox` is unsupported.

### 2c. Protected-storage targets

Create installation- and host-scoped storage under the mandatory root
(`/var/lib/bb-browser`, enforced by `provisionedBrowserStorageRoot`). Proposed
equivalent privileged commands:

```sh
# Proposed only — do NOT run without confirming the checklist below.
install -d -o bb-browser -g bb-browser -m 0700 \
  /var/lib/bb-browser/installations/<installationId>/hosts/<hostSegment>
# host-state.json is written by the plugin (mode 0600) after the directory exists.
```

- The installation id is `hostInstallationId(dataDir)` — a SHA-256 of the BB
  daemon data directory (`BB_BROWSER_HOST_DATA_DIR`), truncated to 32 chars.
  The owner does **not** choose it; it is derived from the daemon data dir.
- The host segment is `browserHostStorageSegment(hostId)`.
- Ownership: `bb-browser:bb-browser`. Mode: `0700`. Manifests: `0600`.
- Another BB installation on the machine cannot attach this storage
  accidentally (installation-scoped namespace).

### 2d. BB Connect enrollment

BB Connect enrollment is the **only** remote authenticated transport and is
required even for a locally displayed panel. Enrollment is performed through
the BB desktop client / `bb connect` (a privileged, owner-only step) and writes
the host's `config.json` `machineCredential`. The `bb-connect` capability
reports `ready` only when that credential is present.

### 2e. Rollback limits

- Setup is **resumable and idempotent**: re-run any step to retry from the last
  completed state. Partial failure leaves the prior completed state intact.
- Partial failure **does not silently remove installed system packages** and
  does not delete Chrome profiles or cookies.
- Rollback from a failed step is to re-run that step; there is no destructive
  automatic rollback. To fully remove, use the explicit purge (below).

### 2f. Purge boundary

`bb browser purge` is the **only** destructive operation. It removes, in
order: `stop-owned-processes`, `browser-data`, `configuration`, and
`dedicated-user`. For issue #24 the host is **NOT purged** at the end (AC8):
retained test profile data and any cleanup choice are reported to the owner.
The owner may plan a purge without applying it:

```sh
bb browser purge --json                    # show the destructive plan (no changes)
bb browser purge --confirm "purge Browser" # apply — DESTRUCTIVE, do not use for #24
```

Disable/uninstall are **non-destructive** (they stop processes but retain
profiles, returning `profilesRetained: true`):

```sh
bb browser disable   --confirm "Stop Browser processes"
bb browser uninstall --confirm "Stop Browser processes"
```

---

## 3. Confirmation checklist

The owner initials each item **before** running any privileged command. None
of these commands are run by the agent; this is the owner's gate.

### A. Diagnosis confirmed (read-only, run first)

- [ ] `bb browser status --json` reviewed; the host's current state and the
      nine capabilities are recorded.
- [ ] `bb browser diagnostics --json` reviewed; dependencies and process
      states are recorded.
- [ ] `uname -m` confirms `x86_64`; `/etc/os-release` confirms `ubuntu` or
      `debian`.
- [ ] `df -h /var/lib/bb-browser` confirms ≥ 5 GiB free (or the owner frees
      space first).
- [ ] `bb connect status` confirms the host is (or will be) enrolled.

### B. Proposed privileged commands confirmed

- [ ] `bb browser setup --json` plan reviewed; it shows
      `storageOwner: "bb-browser"`, `storageMode: "0700"`,
      `runAsUser: "bb-browser"`, `shell: "/usr/sbin/nologin"`,
      `sandbox: "required"`, `noSandbox: false`.
- [ ] The owner confirms the `dedicated-user` step (creates the unprivileged
      `bb-browser` user with a nologin shell).
- [ ] The owner confirms the `system-packages` step (installs Chrome Stable or
      the pinned Chromium fallback, and display helpers if needed).
- [ ] The owner confirms the `protected-storage` step (creates
      `/var/lib/bb-browser/installations/<id>/hosts/<segment>` owned by
      `bb-browser` at mode `0700`).
- [ ] The owner confirms BB Connect enrollment writes the `machineCredential`
      to the host `config.json`.

### C. Rollback and purge boundary confirmed

- [ ] The owner understands setup is resumable/idempotent and that partial
      failure does not remove installed packages or profile data.
- [ ] The owner understands `bb browser purge` is the only destructive
      operation and will **not** be run for issue #24 (AC8): the host is not
      purged; retained test profile data and any cleanup choice are reported
      back to the owner.
- [ ] The owner confirms `bb browser disable`/`uninstall` are non-destructive
      (retain profiles) and are the safe rollback if acceptance is abandoned.

### D. Acceptance gate confirmed

- [ ] The owner will run the gated suites with
      `BB_BROWSER_REAL_INTEGRATION=1` and `BB_BROWSER_HOST_DATA_DIR=<daemon
data dir>` set, after the host reports `healthy`.
- [ ] The owner understands the suites **skip deterministically** (never fail)
      if the host is not provisioned, and that failures stop for diagnosis
      (see [`acceptance-runbook.md`](acceptance-runbook.md) AC7/AC8).

---

## Owner sign-off

By proceeding past this checklist, the owner confirms the diagnosis above is
accurate for the current host and authorizes the privileged setup steps
themselves. The agent does not perform any of them.

```
Owner: ____________________   Date: ____________   Host: ____________
Diagnosis reviewed: [ ]   Privileged steps authorized: [ ]
Purge will NOT be run (AC8): [ ]
```
