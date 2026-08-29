# Optional third-party login smoke test

Issue [#25](https://github.com/amrtawfik160/bb-dev-browser-plugin/issues/25)
— `ready-for-human`. This is an **owner-only, opt-in** compatibility check.
It is **not** required for deterministic release acceptance.

> **The agent never performs this check.** This document is the agent-doable
> _preparation_ the owner uses to perform the optional smoke test and verify
> the privacy/isolation guarantees. The agent does not enter credentials, does
> not perform a real third-party login, and does not mutate the host.

## What this check is (and is not)

The deterministic suite ([release-gate](../../test/release-artifact.test.ts),
contract tests, the in-memory evidence suites, and the issue #24 host
acceptance suites) is the **deterministic release gate**. Those suites use a
**local loopback authentication fixture** — they never enter real third-party
credentials (see the [frozen parent spec](../browser-plugin-spec.md): _"Real
third-party credentials never enter automated fixtures."_).

This smoke test is an **optional, manual, owner-performed** compatibility
probe against one real site the owner chooses. It answers a single question:

> _Can the owner sign in to this one site through Safe Login Mode, and does the
> profile return cleanly to Automation Mode with no sensitive data captured?_

The plugin **does not claim universal login compatibility**. Hardware-bound
passkeys, DRM, and corporate device policies may still prevent a login even in
Safe Login Mode. See [limitations.md](limitations.md).

## Opt-in checklist (AC1)

Perform every step yourself. The agent does **not** do any of these.

1. **Read this document and [safe-login.md](safe-login.md) in full.**
2. **Confirm the host is provisioned.** Run `bb browser status --json` and
   confirm `state` is `healthy` with every capability `ready`. If the host is
   not provisioned, follow the [host provisioning acceptance
   runbook](host-provisioning/acceptance-runbook.md) first — this smoke test
   only runs on a provisioned, BB-Connect-enrolled host.
3. **Opt in explicitly.** This check is off by default. Opt in by running the
   wizard (`scripts/third-party-login-wizard.sh`) and confirming each step, or
   by entering Safe Login Mode yourself in the Browser Panel. Nothing runs
   automatically.
4. **Select the site yourself.** See _Site selection_ below. The agent does not
   choose a site for you.
5. **Enter all credentials and second-factor challenges yourself, in Safe Login
   Mode.** The agent never enters, sees, or stores credentials, passwords,
   one-time codes, passkeys, cookies, or any second-factor challenge. You type
   them into the Safe Login panel yourself. See [safe-login.md](safe-login.md)
   for what changes in this mode.
6. **Decide whether a minimal, non-sensitive authenticated-state check is
   appropriate.** This is your decision (AC4). You are _not_ required to
   perform any check beyond confirming the sign-in succeeded. If you do perform
   a check, it must reveal **no** account or site-sensitive detail (see
   _Recording the outcome_).
7. **Choose Done** to return the profile to Automation Mode.
8. **Record only the minimal compatibility outcome** (AC5). See _Recording the
   outcome_.
9. **Run the gated privacy/isolation suite** to verify nothing leaked
   (AC2/AC3/AC5). See _Verifying the guarantees_.

## You personally enter every credential (AC1)

- Only the **initiating panel** receives Safe Login pixels. Other owner panels
  show an opaque mode indicator and receive **no pixels**.
- Agents receive **neither pixels nor DOM access**; `browser_script` calls
  return a typed `safe_login_denied` error for the whole duration of Safe Login
  Mode.
- The agent cannot read the screen, type into the page, capture a screenshot,
  read cookies, or read the URL bar while you are signed in. By construction
  there is no agent opt-in to Safe Login.
- Your credentials, second-factor challenges, cookies, and the page contents
  stay in the Chrome profile the `bb-browser` user owns. They are **not**
  captured in the issue, logs, diagnostics, Activity Records, or test
  artifacts.

## Site selection

- Choose **one** site you own or are authorized to test. A personal email
  provider, a social account, or an internal tool you administer are good
  candidates. Do not test a site you do not have permission to sign in to.
- Prefer a site whose sign-in you already know works in a normal browser, so
  an incompatibility is attributable to the automated/Safe-Login path rather
  than a forgotten credential.
- The site is **your** choice. The agent does not recommend a specific site and
  does not narrow the choice.

## Optional and stoppable at any time (AC6)

- This check is **optional**. Skipping it does not block a release; the
  deterministic suite is the release gate.
- You may **stop at any time**: close the Safe Login panel, choose Done, let
  the lease expire, or simply abandon the check. None of these weakens any
  boundary (see _Failure discipline_).
- You may re-run the check against a different site later; each run records only
  the minimal outcome for that site.

## Recording the outcome (AC5)

Record **only** one of three results, plus an optional high-level failure
category that reveals **no** account or site-sensitive details:

| Result    | When                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `pass`    | You signed in and chose Done; the profile returned to Automation Mode. |
| `fail`    | Sign-in did not complete, or Done did not return to Automation Mode.   |
| `skipped` | You opted out, stopped early, or the host was not provisioned.         |

Acceptable high-level failure categories (the agent's gated suite uses these
exact labels):

- `safe-login-compatible` — the Safe Login path worked for this site.
- `safe-login-isolation` — a Safe Login isolation/reconciliation guarantee did
  not hold; **do not** record the site name, account, URL, or error text.
- `safe-login-not-exercised` — the check was not performed.

**Never record** the site origin, account identifier, password, one-time code,
cookie, full URL, DOM content, screenshot, or page text. If you are unsure
whether a note is safe, omit it.

## Verifying the guarantees (AC2/AC3/AC5)

After you choose Done, run the gated privacy/isolation suite:

```bash
# Requires a provisioned, BB-Connect-enrolled host:
export BB_BROWSER_REAL_INTEGRATION=1
export BB_BROWSER_HOST_DATA_DIR=<daemon data dir>
npx vitest run test/third-party-login-privacy.evidence.test.ts
```

Without a provisioned host every test **skips deterministically (never fails)**,
naming the exact missing capability. The suite verifies, on a provisioned host
with you opted in:

- **No sensitive data captured (AC2/AC5):** no credential, full URL, DOM
  content, screenshot, input, cookie, or page content appears in logs,
  diagnostics, Activity Records, or test artifacts. It reuses the issue #21
  `findSensitiveData` / `SENSITIVE_DATA_PATTERNS` scan helpers.
- **Panels opaque, agents denied throughout Safe Login (AC3):** only the
  initiating panel gets pixels; other panels stay opaque; agents are denied for
  the whole duration. It reuses the issue #18 Safe Login policy/fixture and the
  issue #24 host-provisioning helpers.
- **Only the minimal outcome recorded (AC5):** a `pass`/`fail`/`skipped` result
  with a high-level failure category that reveals no account or site-sensitive
  detail.
- **Done returns to Automation Mode (AC4):** the profile returns to Automation
  Mode, and the test asserts the mode transition and that nothing leaked — **not**
  that any particular authenticated-state check was performed. Whether a minimal
  non-sensitive check is appropriate is **your** decision.

## Done and reconciliation (AC4)

Choosing **Done**, lease expiry, or closing the final Safe Login panel
gracefully returns the **same profile** to Automation Mode (reattaching the
automation endpoint). Because the profile is unchanged, your authenticated
session in that profile is preserved.

You decide whether a minimal, non-sensitive authenticated-state check is
appropriate before or after Done. The gated suite asserts the mode transition
and the no-leak guarantee; it does **not** assert that any particular
authenticated-state check was performed.

## Failure discipline (AC7)

Any unexpected behavior — a failed sign-in, an isolation glitch, a tool error,
or a test assertion — is handled **without weakening**:

- the Chrome sandbox (`--no-sandbox` is never used),
- the origin policy (exact `scheme://host:port` origins; no global relaxation),
- transport authentication (loopback + BB Connect; endpoints never exposed
  externally), and
- the privacy boundaries (no capture of credentials, URLs, cookies, DOM,
  screenshots, or page contents).

If the smoke test or the gated suite reports an unexpected result:

1. **Do not broaden permissions, disable the sandbox, expose endpoints, or
   purge data.** A compatibility miss is never a reason to weaken a boundary.
2. Record only the minimal outcome (`fail` + the high-level category).
3. Open an issue with the high-level category and **no** site/account/URL/error
   detail.
4. The gated suite asserts the boundaries remain intact after the run, so a
   missed sign-in does not leave the host in a weaker state.

## Wizard

`scripts/third-party-login-wizard.sh` walks you through the opt-in, site
selection, personal credential entry in Safe Login Mode, the optional
authenticated-state check, and recording only the minimal outcome. It runs
only read-only diagnostics and the gated privacy/isolation suite, each behind
an explicit per-step `yes` confirmation. It **never** enters credentials and
**never** auto-executes a login.

## Verification summary

After the optional smoke test, record in the issue comment:

- your opt-in (that you chose to perform the check),
- the site **category** only (e.g. "personal email provider"), not the origin,
- the minimal result (`pass` / `fail` / `skipped`) and high-level category,
- confirmation that the gated privacy/isolation suite passed (or which tests
  skipped and the missing-capability reason), and
- confirmation that the boundaries (sandbox, origin policy, transport
  authentication, privacy) remained intact.

That is the entire record. Nothing about your credentials, account, or the site
content is captured.
