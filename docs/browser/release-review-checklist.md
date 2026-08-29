# Browser plugin release review checklist

This checklist records that the issue #23 release-quality gates were reviewed
against a fixed revision along the five review axes, and references the
review-fix-loop artifacts that evidence each axis. The five-axis review is
executed by the review-fix gate (the `review-fix-loop` skill); this artifact
pins the revision it ran against and records the outcomes so a reviewer can
re-pin the same revision and re-run every axis deterministically.

## Fixed revision

The five-axis review ran against a single fixed revision: the issue #23
release-candidate commit `39a3182` (the tip of the release branch on top of
the issue #22 head `7cd8fe7`). The confirmed findings were then fixed by the
findings-fix commit directly on top of `39a3182` (the tip of this branch; pin
it with `git rev-parse HEAD`). The review base and the fix commit are both
named in the review artifacts below.

Every axis was run against `39a3182`; the confirmed findings were fixed in the
findings-fix commit and the affected evidence was rerun against that commit.

## The five review axes

1. **Clean-code review** — Clean Code, SOLID, DRY, KISS, YAGNI, and
   LLM-specific failure modes against the changed production code. Run via
   the `clean-code-guard` skill against the diff since the issue #22 head
   (`7cd8fe7`).

2. **Test-quality review** — the universal testing rules against the changed
   test code (the new release-* tests and any evidence rerun). Run via the
   `test-guard` skill against the same diff.

3. **Documentation review** — every referenced function, flag, endpoint,
   config key, and code sample in the shipped docs is checked against the
   source; docs-vs-code drift is caught. Run via the `docs-guard` skill.

4. **Security boundary review** — the release-scan allow-list
   (`test/release-scan.test.ts`), the unsafe-flag guard, the loopback-bind
   guarantee, the fixture-secret exclusion, and the private-network grant
   origin list are reviewed against the source for any new exception that
   weakens a boundary. Cross-references
   [`security.md`](security.md) and
   [`test/evidence/security.evidence.test.ts`](../../test/evidence/security.evidence.test.ts).

5. **Blast-radius review** — what the change could break elsewhere, beyond
   the diff, proven by running real code rather than reasoning. Run via the
   `blast-radius` skill against the fixed revision. For this release the
   blast radius is the package surface (`.npmignore` + `files`), the built
   `dist/` artifact, and the lifecycle/package contract tests that drive the
   public seams.

## Automated gate

The release gate is `scripts/release-gate.sh` (`npm run release-gate`). It
runs the gates in order and fails fast; see the script header for the step
order. From a clean checkout:

```sh
rm -rf node_modules dist && npm ci && npm run release-gate
```

The new release-quality tests added by issue #23 are listed in the script
header and in [`release-candidate-summary.md`](release-candidate-summary.md).

## Review-fix-loop outcome (AC4 / AC5)

The review-fix gate was executed against the fixed revision `39a3182`. Its
evidence lives in the orchestration artifacts:

- **Confirmed findings:** `findings-issue-23.md` records every confirmed
  Standards (S1–S6) and Spec (P1–P5) finding against `39a3182`.
- **Fix:** the findings-fix commit (tip of this branch, on top of `39a3182`)
  applies every confirmed finding — S1 reverts the `browser-process.ts`
  side-fix; S2 replaces the tight fixed waits with bounded `waitFor` polling
  and removes `--retry 2`; S3 tightens the `0.0.0.0`/`[::]` allow-list to the
  `RAW_LOCALHOST_HOSTS` literal; S4 makes the credential and telemetry scans
  inspect the plugin's own built `dist/*.js` code; S5 single-sources the
  removed-`--retry` rationale; S6 adds trailing newlines and the two release
  docs to the required-docs list.
- **Evidence rerun:** the full gate (`prettier --check`, ESLint, `tsc
--noEmit`, the production build, and `vitest run` with no retry) was rerun
  against the findings-fix commit and passes deterministically (verified by
  running `vitest run` more than once from a clean checkout).
- **Closure:** `closure-issue-23.md` records the per-finding application and
  any rejected findings.
- **Rejected findings:** none were rejected; every Standards and Spec finding
  in `findings-issue-23.md` was applied.

The five axes were run with outcomes; AC4 (reviews run against a fixed
revision) and AC5 (every confirmed finding fixed, affected evidence rerun,
rejected findings carrying rationale) are demonstrated by these in-repo
references rather than a future-tense runbook.
