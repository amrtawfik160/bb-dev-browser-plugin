#!/usr/bin/env bash
#
# Host provisioning wizard for issue #24.
#
# Walks the human owner through the privileged steps ONLY they can perform on
# the current enrolled host, in order:
#
#   1. Readiness diagnosis (read-only).
#   2. Owner confirmation of the supported-host diagnosis, proposed commands,
#      rollback limits, and purge boundary (docs/browser/host-provisioning/
#      owner-confirmation.md).
#   3. Privileged setup commands (dedicated-user, system-packages,
#      protected-storage) and BB Connect enrollment.
#   4. Running the gated acceptance / performance / privacy suites.
#   5. The final no-purge report (AC8).
#
# This wizard NEVER auto-executes a privileged command without the owner
# confirming each step. Read-only diagnosis and the gated test suites are the
# only commands it will run after an explicit per-step "yes"; the privileged
# setup commands are printed for the owner to run themselves (the wizard does
# not run `bb browser setup --step ... --confirm` or `bb connect` enrollment on
# the owner's behalf).
#
# This script does not provision or mutate the host. It is safe to run on a
# non-provisioned host: the gated suites skip deterministically (never fail).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIRMATION_DOC="$ROOT/docs/browser/host-provisioning/owner-confirmation.md"
RUNBOOK_DOC="$ROOT/docs/browser/host-provisioning/acceptance-runbook.md"

color() { printf '\033[1m%s\033[0m\n' "$1"; }
prompt_yes() {
  # Returns 0 only on an explicit, full "yes". Anything else aborts the step.
  local answer
  read -r -p "$1 [type 'yes' to confirm]: " answer
  [ "$answer" = "yes" ] || { echo "Not confirmed; skipping this step."; return 1; }
  return 0
}

run_or_skip() {
  # Run a read-only command after the owner confirms; never auto-run privileged.
  if prompt_yes "$1"; then
    shift
    "$@"
  else
    echo "Step skipped."
  fi
}

step() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }

require_bb() {
  command -v bb >/dev/null 2>&1 || {
    echo "ERROR: 'bb' is not on PATH. Install/enroll BB first." >&2
    exit 1
  }
}

step "0 · Welcome"
cat <<'EOF'
Issue #24 host-provisioning wizard.

This wizard guides you, the owner, through the privileged steps only you can
perform on the current enrolled host. It will NOT run any privileged command
without your explicit per-step confirmation, and it will NOT run the privileged
setup commands itself — it prints them for you to run.

Before anything, read the owner-confirmation artifact:
EOF
printf '  %s\n' "$CONFIRMATION_DOC"
echo "and the failure-discipline runbook:"
printf '  %s\n' "$RUNBOOK_DOC"

require_bb

step "1 · Readiness diagnosis (read-only)"
echo "These commands change nothing. They report the host's current state."
run_or_skip "Run 'bb browser status --json' (read-only)?" bb browser status --json || true
run_or_skip "Run 'bb browser diagnostics --json' (read-only)?" bb browser diagnostics --json || true
echo "Also useful (run yourself, read-only):"
echo "  uname -m                      # must print x86_64"
echo "  grep ^ID= /etc/os-release      # must be ubuntu or debian"
echo "  df -h /var/lib/bb-browser      # must show >= 5 GiB free"
echo "  bb connect status              # host enrolled?"

step "2 · Owner confirmation"
echo "Open the owner-confirmation artifact and complete its checklist:"
printf '  %s\n' "$CONFIRMATION_DOC"
echo "You must initial every item before any privileged command below."
echo "In particular, confirm: the supported-host diagnosis is accurate, the"
echo "proposed commands/packages/dedicated-user/storage targets are correct,"
echo "rollback limits are understood, and the host will NOT be purged (AC8)."
if ! prompt_yes "Have you completed and signed the owner-confirmation checklist?"; then
  echo "Please complete the checklist before continuing. Aborting."
  exit 1
fi

step "3 · Privileged setup (YOU run these; the wizard does not)"
cat <<'EOF'
The three setup steps are idempotent and resumable. The wizard does NOT run
these for you. Run each yourself, in order, reviewing the plan first:

  bb browser setup --json                                   # show the plan (no changes)
  bb browser setup --step dedicated-user     --confirm "create bb-browser user" --json
  bb browser setup --step system-packages    --confirm "install browser packages" --json
  bb browser setup --step protected-storage  --confirm "create protected storage" --json

