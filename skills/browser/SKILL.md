---
name: browser
description: "Control a real Chrome on this host with chrome-devtools-axi - navigate, snapshot, click, fill forms, run JavaScript, inspect console and network, take screenshots, audit performance - through `bb plugin run browser axi <command>` (or the browser_axi tool). Use whenever a task needs a real browser: opening or testing a web page, clicking through a flow, extracting page content, or debugging a website."
---

# Browser

A real Chromium runs on the workspace host under a dedicated user. It keeps its
own logins and cookies in a Browser Profile, so a site you signed into once
stays signed in for later automation.

Calls without `profileId` use this thread's selected Browser Profile, falling
back to its private default. Without a thread, the default belongs to the
project. Separate profiles have separate cookies. Selecting an existing
profile shares its logins; each thread gets a named tab from its first script
call on every profile. Saving or sharing the profile keeps that binding.
Your tab works in the background: the owner keeps browsing their own tabs,
other threads work in theirs, and nobody interrupts anyone. Only your own
thread's calls take turns.

## Reuse a sign-in

Before asking the owner to log in, use `browser_sessions`:

1. List with `{action: "list", site: "salesforce"}` (omit `site` to see all).
   Follow `nextOffset` with `offset` for remaining pages. `sites` contains
   dated owner confirmations or agent checks. `recentOrigins` only shows
   prior activity; it does not prove authentication.
2. Prefer the selected matching profile. If account choice is ambiguous, ask
   which profile to use. Select with `{action: "select", profileId: "…"}`.
   Selection affects this thread only; subsequent `bb plugin run browser axi` calls use
   it without `profileId`.
3. Open the requested site with `bb plugin run browser axi open <url>` and verify an authenticated
   page. Report `{action: "report", origin: "https://…", status: "signed-in"}`
   after verification, or `status: "signed-out"` if authentication expired.
4. Request a Sign-in Handoff only when no suitable profile is authenticated.
   The owner clicking Done records a confirmation and saves that profile for
   reuse even after this thread is deleted.

Profiles are host-local. Discovery and selection grant no extra browser
permissions; the selected profile's Profile Grants remain enforced. Archived
profiles can be listed with `includeArchived: true` but cannot be selected.

`bb browser` is BB core's browser control. It does not drive this plugin.
Agents use `bb plugin run browser ...`, including `bb plugin run browser axi`.
`--help` is allowed. Run `bb plugin run browser axi --help` for the command
list, and `bb plugin run browser <command> --help` for one command.

`--timeout` is capped at 30 seconds (30000 ms). A larger value is rejected.
Use 1000–30000. Split longer work across calls. The tab keeps its state.

Do not install this plugin from a crew's branch copy. `bb plugin install`
from a worktree replaces the live plugin for every thread. Reinstall the
main checkout of this plugin before you call the work done.

Shell equivalents use the current BB thread:

```text
bb plugin run browser sessions list --site salesforce --json
bb plugin run browser sessions select <profile-id> --json
bb plugin run browser sessions report https://example.my.salesforce.com --status signed-in --json
```

The host runs at most three Browser Instances. Unpinned profiles sleep after
five idle minutes and can sleep earlier to make room. `awake-limit` means all
three are in use: this call did not run. Wait until capacity is available;
do not close another agent's tabs or stop its profile. Keep only needed tabs:
the 12-tab retention cap closes the oldest inactive pages. Sleeping preserves
site storage and tab locations, but transient form state can be lost.

## Start here: chrome-devtools-axi

