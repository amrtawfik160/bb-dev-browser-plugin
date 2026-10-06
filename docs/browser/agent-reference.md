# Browser agent reference

This is the agent-facing reference for the **Browser** plugin. It documents the
`browser_script` agent tool, the equivalent `bb plugin run browser` CLI, the bundled skill,
typed results, runtime tab identifiers, purposes, time/result bounds, contention,
grants, and explicit retry after denial. All behavior is verified against
`server.ts`, `contracts.ts`, and `skills/browser/SKILL.md`.

## The `browser_script` tool

`browser_script` and `browser_sessions` are **statically registered** native
agent tools. Tool-set changes apply on the next provider session start;
authorization changes apply to the next call without a restart. They derive
host and project from BB context and enforce
profile, project, origin, timeout, and lease policy at runtime before delegating
to `dev-browser`.

### Parameters

Parameters are defined by `browserScriptParametersSchema` (`.strict()`):

| Parameter            | Required | Type / bounds                     | Notes                                                                                                                                                                                                                                                      |
| -------------------- | -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose`            | yes      | string, trimmed, 1–200 chars      | Human-readable reason. Shown to the owner only while the Control Lease is live, then discarded.                                                                                                                                                            |
| `code`               | yes      | string, non-empty                 | QuickJS Playwright code. No Node, modules, process, or filesystem access.                                                                                                                                                                                  |
| `destinationOrigin`  | no       | exact `scheme://host:port` origin | Omitting it returns `origin_denied`. Any web origin is allowed by default; the first call records a whole-web grant for this project and profile. Once the owner revokes that grant, access waits on their approval. Grant changes apply to the next call. |
| `profileId`          | no       | string                            | Host-local Browser Profile ID. Omit to use this thread's selection, falling back to its private default.                                                                                                                                                   |
| `tabId`              | no       | string                            | Opaque runtime-only tab ID from `browser.listPages()`. Omit to use this thread's named tab.                                                                                                                                                                |
| `timeoutMs`          | no       | integer 1000–30000                | Default `30000`; the minimum is `BROWSER_SCRIPT_MIN_TIMEOUT_MS`.                                                                                                                                                                                           |
| `screenshot`         | no       | boolean (default false)           | Request up to 3 native screenshots explicitly.                                                                                                                                                                                                             |
| `fileTransfer`       | no       | boolean (default false)           | Separate elevation; needs its own owner grant.                                                                                                                                                                                                             |
| `invalidCertificate` | no       | boolean (default false)           | Per-origin opt-in; the host bypasses certificate validation only for the exact approved origin.                                                                                                                                                            |

The script runs with Playwright `page` bound to the explicit `tabId`, else to
this thread's named tab from its first script call on every profile. Saving
or sharing its profile preserves the binding. A closed or unrestored named
tab is recreated at `destinationOrigin`. `return` values become the tool result. There is no
`document` global. Your session connects through its own Session CDP Proxy:
`browser.listPages()` and `browser.getPage()` reach only your tabs and the
popups they open, never the owner's or another thread's. For browsing, use
chrome-devtools-axi: `bb plugin run browser axi <command>` (ADR 0022).

The host applies `BrowserContext.setDefaultTimeout` and
`BrowserContext.setDefaultNavigationTimeout` to the shared context, reserving
25% of the script timeout, capped at five seconds, for the host to return the
result. This covers pages already in the context and later pages obtained
through the supported `browser.getPage` and `browser.newPage` paths. At the
minimum accepted 1,000 ms timeout, Playwright helpers receive 750 ms. A locator
action that never becomes possible therefore returns its useful call log before
the host deadline.

```javascript
return await page.title();
```

```text
bb plugin run browser script --purpose "Read the page title" --code "return await page.title()" \
  --origin https://example.com \
  [--profile <id>] [--tab <id>] [--timeout <ms>] \
  [--screenshot] [--file-transfer] [--invalid-certificate] [--json]
```

The CLI derives project and host from BB context and does **not** accept
`--host` for the agent `script` or `open` commands. Without `--json`, text results print directly; with
`--json`, you get the JSON result or the screenshot envelope.

