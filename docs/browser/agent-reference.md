# Browser agent reference

This is the agent-facing reference for the **Browser** plugin. It documents the
`browser_script` agent tool, the equivalent `bb browser` CLI, the bundled skill,
typed results, runtime tab identifiers, purposes, time/result bounds, contention,
grants, and explicit retry after denial. All behavior is verified against
`server.ts`, `contracts.ts`, and `skills/browser/SKILL.md`.

## The `browser_script` tool

`browser_script` is a **statically registered** native agent tool. It remains
callable without restarting provider sessions; authorization changes never
require a restart. It derives host and project from BB context and enforces
profile, project, origin, timeout, and lease policy at runtime before delegating
to `dev-browser`.

### Parameters

Parameters are defined by `browserScriptParametersSchema` (`.strict()`):

| Parameter            | Required | Type / bounds                     | Notes                                                                                                                                                       |
| -------------------- | -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose`            | yes      | string, trimmed, 1–200 chars      | Human-readable reason. Shown to the owner only while the Control Lease is live, then discarded.                                                             |
| `code`               | yes      | string, non-empty                 | QuickJS Playwright code. No Node, modules, process, or filesystem access.                                                                                   |
| `destinationOrigin`  | no       | exact `scheme://host:port` origin | Omitting it returns `origin_denied`. Access is denied until the owner grants that origin to this project and profile. Grant changes apply to the next call. |
| `profileId`          | no       | string                            | Host-local Browser Profile ID. Omit to use the selected profile (`bb-personal` by default).                                                                 |
| `tabId`              | no       | string                            | Opaque runtime-only tab ID from `browser.listPages()`. Omit to use the active tab.                                                                          |
| `timeoutMs`          | no       | integer 1000–30000                | Default `30000`; the minimum is `BROWSER_SCRIPT_MIN_TIMEOUT_MS`.                                                                                            |
| `screenshot`         | no       | boolean (default false)           | Request up to 3 native screenshots explicitly.                                                                                                              |
| `fileTransfer`       | no       | boolean (default false)           | Separate elevation; needs its own owner grant.                                                                                                              |
| `invalidCertificate` | no       | boolean (default false)           | Per-origin opt-in; the host bypasses certificate validation only for the exact approved origin.                                                             |

The script runs with Playwright `page` bound to the active tab (or `tabId`).
`return` values become the tool result. There is no `document` global.

`page.setDefaultTimeout` and `page.setDefaultNavigationTimeout` reserve 25% of
the script timeout, capped at five seconds, for the host to return the result.
At the minimum accepted 1,000 ms timeout, Playwright helpers receive 750 ms.
A locator action that never becomes possible therefore returns its useful call
log before the host deadline.

```javascript
return await page.title();
```

```text
bb browser script --purpose "Read the page title" --code "return await page.title()" \
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
and is configured for agents via `bb.agents.configure(() => ({ tools: ["browser_script"], skills: ["browser"] }))`.
It opens with the `browser_script` authorization flow and the agent-scoped
`bb browser open <url>` equivalent, followed by automation recipes and the
failure table. It carries the gotchas that cost real time:
overlays that swallow clicks, keeping one script under ~25 seconds, preferring
`fill` over `click` on inputs, and waiting on conditions rather than timers.

Its guidance for `setup_required` is **final**: report that host setup is
required; do not retry, provision packages, launch a browser through another
path, or seek a raw browser endpoint.

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
   `sleeping` and `waking` appear on `bb browser status` while the instance is
   idle or starting; they do not fail `browser_script`. The instance wakes on
   demand.
2. **Origin denied** (`state: "origin-denied"`, `code: "origin_denied"`) —
   a denied web navigation includes its `origin` and a non-blocking
   `grantRequest` for the owner to approve. A denied non-web navigation has a
   null `origin` and no request.
3. **Runtime error** (`state: "runtime-error"`) — a `code` from:

   | code                | meaning                                                            |
   | ------------------- | ------------------------------------------------------------------ |
   | `browser_busy`      | An owner has control, or 5 s elapsed waiting behind another agent. |
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
or worker restart — list tabs again after any restart. Omitting `tabId` uses the
active tab; targeting another makes it visibly active.

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
- **Two agents**: a competing agent waits at most **5 seconds**
  (`CONTROL_LEASE_AGENT_WAIT_MS`), then receives `browser_busy`. Queued work is
  **never** retained for later execution.
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
bb browser transfer --kind workspace --environment <id> --path <relative-path> [--json]
bb browser transfer --cancel --transfer-id <id> [--json]
bb browser transfer --progress --transfer-id <id> [--json]
```

## Operational diagnostics for agents

```text
bb browser status [--profile <id>] [--host <id>] [--json]
bb browser diagnostics [--profile <id>] [--host <id>] [--json]
```

The live actor and purpose appear in status, diagnostics, and the Browser Panel
only while the lease is active. Treat `setup_required`, `host_offline`,
`repair_required`, `unsupported`, and `safe_login_elsewhere` as terminal for the
current call — report them to the owner rather than retrying or seeking a raw
browser endpoint.
