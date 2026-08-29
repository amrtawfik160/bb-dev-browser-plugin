# Browser plugin release review checklist

This checklist wires the issue #23 release-quality gates against the five
review axes and the review-fix-loop contract. It documents the **fixed
revision** the reviews run against and the **five review axes**; the actual
reviews are performed by the review-fix gate (the `review-fix-loop` skill),
not by this implementation. This artifact exists so a reviewer can pin the
same revision and re-run every axis deterministically.

## Fixed revision

Reviews run against a single fixed revision: the issue #23 release-candidate
commit (the tip of the release branch on top of the issue #22 head
`7cd8fe7`). Pin it before review:

```sh
git rev-parse HEAD   # record this SHA as the review base
```

Every axis below is run against that exact revision. A finding is confirmed
or rejected against that revision; if fixes land, the revision advances and
the affected axes (and their evidence) are rerun against the new revision.

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

## Automated gates run before review

The release gate (`scripts/release-gate.sh`, `npm run release-gate`) runs in
order and fails fast:

1. `prettier --check .` (formatting)
2. `npm run lint` (ESLint)
3. `npm run typecheck` (`tsc --noEmit`)
4. `npm run build` (`bb plugin build` → `dist/`)
5. `npx vitest run --retry 2` (Vitest; `--retry 2` clears pre-existing
   timing-sensitive tests that pass on an isolated retry; deterministic
   failures still fail consistently)

From a clean checkout:

```sh
rm -rf node_modules dist && npm ci && npm run release-gate
```

The new release-quality tests added by issue #23:

- `test/release-artifact.test.ts` — built `dist/` + packaged tarball contain
  exactly the intended components; exact dependency pins match
  `dependencyInventory()`.
- `test/release-scan.test.ts` — no dev-only endpoint, debug credential,
  fixture secret, unsafe Chrome flag, or telemetry in the production build
  (with documented allow-listed exceptions).
- `test/release-lifecycle.test.tsx` — install, enable, disable, re-enable,
  upgrade-with-active-work, uninstall-retain, and explicit-purge planning
  through public contracts without provisioning the host.
- `test/release-compatibility.test.ts` — SDK contract surface and dev-browser
  `0.2.9` pin compatibility.

## Review-fix-loop contract

This is the contract for the review-fix gate that follows the five-axis
review; it is **not** performed by this implementation.

- **Every confirmed review finding is fixed.** A finding is confirmed when a
  reviewer (or review skill) identifies a real defect in one of the five
  axes against the fixed revision. Confirmed findings are fixed in code,
  not waived.
- **Affected evidence is rerun.** After a fix, the gate reruns every gate or
  evidence suite the fix could touch: at minimum `npm run release-gate`, and
  any specific evidence suite a finding names (for example
  `test/evidence/security.evidence.test.ts` for a security-boundary finding).
  A fix is not accepted until the affected suites pass against the new
  revision.
- **Rejected findings record a concrete rationale.** A finding is rejected
  only with a written rationale that names the spec, ADR, contract, or
  allow-list entry that makes the behavior intentional. Rejected findings
  and their rationales are recorded in the review gate's output (and, when
  they affect an allow-list, documented in
  `test/release-scan.test.ts`). "I disagree" is not a rationale.

The loop terminates when the five axes are run against a fixed revision,
every confirmed finding is fixed and its affected evidence reruns green, and
every rejected finding carries a concrete rationale.