> The `script` subcommand rejects `--host`, `--confirm`, and any script-only
> option when used with another command; `open` also rejects `--host` (verified
> in `validateCliCommandOptions`).

## The bundled skill

The bundled skill lives at [`skills/browser/SKILL.md`](../../skills/browser/SKILL.md)
and is configured for agents via `bb.agents.configure(() => ({ tools: ["browser_script", "browser_sessions"], skills: ["browser"] }))`.
It opens with the `browser_script` authorization flow and the agent-scoped
`bb plugin run browser open <url>` equivalent, followed by automation recipes and the
failure table. It carries the gotchas that cost real time:
overlays that swallow clicks, keeping one script under ~25 seconds, preferring
`fill` over `click` on inputs, and waiting on conditions rather than timers.

Its guidance for `setup_required` is **final**: report that host setup is
required; do not retry, provision packages, launch a browser through another
path, or seek a raw browser endpoint.

## Browser Cards in chat

Two message directives render live cards in a reply (ADR 0019). Each goes on
its own line.

| Directive                                    | Card                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `::browser-live`                             | Profile, state, active tab title and address, **Open in panel**  |
| `::browser-sign-in{origin="https://x.test"}` | Sign-in Handoff: the owner opens the origin in the Browser Panel |

- Both use the profile this thread's Browser Panel shows. Add
  `profile-id="<id>"` only when the scripts passed that `profileId`.
- `origin` must be an exact HTTP(S) origin: no path, query, fragment, or
  credentials. Unknown attributes make the card render an error instead.
- Embed a card only when a person is likely watching, and at most one per
  reply.
- A Sign-in Handoff is the last thing in its reply; end the turn after it. If
  sign-in is still pending when you check back, embed it again.
- Never ask for passwords or codes in chat, and never type the owner's
  credentials. Safe Login Mode is a separate owner-only flow.

## Typed results

`browser_script` returns a `BrowserScriptResponse` discriminated on `ok`
(verified in `contracts.ts`).

### Success

```json
{ "ok": true, "result": <text, JSON, or screenshot envelope> }
```

Browser Results are structured text/JSON capped at **256 KiB**
(`BROWSER_SCRIPT_RESULT_LIMIT_BYTES`) plus explicitly requested native image
outputs (up to **3** screenshots, each ≤ 1 MiB; PNG/JPEG/WebP). They become
ordinary BB thread content and may enter provider context; the plugin keeps no
additional copy.

### Failure

`{ "ok": false, "error": <one of the schemas below> }`

The `error` is one of:

1. **`BrowserStatus`** — a blocking host/instance state such as
   `setup_required`, `host_offline`, `repair_required`, `unsupported`, or
   `safe_login_elsewhere`. `setup_required` is final for the current call.
   `sleeping` and `waking` appear on `bb plugin run browser status` while the instance is
   idle or starting; they do not fail `browser_script`. The instance wakes on
   demand.
2. **Origin denied** (`state: "origin-denied"`, `code: "origin_denied"`) —
   a denied web navigation includes its `origin` and a non-blocking
   `grantRequest` for the owner to approve. A denied non-web navigation has a
   null `origin` and no request.
3. **Runtime error** (`state: "runtime-error"`) — a `code` from:

   | code                | meaning                                                            |
   | ------------------- | ------------------------------------------------------------------ |
   | `browser_busy`      | An owner has control, or 30 s elapsed waiting behind other agents. |
   | `browser_timeout`   | The script exceeded its timeout.                                   |
   | `result_too_large`  | Output exceeded 256 KiB.                                           |
   | `lease_revoked`     | The owner revoked the lease.                                       |
   | `tab_invalid`       | The `tabId` no longer exists (list tabs again after a restart).    |
   | `sandbox_violation` | The script tried to access Node/filesystem.                        |
   | `script_failed`     | The Playwright code threw.                                         |
   | `safe_login_denied` | Safe Login Mode is active; agents are excluded.                    |

