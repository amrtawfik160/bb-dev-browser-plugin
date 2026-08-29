# Browser plugin release candidate summary

This summary separates the issue #23 release candidate into three sections:
**automated proof**, **current-host steps awaiting owner confirmation**, and
the **optional third-party smoke test**. The automated proof is reproducible
from a clean checkout; the current-host steps require the owner's enrolled
host and privileged confirmation and are explicitly **not** run by this
implementation; the third-party smoke test is optional and records only
pass/fail.

## 1. Automated proof (run from a clean checkout)

Reproduce with:

```sh
rm -rf node_modules dist && npm ci && npm run release-gate
```

`npm run release-gate` (`scripts/release-gate.sh`) runs, in order and
fail-fast: Prettier, ESLint, `tsc --noEmit`, the production build, then
`npx vitest run`. The contract suites poll for the real event/signal with a
bounded timeout (see `test/wait.ts`) instead of tight fixed waits, so the
suite is deterministic under full-suite load and needs no `--retry`. The
script header is the single source for the step order and rationale.

What the automated proof establishes:

- **Gates pass from a clean checkout.** Formatting, linting, type checking,
  the full automated suite, and the production build all pass without
  provisioning or mutating the host.
- **The production package contains exactly the intended components.**
  `test/release-artifact.test.ts` asserts the built `dist/` (server, frontend,
  host bundles + meta pins) and the `npm pack` tarball (`.npmignore`-controlled)
  include the server, frontend, host, CLI, tool, skill, migrations, licenses,
  and shipped documentation, and exclude tests, fixtures, build tooling, and
  planning docs. Exact dependency pins (`dev-browser` `0.2.9`, `playwright`
  `1.58.2`, `ws` `8.21.3`, `zod` `4.3.6`) match `dependencyInventory()`.
- **No dev-only endpoint, debug credential, fixture secret, unsafe browser
  flag, or telemetry is in the production build.**
  `test/release-scan.test.ts` greps the built `dist/` and packaged sources
  for unsafe Chrome flags (`--no-sandbox`, `--disable-web-security`,
  `--disable-site-isolation-trials`, `--ignore-certificate-errors`), non-
  loopback socket binds, telemetry SDKs/endpoints, debug credentials, and
  fixture secrets, with documented allow-listed exceptions (the `--no-sandbox`
  rejection guard and the private-network grant origin list).
- **The SDK contract and dev-browser pin are compatible.**
  `test/release-compatibility.test.ts` asserts the built artifact SDK pins,
  the plugin manifest contract, public-SDK-only usage, and the `dev-browser`
  `0.2.9` + fallback browser pin across every surface.
- **Lifecycle transitions work through public contracts without provisioning
  the host.** `test/release-lifecycle.test.tsx` exercises install, enable,
  disable, re-enable, upgrade-with-active-work (active work not restarted),
  uninstall-retain, and explicit-purge planning through the in-memory/loopback
  harness with a simulated privileged executor.
- **Pre-existing evidence remains green.** The issue #21 evidence suites
  (privacy, recovery, performance, security, sensitive-data, storage-failure,
  restorable-session) and the issues #2–#20 contract suites continue to pass.

The review axes (clean-code, test-quality, documentation, security boundary,
blast-radius) were run against the fixed revision `39a3182`; see
[`release-review-checklist.md`](release-review-checklist.md) for the
per-axis outcome and the review-fix-loop artifacts
(`findings-issue-23.md` and `closure-issue-23.md`) that evidence AC4 and AC5.

## 2. Current-host steps awaiting owner confirmation

These require the owner's enrolled BB Connect host and explicit privileged
confirmation; they are **not** run by this implementation and are not part of
the automated proof. They are the same current-host steps recorded in
[`verification-report.md`](verification-report.md) and
[`docs/verification-plan.md`](../verification-plan.md):

- **Privileged setup.** Creating the `bb-browser` user, configuring secure
  storage, and installing Chrome / display helpers requires explicit owner
  confirmation (`bb browser setup`). `bb browser setup --json` prints the
  exact OS user, packages, directories, and permissions for separate owner
  confirmation before any privileged change; the plugin never silently
  mutates privileged host state.
- **Provisioned-host real-browser acceptance.** `npm run test:real-browser`
  (`BB_BROWSER_REAL_INTEGRATION=1`) runs the real-Chromium integration suite
  against a healthy enrolled host. In this environment it is deterministically
  skipped (it surfaces as skipped, not passed, so the missing capability stays
  visible).
- **Remote BB Connect acceptance.** The manual acceptance plan in
  [`docs/verification-plan.md`](../verification-plan.md#manual-remote-acceptance)
  covers both panel actions, profile creation, local-app login persistence,
  shared tabs and control, agent access and denial, Safe Login opacity,
  transfers, sleep/wake, and recovery, through the owner's authenticated BB
  Connect instance.
- **Real-process performance thresholds.** Warm/cold first frame, loopback
  input-to-frame p95, interaction FPS, and resident memory are registered
  with `it.runIf(integrationEnabled)` and run only on a provisioned host; they
  report skipped here.

Record the results of these steps (pass/fail) against the fixed revision
before declaring the release candidate final.

## 3. Optional third-party smoke test

After the deterministic suite and the current-host steps pass, the owner
**may** perform an optional manual smoke test against a third-party site of
their choice — for example, a site that previously rejected automation, to
confirm Safe Login Mode's compatibility claim without claiming universal login
compatibility.

- Use only the owner's own credentials; **real third-party credentials never
  enter automated fixtures.**
- Record only pass/fail. Do not record credentials, screenshots, DOM, or URL
  details in any plugin artifact.
- A failure here is a compatibility limitation, recorded in
  [`limitations.md`](limitations.md#third-party-login), not a regression of a
  claimed feature (the plugin must not claim universal login compatibility).

This smoke test is optional and is not a gate for the release candidate.