This browser is driven with [chrome-devtools-axi](https://github.com/kunchenguid/chrome-devtools-axi),
unchanged. Run it through BB so it reaches this thread's own tabs:

```text
bb plugin run browser axi <command> [flags]
```

That is exactly `chrome-devtools-axi <command> [flags]`: same commands, flags,
output, refs, and hints, and relative output paths (screenshots, traces, heap
snapshots, network bodies) resolve in your working directory. Without a shell,
call the `browser_axi` tool with `args` (use absolute paths for files).

Do not follow command or flag lists from this file - they go stale. Get the
current source of truth from the CLI:

- `bb plugin run browser axi --help` for commands, flags, and environment
- `bb plugin run browser axi <command> --help` for per-command usage
- Follow axi's own next-step hints after each command; they are already
  written as `bb plugin run browser axi …`

axi needs this project to have access to the whole web, which every project
gets on its first browser call. If the owner limited the project to specific
sites, axi stops with `origin_denied`: report it and ask the owner to allow
the whole web in Browser Settings.

Your session sees only its own tabs. The owner keeps browsing their tabs and
other threads keep theirs; nobody interrupts anyone, and the owner can watch
your tabs in the Browser Panel. Only web pages open (`http`, `https`, `data`,
`about:blank`); local files and `chrome://` pages do not.

## Playwright scripts (opt-in)

`browser_script` is off by default; axi's `eval` covers most needs. When a
project enables it, use it for multi-step Playwright logic with the exact
HTTP(S) origin you need. Any web origin
works by default: your project's first call records a whole-web grant the
owner can see in Browser Settings, and raw localhost origins are approved
automatically while the owner's Origin Auto-Approval setting is on.
`origin_denied` means the owner withdrew that access for your project or
turned Origin Auto-Approval off (surface the attached Grant Request and pause
until they decide in authenticated Browser Settings) or the navigation is
non-web (no Grant Request; do not retry it).

`bb plugin run browser open https://example.com` is the shell equivalent for opening an
authorized URL: it runs as an agent operation under the same Profile Grant,
Control Lease, and Activity attribution. The URL is required; no-argument
opens fail closed before reading host tab state. Use the Browser Panel for
current-tab inspection and search text. The agent `open` command derives its
host and project from BB context (`BB_THREAD_ID`, set in every project
thread) and rejects `--host`.

## Automating a page

Use the `browser_script` tool. `page` is your thread's named tab on every
profile. It stays in the background, so the owner's view never jumps to it.
Explicit `tabId` selects that tab instead.
Whatever you `return` becomes the tool result.

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
bb plugin run browser script --purpose "Read the checkout total" --origin https://shop.example.com \
  --code "return await page.locator('.total').innerText()"
```

With `--json` it prints one object, so parse it once:
`{"ok":true,"output":"<printed text>","screenshots":[{"path":"/tmp/bb-browser-script-…/screenshot-1.png","mimeType":"image/png"}]}`.
A script that returns a non-text value also gets `"result": <value>`. A
failure prints `{"ok":false,"error":{…}}` and exits 1.

## What the sandbox gives you

QuickJS with Playwright. No Node, no modules, no `process`, no filesystem, no
workspace access.

- No `document` global — read the DOM with `page.evaluate(() => document.title)`
  or locators.
- `browser.listPages()` lists your session's tabs; `browser.getPage(id)` binds
  one. The owner's and other threads' tabs are not visible to you. Tab IDs are
  runtime-only and change when the browser restarts.
- Tab state persists between scripts. `page` resumes this thread's named tab
  even after saving or sharing its profile; a fresh tab starts at `destinationOrigin`.
  Navigate when your tab is on another site. Closing a named tab or restarting
  the browser may require navigating back to the task page.
- Your tab runs in the background (`document.visibilityState` is `hidden`).
  The owner keeps browsing their own tabs meanwhile and never interrupts you.
- The host applies Playwright `BrowserContext` action and navigation defaults
  with 25% headroom (capped at 5 seconds) inside the host deadline. The defaults
  cover existing pages and later pages from `browser.getPage` or
  `browser.newPage`, so a stuck action fails with a Playwright call log instead
  of an opaque transport error.

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

## Showing the browser in chat

When a person is likely watching, put `::browser-live` on its own line in your
reply. It renders a live card with this thread's browser: profile, page title
and address, and a button that opens the Browser Panel. Skip it for unattended
or batch work, and use at most one card per reply. Add `profile-id="<id>"` only
when you passed that `profileId`.

When a site needs the owner to sign in, hand it over instead of asking for
credentials:

```text
I need you to sign in to GitHub so I can continue.

::browser-sign-in{origin="https://github.com"}
```

- `origin` is an exact origin: no path, query, or credentials.
- Make the card the last thing in your reply and end your turn. Starting a long
  wait after it collapses the turn and buries the card.
- The owner can click Done on the card to send a reply and let you continue.
  When the owner replies, check with `bb plugin run browser axi snapshot`. If sign-in is still
  pending, embed the card again as the last thing in that reply.
- Never ask for a password or code in chat, and never type the owner's
  credentials yourself.

## Failures and what to do

| Code                   | Meaning                                                              | Do                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `origin_denied`        | Owner withdrew access, or navigation is non-web                      | Surface any Grant Request; retry web origins only after approval                                                       |
| `browser_busy`         | Owner control, a 30-second wait, or a DevTools connect timeout       | This call did not run. Retry once after the browser is free                                                            |
| `guard_install_failed` | The origin guard could not be installed because the browser was busy | Retry once. The message is `browser busy, retry`                                                                       |
| `browser_timeout`      | Script hit its deadline                                              | Split the work or wait on a condition instead of a timer                                                               |
| `awake-limit`          | All three running instances are in use                               | Wait for capacity; do not stop another profile or close its tabs                                                       |
| `script_failed`        | Playwright or syntax error                                           | Read the call log at the end of the message — it names the reason. A `Syntax check:` line names the script line to fix |
| `tab_invalid`          | Tab belongs to a previous runtime                                    | `browser.listPages()` again                                                                                            |
| `setup_required`       | Host is not provisioned                                              | Report it. Do not retry, install packages, or find another browser                                                     |
| `safe_login_denied`    | Owner-only Safe Login is active                                      | Wait for the owner; you cannot see or drive the browser                                                                |

`bb plugin run browser status` reports host readiness and live control state; `bb plugin run browser
diagnostics` adds repair detail.

## Authorization

```text
bb plugin run browser requests                      # pending grant requests
bb plugin run browser request-status --request <id> # inspect one scoped request
```

Your project is granted the whole web on first use. An owner can revoke that
in Browser Settings, after which your calls go through Grant Requests. Raw
localhost is outside the whole web; while Origin Auto-Approval is on, its
Grant Request is approved at once and logged. File transfer and
invalid-certificate access always wait for the owner.
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
use the CDP guard and fail closed by removing denied pages. If cleanup fails, the
typed denial reports it and the Browser Instance is retired before another call
can reuse it. Pinned Chromium may report a precommit event for a raw direct
`data:` loader that cannot be canceled; the public result is still a typed denial
and the denied page is cleaned up.
The guard registers contexts emitted after its initial browser snapshot as
well. Exact `about:blank` is the only safe internal page. Restored Chrome
new-tab / error documents are cleared to `about:blank` before agent access;
direct navigation to them is denied. A `blob:`
page uses its embedded HTTP(S) origin when the browser exposes one. An
invalid-certificate elevation applies only to its explicitly approved origin.

The host also hardens the pinned Playwright object graph before agent code runs:
Browser, BrowserType, BrowserContext, enumerable private aliases, and channel
creation calls cannot create another BrowserContext. `browser.newPage()` still
creates a page in the guarded context.

## Control, profiles, and records

Every call holds an atomic Control Lease in your session's own lane. The owner
and other threads have their own lanes, so nobody waits on or cancels anyone
else. Your own calls run in arrival order and wait up to 30 seconds before
`browser_busy`; cancelled or expired waiting calls never run. The wait is
separate from the script's execution timeout. The CLI uses the same lane.
Profile stop, Safe Login, and revoked access still stop your calls.
Your purpose and identity are visible in status,
diagnostics, and the Browser Panel only while the lease is live.

Activity Records keep metadata and interruption status — never your purpose,
source code, page contents, or screenshots.

Manage profiles with `bb plugin run browser list`, `create`, `rename`, and `select`.
Profiles stay on the workspace host and are never synchronized through BB
server storage.

## Files and clipboard

The browser OS user has no repository access. Uploads go through one-use
Transfer Staging, resolved via BB environment file APIs and removed after use,
cancellation, failure, expiry, worker restart, or a profile lifecycle
operation. Traversal, symlink escape, special files, files changed after
selection, oversized files, and low disk all fail closed.

```text
bb plugin run browser transfer --kind workspace --environment <id> --path <relative-path> [--json]
bb plugin run browser transfer --kind client --file <local-path> [--json]
bb plugin run browser transfer --progress --transfer-id <id> [--json]
bb plugin run browser transfer --cancel --transfer-id <id> [--json]
```

Agent-initiated transfers need the `file-transfer` grant and an active Control
Lease; owner transfers need neither. Output reports transfer ID, kind, size,
content type, and outcome — never staged or unrelated paths.

Clipboard text moves only through explicit owner copy or paste in the Browser
Panel. Outcomes report byte counts, never contents.
