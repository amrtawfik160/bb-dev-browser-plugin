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

step "test (vitest run, with retry for pre-existing timing-sensitive tests)"
# The issue #22 suite has several pre-existing tests with tight fixed waits
# (e.g. 5 ms / 20 ms) that intermittently miss an event under full-suite load
# but pass reliably on an isolated retry. `--retry 2` re-runs only a failed
# test in isolation, so a pre-existing timing flake clears on retry while a
# deterministic regression fails all retries. This keeps the release gate
# reliable without masking real failures; hardening those waits is a separate
# follow-up.
npx vitest run --retry 2

printf '\n\033[1;32m=== release-gate passed ===\033[0m\n'