Each runtime error carries a `label`, `hostId`, `profileId`, and a bounded
`message` (≤ 500 chars), and never carries a `grantRequest`.

## Runtime tab identifiers

Tab identifiers are **opaque and runtime-only**. They do not survive a browser
or worker restart — list tabs again after any restart. Omitting `tabId` uses
this thread's named tab; targeting another makes it visibly active.

## Purposes

The `purpose` is agent-supplied text shown to the owner **only while the lease
is live**, then discarded. It is **not** retained in Activity Records, logs,
diagnostics, or the database (verified by the sensitive-data evidence suite).

## Time and result bounds

- Script timeout is **1–30 seconds**. Playwright navigation and locator waits
  reserve 25% headroom, capped at five seconds, so a hung helper fails as
  `script_failed` before the host deadline.
- Structured results are capped at **256 KiB**.
- Screenshots: at most **3** per call, each ≤ 1 MiB, PNG/JPEG/WebP only, and only
  when explicitly requested (`screenshot: true`).
- An agent lease is atomic and lasts no longer than the timeout.

## Contention

Every script holds one atomic **Control Lease** for its host and profile.

- **Owner has priority**: owner navigation interrupts an agent immediately; the
  agent receives a typed error (the lease is revoked or busy).
- **Two agents**: a competing agent waits in arrival order for at most
  **30 seconds** (`CONTROL_LEASE_AGENT_WAIT_MS`), then receives `browser_busy`
  without running. This wait is separate from `timeoutMs`, which bounds script
  execution. Cancelled, expired, and owner-interrupted waiting calls are removed.
- If another agent still has control after the wait, let that operation finish
  before retrying once. Switching from the tool to the CLI uses the same lease.
- Commands are never replayed automatically after a denial, revocation, or
  timeout.

## Grants and explicit retry after denial

1. Without a matching web-origin grant, the call returns `origin_denied` with a
   non-blocking Grant Request. Non-web navigation returns the typed denial
   without a request. **Stop and surface the denial to the owner**; do not loop.
2. The owner approves in authenticated Browser Settings: next retry, one hour,
   or persistent. The **default is one retry**.
3. After approval, **retry explicitly**. The failed script never resumes
   automatically; grant changes apply to the **next** call only.

The CLI has no authenticated owner identity. Grant administration and request
decisions therefore fail closed there with Browser Settings guidance; a TTY,
shell access, or confirmation flag does not confer owner authority.

Grant Request expiry (verified in `grant-requests.ts`):

- Undecided Grant Request: **15 minutes**.
- One-retry authorization: **5 minutes** or first use.
- Whole-web, file-transfer, invalid-certificate: defaults to **1 hour** and
  needs a second confirmation to persist.

## Files and clipboard (agent view)

- The browser OS user has no ambient repository access. Workspace uploads resolve
  through BB's environment file APIs and must remain inside the environment after
  realpath resolution; traversal, symlink escape, special files, changed files,
  oversized files, and low-disk all fail closed.
- **Agent-initiated transfers and exports require the `file-transfer` grant and
  an active Control Lease.** Owner transfers require neither.
- Clipboard text moves only through explicit owner copy/paste actions in the
  Browser Panel; the plugin never continuously synchronizes clipboards and
  reports byte counts, never contents.

Stage a workspace file from a thread (exact flags in
[cli-reference.md](cli-reference.md)):

```text
bb plugin run browser transfer --kind workspace --environment <id> --path <relative-path> [--json]
bb plugin run browser transfer --cancel --transfer-id <id> [--json]
bb plugin run browser transfer --progress --transfer-id <id> [--json]
```

## Operational diagnostics for agents

```text
bb plugin run browser status [--profile <id>] [--host <id>] [--json]
bb plugin run browser diagnostics [--profile <id>] [--host <id>] [--json]
```

The live actor and purpose appear in status, diagnostics, and the Browser Panel
only while the lease is active. Treat `setup_required`, `host_offline`,
`repair_required`, `unsupported`, and `safe_login_elsewhere` as terminal for the
current call — report them to the owner rather than retrying or seeking a raw
browser endpoint.
