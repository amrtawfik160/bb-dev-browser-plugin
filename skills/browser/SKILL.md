---
name: browser
description: Drive a real Chromium on this host — open pages, click, type, read, and screenshot — with Playwright through the browser_script tool or the bb browser CLI. Use for web automation, testing a running app, checking a deployed page, or any task that needs a real browser.
---

# Browser

A real Chromium runs on the workspace host under a dedicated user. It keeps its
own logins and cookies in a Browser Profile, so a site you signed into once
stays signed in for later automation.

## Start here

Use `browser_script` with the exact HTTP(S) origin you need. If it returns
`origin_denied`, surface any Grant Request to the owner and pause until the
owner makes a decision in authenticated Browser Settings. A non-web navigation
is denied without a Grant Request.

`bb browser open https://example.com` is the shell equivalent for opening an
authorized URL: it runs as an agent operation under the same Profile Grant,
Control Lease, and Activity attribution. The URL is required; no-argument
opens fail closed before reading host tab state. Use the Browser Panel for
current-tab inspection and search text.

## Automating a page

Use the `browser_script` tool. `page` is the active tab, already bound and
brought to front. Whatever you `return` becomes the tool result.

```javascript
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
await page.locator("#email").fill("user@example.com");
await page.locator("button[type=submit]").click();
await page.waitForURL(/\/dashboard/);
return JSON.stringify({
  url: page.url(),
  heading: await page.locator("h1").innerText(),
});
```

Required fields: `purpose` (shown to the owner while you hold control) and
`destinationOrigin` (the exact origin you are driving, e.g.
`https://example.com`). Optional: `profileId`, `tabId`, `timeoutMs` (1000–30000,
default 30000), `screenshot: true`, `fileTransfer`, `invalidCertificate`.

The same boundary from a shell:

```text
bb browser script --purpose "Read the checkout total" --origin https://shop.example.com \
  --code "return await page.locator('.total').innerText()"
```

## What the sandbox gives you

QuickJS with Playwright. No Node, no modules, no `process`, no filesystem, no
workspace access.

- No `document` global — read the DOM with `page.evaluate(() => document.title)`
  or locators.
- `browser.listPages()` lists tabs; `browser.getPage(id)` binds one. Tab IDs are
  runtime-only and change when the browser restarts.
- Tab state persists between scripts. If a tab is already on your granted
  origin, `page` binds to it — read it instead of navigating again.
- `page.setDefaultTimeout` and `page.setDefaultNavigationTimeout` leave 25%
  headroom (capped at 5 seconds) inside the host deadline, so a stuck action
  fails with a Playwright call log instead of an opaque transport error.

## Things that actually bite

**Overlays swallow clicks.** Autocomplete dropdowns, cookie banners, and modals
sit over the element you want, and Playwright waits for them rather than
clicking through. The call log says `… subtree intercepts pointer events`.
Dismiss it first:

```javascript
await page.keyboard.press("Escape");
const consent = page.locator('button:has-text("Accept all")').first();
if ((await consent.count()) > 0) await consent.click();
```

**Keep one script under ~25 seconds of real work.** The whole script shares one
deadline. Split long flows into several calls — the tab keeps its state between
them.

**Prefer `fill` + `press` over `click` on inputs.** `fill` does not need the
element to be clickable, which sidesteps most overlay problems.

**Wait for the thing, not for time.** `page.waitForURL`, `waitForSelector`, and
`locator.waitFor` beat `waitForTimeout`, which burns your deadline.

**Search boxes submit through the keyboard.** Race the navigation against the
keypress so you do not miss it:

```javascript
await Promise.all([page.waitForURL(/\/search\?/), box.press("Enter")]);
```

## Failures and what to do

| Code                | Meaning                                | Do                                                                 |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `origin_denied`     | Grant missing or navigation is non-web | Surface any Grant Request; retry web origins only after approval   |
| `browser_busy`      | Someone else holds control             | Wait and retry once; queued work is not kept                       |
| `browser_timeout`   | Script hit its deadline                | Split the work or wait on a condition instead of a timer           |
| `script_failed`     | Playwright error                       | Read the call log at the end of the message — it names the reason  |
| `tab_invalid`       | Tab belongs to a previous runtime      | `browser.listPages()` again                                        |
| `setup_required`    | Host is not provisioned                | Report it. Do not retry, install packages, or find another browser |
| `safe_login_denied` | Owner-only Safe Login is active        | Wait for the owner; you cannot see or drive the browser            |

`bb browser status` reports host readiness and live control state; `bb browser
diagnostics` adds repair detail.

## Authorization

```text
bb browser requests                      # pending grant requests
bb browser request-status --request <id> # inspect one scoped request
```

Grantable scopes are exact origins (`https://example.com`) or explicit
subdomain patterns (`https://*.example.com`) or `*`. Paths are not grantable.
The owner manages grants and request decisions in authenticated Browser
Settings. CLI grant-administration names fail closed with Settings guidance
because shell access, a TTY, or a confirmation flag does not authenticate an
owner. A grant change applies to the next call and never resumes a denied one.

Origin Scope is enforced outside the QuickJS sandbox by layered host controls.
The host route matches HTTP(S) grants before commit. During an Origin Scope
agent call, the pinned Playwright connection adapter rejects direct non-web
`Frame.goto` before forwarding its `goto` command; it allows exact
`about:blank`, HTTP(S), and HTTP(S)-backed `blob:` only for the host to classify
and match. Renderer-initiated location changes, redirects, popups, and frames
use the CDP guard and fail closed by removing denied pages. Pinned Chromium may
report a precommit event for a raw direct `data:` loader that cannot be canceled;
the public result is still a typed denial and the denied page is cleaned up.
The guard registers contexts emitted after its initial browser snapshot as
well. Exact `about:blank` is the only safe internal page exception. A `blob:`
page uses its embedded HTTP(S) origin when the browser exposes one. An
invalid-certificate elevation applies only to its explicitly approved origin.

The host also hardens the pinned Playwright object graph before agent code runs:
Browser, BrowserType, BrowserContext, enumerable private aliases, and channel
creation calls cannot create another BrowserContext. The plugin wrapper's
`browser.newPage()` still creates a page in the guarded context.

## Control, profiles, and records

Every script holds one atomic Control Lease per host and profile. Owner
navigation wins immediately. A competing agent waits at most five seconds, then
gets `browser_busy`. Your purpose and identity are visible in status,
diagnostics, and the Browser Panel only while the lease is live.

Activity Records keep metadata and interruption status — never your purpose,
source code, page contents, or screenshots.

Manage profiles with `bb browser list`, `create`, `rename`, and `select`.
Profiles stay on the workspace host and are never synchronized through BB
server storage.

## Files and clipboard

The browser OS user has no repository access. Uploads go through one-use
Transfer Staging, resolved via BB environment file APIs and removed after use,
cancellation, failure, expiry, worker restart, or a profile lifecycle
operation. Traversal, symlink escape, special files, files changed after
selection, oversized files, and low disk all fail closed.

```text
bb browser transfer --kind workspace --environment <id> --path <relative-path> [--json]
bb browser transfer --kind client --file <local-path> [--json]
bb browser transfer --progress --transfer-id <id> [--json]
bb browser transfer --cancel --transfer-id <id> [--json]
```

Agent-initiated transfers need the `file-transfer` grant and an active Control
Lease; owner transfers need neither. Output reports transfer ID, kind, size,
content type, and outcome — never staged or unrelated paths.

Clipboard text moves only through explicit owner copy or paste in the Browser
Panel. Outcomes report byte counts, never contents.
