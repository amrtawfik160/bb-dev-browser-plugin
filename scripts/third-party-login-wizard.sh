#!/usr/bin/env bash
#
# Third-party login smoke-test wizard for issue #25.
#
# Walks the human owner through the OPTIONAL, opt-in third-party login smoke
# test. The owner explicitly opts in, selects the site, and personally enters
# all credentials and second-factor challenges in Safe Login Mode. This wizard
# NEVER enters credentials, NEVER auto-executes a login, and NEVER mutates the
# host. It only:
#
#   1. Reminds the owner of the privacy/isolation guarantees and the runbook.
#   2. Runs read-only diagnostics (bb browser status / diagnostics) after the
#      owner confirms each step.
#   3. After the owner has personally completed the sign-in in Safe Login Mode
#      and chosen Done, runs the gated privacy/isolation suite
#      (test/third-party-login-privacy.evidence.test.ts) to verify nothing
#      leaked and the boundaries stayed intact.
#
# Every privileged or credential-bearing action is performed by the owner. The
# wizard runs only read-only diagnostics and the gated test suite, each behind
# an explicit per-step "yes" confirmation. The gated suite skips
# deterministically (never fails) without a provisioned host.
#
# This script does not provision or mutate the host.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNBOOK_DOC="$ROOT/docs/browser/third-party-login-smoke-test.md"
SAFE_LOGIN_DOC="$ROOT/docs/browser/safe-login.md"
SUIT="test/third-party-login-privacy.evidence.test.ts"

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
Issue #25 third-party login smoke-test wizard.

This is an OPTIONAL, opt-in compatibility check. It is NOT required for the
deterministic release gate. The agent never performs it; this wizard only
guides YOU, the owner, through the steps only you can perform.

You will explicitly opt in, select the site, and personally enter ALL
credentials and second-factor challenges in Safe Login Mode. This wizard NEVER
enters credentials and NEVER auto-executes a login. It runs only read-only
diagnostics and the gated privacy/isolation suite, each behind an explicit
per-step "yes".

Before anything, read the runbook and the Safe Login docs:
EOF
printf '  %s\n' "$RUNBOOK_DOC"
printf '  %s\n' "$SAFE_LOGIN_DOC"

require_bb

step "1 · Opt in and confirm the host is provisioned (read-only)"
cat <<'EOF'
The smoke test runs only on a provisioned, BB-Connect-enrolled host. Confirm:
  - you have READ the runbook and Safe Login docs above,
  - you EXPLICITLY opt in to this optional check (it is off by default),
  - the host is provisioned ('bb browser status --json' reports state "healthy"
    with every capability "ready"; if not, follow
    docs/browser/host-provisioning/acceptance-runbook.md first).
EOF
run_or_skip "Run 'bb browser status --json' (read-only)?" bb browser status --json || true
if ! prompt_yes "Have you read the runbook, opted in, and is the host healthy?"; then
  echo "Provision the host and opt in before continuing. Aborting."
  exit 1
fi

step "2 · Select the site yourself"
cat <<'EOF'
Choose ONE site you own or are authorized to test (personal email provider,
social account, internal tool you administer). The agent does not choose a site
for you and does not narrow the choice. Do not test a site you lack permission
to sign in to. Prefer a site whose sign-in you already know works in a normal
browser, so an incompatibility is attributable to the Safe Login path rather
than a forgotten credential.

Record only the site CATEGORY (e.g. "personal email provider"), never the
origin, in your final outcome.
EOF
if ! prompt_yes "Have you selected a site you are authorized to test?"; then
  echo "Select a site before continuing. Aborting."
  exit 1
fi

step "3 · Enter Safe Login Mode and sign in yourself"
cat <<'EOF'
In the Browser Panel, enter Safe Login Mode for the current profile yourself.
Then sign in to the site YOU selected, typing ALL credentials and second-factor
challenges yourself. The agent cannot read the screen, type into the page,
capture a screenshot, read cookies, or read the URL bar while you are signed
in. There is no agent opt-in to Safe Login.

This wizard does NOT enter Safe Login Mode for you and does NOT sign in. Take
as long as you need; you may STOP at any time (close the panel, choose Done, or
let the lease expire) — none of these weaken any boundary.

When you have finished signing in (or decided to stop), continue.
EOF
if ! prompt_yes "Have you personally completed the sign-in (or chosen to stop) in Safe Login Mode?"; then
  echo "Complete the sign-in yourself, then re-run this wizard from step 4. Aborting."
  exit 1
fi