Then enroll the host in BB Connect (owner-only, via the BB desktop client or
'bb connect'); the 'bb-connect' capability reports 'ready' only when the host's
config.json has a machineCredential.

After setup, re-run the read-only diagnosis until 'bb browser status --json'
reports state "healthy" with all nine capabilities "ready".
EOF
if ! prompt_yes "Have you run the setup steps above and 'bb browser status --json' now reports healthy?"; then
  echo "Complete setup until the host is healthy, then re-run this wizard from step 4."
  exit 1
fi

step "4 · Run the gated acceptance / performance / privacy suites"
cat <<'EOF'
The gated suites skip deterministically (never fail) without a provisioned
host. They need two environment variables:

  BB_BROWSER_REAL_INTEGRATION=1          # turns the provisioned-host gate ON
  BB_BROWSER_HOST_DATA_DIR=<daemon data dir>  # BB daemon data directory
                                              (the installation id is derived from it)

Optional overrides:
  BB_BROWSER_REAL_ROOT=<storage root>     # defaults to /var/lib/bb-browser
  BB_BROWSER_REAL_HOST_ID=<host id>      # defaults to ci-browser-host
  BB_BROWSER_REAL_PROFILE_ID=<profile>   # defaults to ci-auth-fixture
  BB_BROWSER_REAL_PROJECT_ID=<project>   # defaults to ci-browser-project

The suites:
  test/host-setup-verification.test.ts     # AC2 setup verification
  test/host-acceptance.evidence.test.ts    # AC3/AC4 remote acceptance
  test/host-performance.evidence.test.ts   # AC5 performance thresholds
  test/host-privacy-scan.test.ts           # AC6 privacy scan
EOF
if prompt_yes "Run the gated host suites now with BB_BROWSER_REAL_INTEGRATION=1?"; then
  if [ -z "${BB_BROWSER_HOST_DATA_DIR:-}" ]; then
    echo "ERROR: BB_BROWSER_HOST_DATA_DIR must be set to the BB daemon data directory."
    echo "Set it and re-run this wizard (or export it before this prompt)."
    exit 1
  fi
  export BB_BROWSER_REAL_INTEGRATION=1
  echo "Running: BB_BROWSER_REAL_INTEGRATION=1 vitest run \
test/host-setup-verification.test.ts \
test/host-acceptance.evidence.test.ts \
test/host-performance.evidence.test.ts \
test/host-privacy-scan.test.ts"
  npx vitest run \
    test/host-setup-verification.test.ts \
    test/host-acceptance.evidence.test.ts \
    test/host-performance.evidence.test.ts \
    test/host-privacy-scan.test.ts
  echo "Gated suites complete. Skipped tests name the exact missing capability;"
  echo "failures stop for diagnosis (see $RUNBOOK_DOC AC7) — never broaden"
  echo "permissions, disable the sandbox, expose endpoints, or purge data."
else
  echo "You can run the suites yourself later with BB_BROWSER_REAL_INTEGRATION=1"
  echo "and BB_BROWSER_HOST_DATA_DIR set."
fi

step "5 · Final no-purge report (AC8)"
cat <<'EOF'
The host is NOT purged at the end of issue #24. Record in the acceptance
report (e.g. a comment on issue #24):

  - the owner-approved command log (diagnosis + confirmed setup steps),
  - the deterministic acceptance evidence (passed vs. skipped tests, process/
    socket inspection, privacy scan, performance measurements),
  - the retained test profile data location(s) under /var/lib/bb-browser/...,
  - your cleanup choice (default: keep):
      keep        — retained data stays (default)
      reset       — bb browser reset --profile <id> --confirm "reset"
      delete      — bb browser delete --profile <id> --confirm <name>
      purge       — bb browser purge --confirm "purge Browser"  (DESTRUCTIVE;
                    NOT required or recommended for #24)

The agent does not make this choice and does not run any of these commands.
EOF
echo "Done. See $RUNBOOK_DOC for the full failure discipline and retention policy."
