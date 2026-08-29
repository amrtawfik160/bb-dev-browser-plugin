# Host-provisioning acceptance runbook (issue #24, AC7/AC8)

> **Audience:** the human owner who has provisioned the current enrolled host.
> The agent produced this runbook; it does not run the suites or mutate the
> host. This document defines the **failure discipline** (AC7) and the
> **no-purge retention** policy (AC8) for the deterministic remote acceptance.

The deterministic acceptance, performance, and privacy suites live in:

- `test/host-setup-verification.test.ts` — host setup verification (AC2).
- `test/host-acceptance.evidence.test.ts` — deterministic remote acceptance
  (AC3/AC4).
- `test/host-performance.evidence.test.ts` — current-host performance (AC5).
- `test/host-privacy-scan.test.ts` — privacy scan (AC6).

All four are gated behind `BB_BROWSER_REAL_INTEGRATION=1` (with the
module-load throw when `BB_BROWSER_REAL_INTEGRATION_REQUIRED=1` is set without
it — the repo's "mandatory real-browser gate cannot be skipped" invariant).
They register every test with `it.runIf(integrationEnabled)` and probe the
real host readiness first, so they **skip deterministically** — naming the
exact missing capability and never failing — when the host is not provisioned.

The [`scripts/host-provisioning-wizard.sh`](../../../scripts/host-provisioning-wizard.sh)
walks the owner through the privileged steps and these suites in order.

---

## AC7 — Failure discipline

A failure during acceptance is a signal to **stop and diagnose**, never a
reason to weaken a boundary. The owner and any operator must not:

1. **Broaden permissions.** Do not widen the `bb-browser` user's privileges,
   grant it ambient repository/workspace access, or relax the installation-/
   host-scoped storage ownership/mode (`0700`, manifests `0600`).
2. **Disable sandboxing.** Do not launch Chrome with `--no-sandbox` or any
   `--disable-web-security` / `--disable-site-isolation-trials` /
   `--ignore-certificate-errors` flag. The `sandbox` capability must stay
   `ready`; `assertDedicatedIdentity` fails any worker report whose command
   contains `--no-sandbox`. The release-scan gate forbids these flags in the
   production build outside the single rejection guard.
3. **Expose raw endpoints.** Do not bind Chrome, CDP, VNC, the dev-browser
   helper, or the Panel Gateway to anything other than `127.0.0.1`
   (`PANEL_GATEWAY_BIND_HOST`). `assertLoopbackSocket` verifies every
   automation endpoint is a loopback listener; `assertLoopbackSocketClosed`
   verifies it closes on stop. Do not forward these ports or place a reverse
   proxy in front of them.
4. **Purge profile data to "fix" a run.** Do not `bb browser purge` or
   `rm -rf` profile data to make a failure disappear. A failure that involves
   retained data is evidence; preserve it for diagnosis (see AC8).

### What to do instead

- **Stop the suite.** A failing test prints the assertion and the named
  boundary. Do not re-run with flags loosened.
- **Capture diagnostics.** Run `bb browser diagnostics --json` and save the
  redacted bundle. It excludes URLs, cookies, scripts, screenshots, and form
  contents by construction.
- **Diagnose against the readiness probes.** Re-run `bb browser status --json`
  and identify which capability regressed. The failure categories map to:
  - `repair-required` — a crash loop (three crashes in five minutes) or
    dependency drift; rerun the relevant setup step, do not disable the
    sandbox.
  - `setup-required` — a missing capability; resume the corresponding setup
    step (idempotent).
  - `unsupported` — the host platform changed; do not attempt a partial
    install.
- **Re-run only after the named capability is `ready` again.** The suites are
  deterministic; a re-run that skips because the host regressed is the correct
  signal that the host is not yet healthy.

### Failure categories the suites distinguish

- A test that **skips** (`it.runIf(integrationEnabled)` off, or
  `ctx.skip()` after the host probe reports a missing capability) is **not a
  failure**. It names the missing capability; provision the host and re-run.
- A test that **fails** means a provisioned boundary regressed. Stop and
  diagnose per above. Never convert a failure into a skip by loosening the
  gate.

---

## AC8 — No purge; retention reported to the owner

The host is **not purged** at the end of issue #24 acceptance. Rationale:

- Profiles and authenticated data are retained on disable/uninstall; only
  `bb browser purge` removes them. Purging would destroy the very evidence
  the acceptance run produced and would violate the retention guarantees in
  the [operator guide](../operators.md#disable-and-uninstall-retention).
- Retained test profile data is the owner's evidence of the acceptance run.

### What is retained vs. cleaned up

- **Retained (left for the owner):** Browser profiles, cookies, site storage,
  and Host Downloads produced by the acceptance fixtures, under the protected
  storage root. The owner decides whether to keep, reset, or delete them.
- **Cleaned up automatically (by the suites' `finally` blocks):** the
  short-lived, worker-scoped fixture profiles the `real-browser-worker.ts`
  fixture creates during a run (`cleanupFixtureProfiles`). These are
  test harness artifacts, not retained Browser profiles; cleaning them up
  matches the mandatory provisioned-host gate's existing behavior and is not a
  purge of the host.

### Final no-purge report

After the suites run, the owner (via the wizard) reports to themselves / the
issue:

- the **owner-approved command log** (the diagnosis + the confirmed setup
  steps),
- the **deterministic acceptance evidence** (which tests passed vs. skipped,
  process/socket inspection, privacy scan, performance measurements),
- the **retained test profile data** location(s) under
  `/var/lib/bb-browser/...`, and
- the **cleanup choice** the owner makes:

  - **Keep** (default) — retained data stays for future runs / inspection.
  - **Reset a profile** — `bb browser reset --profile <id> --confirm "reset"`
    archives the prior profile, creates a fresh one, and revokes grants
    (non-destructive to other profiles).
  - **Delete a profile** — `bb browser delete --profile <id> --confirm <name>`
    permanently removes one profile (requires typing its name; the default
    profile cannot be removed until another is selected).
  - **Explicit purge** — `bb browser purge --confirm "purge Browser"` removes
    all Browser-owned processes, browser data, configuration, and the
    `bb-browser` user. This is the **only** destructive option and is **not**
    required or recommended for issue #24.

The owner records the chosen option in the acceptance report. The agent does
not make this choice and does not run any of these commands.

---

## Order of operations (summary)

1. Owner reviews [`owner-confirmation.md`](owner-confirmation.md) and confirms
   the checklist.
2. Owner performs the privileged setup steps (dedicated-user, system-packages,
   protected-storage) and BB Connect enrollment.
3. Owner confirms `bb browser status --json` reports `healthy`.
4. Owner runs the gated suites (via the wizard or directly with
   `BB_BROWSER_REAL_INTEGRATION=1` and `BB_BROWSER_HOST_DATA_DIR` set).
5. On failure: **stop and diagnose** per AC7; never broaden permissions,
   disable sandbox, expose endpoints, or purge data.
6. On completion: record the no-purge report per AC8 (retained data + cleanup
   choice). The host is **not** purged.