step "4 · Optional authenticated-state check (YOUR decision)"
cat <<'EOF'
AC4: YOU decide whether a minimal, NON-SENSITIVE authenticated-state check is
appropriate. You are NOT required to perform any check beyond confirming the
sign-in succeeded. If you do perform a check, it must reveal NO account or
site-sensitive detail (no site origin, account id, password, one-time code,
cookie, full URL, DOM content, screenshot, or page text).

This wizard does NOT perform any check on your behalf.
EOF
if ! prompt_yes "Have you decided on the (optional) authenticated-state check (or chosen to skip it)?"; then
  echo "Decide on the check, then continue. Aborting."
  exit 1
fi

step "5 · Choose Done to return to Automation Mode"
cat <<'EOF'
Choose Done (or let the lease expire, or close the final Safe Login panel) to
return the SAME profile to Automation Mode. Because the profile is unchanged,
your authenticated session in that profile is preserved.
EOF
if ! prompt_yes "Have you chosen Done and returned the profile to Automation Mode?"; then
  echo "Choose Done before continuing. Aborting."
  exit 1
fi

step "6 · Record only the minimal compatibility outcome"
cat <<'EOF'
Record ONLY one of three results, plus an optional high-level failure category
that reveals NO account or site-sensitive details:

  pass    — you signed in and chose Done; the profile returned to Automation Mode.
  fail    — sign-in did not complete, or Done did not return to Automation Mode.
  skipped — you opted out, stopped early, or the host was not provisioned.

High-level categories (no site/account/URL/error text):
  safe-login-compatible      — the Safe Login path worked for this site.
  safe-login-isolation       — a Safe Login isolation/reconciliation guarantee
                               did not hold; do NOT record the site/account/URL.
  safe-login-not-exercised   — the check was not performed.

NEVER record the site origin, account identifier, password, one-time code,
cookie, full URL, DOM content, screenshot, or page text.
EOF
read -r -p "Enter the result (pass|fail|skipped) [leave blank to skip recording here]: " RESULT
case "${RESULT:-}" in
  ""|pass|fail|skipped) ;;
  *) echo "Unknown result '$RESULT'; recording nothing here (use the runbook labels)." ;;
esac

step "7 · Verify the guarantees: run the gated privacy/isolation suite"
cat <<'EOF'
After Done, run the gated suite to verify nothing leaked and the boundaries
stayed intact. It is gated behind the real-browser integration flag and skips
deterministically (never fails) without a provisioned host, naming the exact
missing capability.

It needs:
  BB_BROWSER_REAL_INTEGRATION=1               # turn the provisioned-host gate ON
  BB_BROWSER_HOST_DATA_DIR=<daemon data dir>  # BB daemon data directory

Optional overrides:
  BB_BROWSER_REAL_ROOT=<storage root>     # defaults to /var/lib/bb-browser
  BB_BROWSER_REAL_HOST_ID=<host id>      # defaults to ci-browser-host
  BB_BROWSER_REAL_PROFILE_ID=<profile>   # defaults to ci-auth-fixture
  BB_BROWSER_REAL_PROJECT_ID=<project>   # defaults to ci-browser-project
EOF
if prompt_yes "Run the gated privacy/isolation suite now with BB_BROWSER_REAL_INTEGRATION=1?"; then
  if [ -z "${BB_BROWSER_HOST_DATA_DIR:-}" ]; then
    echo "ERROR: BB_BROWSER_HOST_DATA_DIR must be set to the BB daemon data directory."
    echo "Set it and re-run this wizard (or export it before this prompt)."
    exit 1
  fi
  export BB_BROWSER_REAL_INTEGRATION=1
  echo "Running: BB_BROWSER_REAL_INTEGRATION=1 npx vitest run $SUIT"
  npx vitest run "$SUIT"
  echo "Gated suite complete. Skipped tests name the exact missing capability;"
  echo "failures stop for diagnosis (see $RUNBOOK_DOC 'Failure discipline') —"
  echo "NEVER broaden permissions, disable the sandbox, expose endpoints, or"
  echo "purge data to make a check pass."
else
  echo "You can run the suite yourself later with BB_BROWSER_REAL_INTEGRATION=1"
  echo "and BB_BROWSER_HOST_DATA_DIR set."
fi

step "8 · Final record"
cat <<'EOF'
Record in the issue comment (issue #25):
  - your opt-in (that you chose to perform the check),
  - the site CATEGORY only (e.g. "personal email provider"), not the origin,
  - the minimal result (pass|fail|skipped) and high-level category,
  - confirmation that the gated privacy/isolation suite passed (or which tests
    skipped and the missing-capability reason), and
  - confirmation that the boundaries (sandbox, origin policy, transport
    authentication, privacy) remained intact.

That is the entire record. Nothing about your credentials, account, or the site
content is captured.
EOF
echo "Done. See $RUNBOOK_DOC for the full opt-in checklist and failure discipline."