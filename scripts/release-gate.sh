#!/usr/bin/env bash
# Release-quality gate for bb-plugin-browser (issue #23).
#
# Runs the established gates in order and fails fast on the first failure:
#   1. Prettier formatting check
#   2. ESLint
#   3. TypeScript type checking (noEmit)
#   4. Production build (bb plugin build -> dist/)
#   5. Vitest automated suite
#
# The build runs before the tests because the release-artifact and release-scan
# tests assert against the built dist/ output. Run from a clean checkout with:
#
#   rm -rf node_modules dist && npm ci && npm run release-gate
#
# This gate does not provision or mutate the host. The provisioned-host
# real-browser integration tests are intentionally excluded (they require
# `BB_BROWSER_REAL_INTEGRATION=1` and a healthy enrolled host).
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  printf '\n\033[1m=== release-gate: %s ===\033[0m\n' "$1"
}

step "format:check (prettier)"
npx prettier --check .

step "lint (eslint)"
npm run lint

step "typecheck (tsc --noEmit)"
npm run typecheck

step "build (bb plugin build)"
npm run build

step "test (vitest run)"
# The contract suites poll for the real event/signal with a bounded timeout
# (test/wait.ts) instead of tight fixed waits, so the suite is deterministic
# under full-suite load and does not need --retry. See issue #23 S2.
npx vitest run

printf '\n\033[1;32m=== release-gate passed ===\033[0m\n'
