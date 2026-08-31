# Browser quickstart (user guidance)

Everyday use of the **Browser** plugin as an owner or authorized agent. This
guide covers both launch surfaces, profiles, tabs, controller transfer, grants
and requests, Safe Login, clipboard, uploads, downloads, activity, sleep/wake,
and recovery states.

> **Prerequisite:** the host must be set up before browsing is possible. If the
> panel shows **Setup required**, follow the operator's
> [setup guide](operators.md#setup) (or run `bb browser setup`). This guide
> assumes a **healthy** host.

## Open the Browser Panel

The Browser Panel is the interactive browsing surface registered on **two**
launch surfaces (verified in `app.tsx`):

1. **Existing thread** — open any BB thread and choose the **Browser** action in
   the thread's right panel.
2. **New thread** — choose the **Browser** action on the New thread launcher.

Both actions register under the same id `browser` with the Globe icon and a
flush layout that maximizes the browser canvas. Repeated **Browser** actions
focus the existing panel tab for that profile; selecting another profile opens
or focuses that profile's tab.

### Host and profile resolution

- An **existing thread** resolves its host from the thread's BB environment.
- **New thread** remembers the selected project's last host and profile. If the
  compose is ambiguous or projectless, you get a host picker. A host without a
  remembered profile uses the default profile `bb-personal`.

If the host cannot serve the panel it reports one of these states instead of a
canvas (see [troubleshooting](troubleshooting.md)):

- **Setup required** · **Host offline** · **Waking** · **Safe Login elsewhere** ·
  **Repair required** · **Unsupported**

## Profiles

A **Browser Profile** is a named, host-local browser identity containing site
authentication and storage. Profiles may be reused across repositories on the
same host but are **never synchronized to another host**.

- The default profile is `bb-personal`. A clean profile skips welcome pages and
  opens `about:blank`; later starts restore the active tab.
- Locale and timezone are captured from the creating owner client, stay stable
  across displaying clients, and are editable in Settings.
- New instances and downloads are refused below 5 GiB host free space (enforced
  by the `disk-headroom` readiness capability, which reports `repair-required`
  below that floor). Cookies and site storage are never deleted automatically;
  a reset requires owner confirmation.

Manage profiles from a project thread (exact flags in
[cli-reference.md](cli-reference.md)):

```text
bb browser list                       # list host-local profiles
bb browser create --name "Work"        # create a profile
bb browser rename --profile <id> --name "Personal"
bb browser select --profile <id>       # set the selected profile
```

Archive, reset, delete, import, backup, and restore are owner operations; see
[operators.md](operators.md). Browser Tabs belong to a profile, not a BB thread.

## Tabs

Every profile has **one shared active tab** and one shared ordered tab set.
Every Browser Panel using that profile observes the same tabs and the same
active tab; switching the active tab requires control and all spectator panels
follow. Popups become shared Browser Tabs.

- Address input uses a valid URL directly; otherwise it delegates to Chrome's
  configured search engine.
- Automation Mode provides common link/image actions but omits native Chrome
  context menus and DevTools in v1. Safe Login retains native browser UI.
- Alert, confirm, prompt, and before-unload dialogs render in BB. Unresolved
  agent dialogs are dismissed when the agent's Control Lease ends.

## Controller transfer

All panels receive live state, but only one owner client or agent holds the
**Control Lease** at a time.

- A second owner client is **view-only** until it explicitly chooses
  **Take control**.
- **Owner interaction has priority** and may interrupt an agent at any time.
- On connection loss, input freezes immediately and the same panel has
  **ten seconds** to reclaim its Control Lease before it is released.
- The controlling panel drives one shared logical viewport (up to 1920×1080);
  other panels scale and letterbox it.

## Grants and requests

Agents are **denied by default**. A persistent **Profile Grant** authorizes one
BB project to fully automate one profile at explicit web origins. Grants are
managed in authenticated Browser Settings, not from a thread.

- **Origin Scope** uses exact `scheme://host:port` origins and optional explicit
  subdomain patterns such as `https://*.example.test`. URL paths do not narrow
  a grant; each localhost port is separate; `*` is a distinct whole-web
  permission. Cross-origin frames require their own grant.
- A grant binds to the exact BB project identifier and covers its providers,
  threads, environments, and worktrees. It does **not** follow copied projects.
  Deleting a project or revoking a grant interrupts active agent work without
  closing your page.
- Disallowed HTTP(S) navigation is aborted before commit by the host route.
  Direct agent non-web `Frame.goto` is rejected before its Playwright command
  reaches Chromium; renderer-initiated navigation, redirects, popups, and
  frames fail closed through the CDP guard. Exact `about:blank` is the only
  safe internal exception; HTTP(S)-backed `blob:` uses its embedded origin, and
  cross-origin subresources may render normally.

### Grant Requests (after a denial)

A denied web origin produces a typed `origin_denied` result and a non-blocking
**Grant Request** that surfaces as an in-app badge. Non-web navigation produces
the typed denial without a request. For a web origin, the owner may permit:

- the next matching retry,
- one hour, or
- persistent access.

The **default is one retry**, and the failed script never resumes
automatically — the agent must retry explicitly after approval.

Grant Request lifecycle (verified in `grant-requests.ts`):

- Grant Requests expire after **15 minutes** if undecided.
- A one-retry authorization expires after **5 minutes** or on first use.
- Whole-web, file-transfer, and invalid-certificate access defaults to **one
  hour** and requires a second confirmation to persist.

Inspect requests from a thread:

```text
bb browser requests
bb browser request-status --request <id>
```

## Safe Login

**Safe Login Mode** is an owner-only mode for sites that reject automation. The
plugin warns about unsaved transient state, interrupts agents, gracefully
restarts Chrome, and relaunches the same profile **without an automation
attachment**. See [safe-login.md](safe-login.md) for the full workflow.

Key guarantees while Safe Login is active:

- Only the initiating panel receives Safe Login pixels.
- Other owner panels show an opaque mode indicator.
- Agents receive **neither pixels nor DOM access**; agent calls return a typed
  `safe_login_denied` error.

A lease lasts **15 minutes**, warns before expiry, can be extended once (total
ceiling 30 minutes), and exits to Automation Mode when you choose **Done**, the
lease expires, or the final Safe Login panel closes.

## Clipboard

Text clipboard exchange is **explicit** — the plugin never continuously
synchronizes clipboards. Clipboard text moves only through explicit owner copy or
paste actions in the Browser Panel. Outcomes report byte counts, never contents
(max 4 MiB per exchange).

## Uploads

Uploads may come from the displaying client or an explicitly selected workspace
file. The browser OS user (`bb-browser`) **never receives repository access**.

- Workspace selections resolve through BB's environment file APIs, must remain
  inside the environment after realpath resolution, and are copied into
  one-use **Transfer Staging** that is removed after use, cancellation, failure,
  expiry, worker restart, or profile lifecycle operations.
- Traversal, symlink escape, special files, changed-after-selection files,
  oversized files, and low-disk conditions all fail closed.
- Agent-initiated transfers additionally require the `file-transfer` grant and
  an active Control Lease; owner transfers require neither.

Stage a transfer from a thread (exact flags in
[cli-reference.md](cli-reference.md)):

```text
bb browser transfer --kind workspace --environment <id> --path <relative-path> [--json]
bb browser transfer --kind client --file <local-path> [--json]
bb browser transfer --cancel --transfer-id <id> [--json]
bb browser transfer --progress --transfer-id <id> [--json]
```

The output is privacy-safe: it shows the transfer id, kind, size, and content
type only. The staged path and unrelated workspace paths are never printed.

## Downloads

A **Host Download** is a quarantined file downloaded by a Workspace Browser and
retained on that workspace host. It is **never opened or executed
automatically**.

- Host Downloads expire after **7 days**. Defaults are **1 GiB per file** and
  **5 GiB per profile**, configurable by the owner (up to 16 GiB/file and
  64 GiB/profile).
- Exporting a download to a workspace or client is explicit. Export never
  overwrites an existing workspace file without separate owner confirmation.
- **Agent export** requires the `file-transfer` grant.

Manage downloads from a thread:

```text
bb browser downloads list [--profile <id>] [--json]
bb browser downloads progress --download-id <id> [--json]
bb browser downloads cancel --download-id <id> [--json]
bb browser downloads export-client --download-id <id> [--json]
bb browser downloads export-workspace --download-id <id> --environment <id> --path <relative-path> [--overwrite] [--json]
bb browser downloads limits [--max-file-bytes <n>] [--max-profile-bytes <n>] [--expiry-ms <n>] [--json]
bb browser downloads purge [--profile <id>] [--json]
```

## Activity

**Activity Records** are metadata-only audit entries. They retain actor,
project, profile, destination origin, timing, outcome, and interruption state —
**never** scripts, purposes, passwords, keystrokes, form contents, page
contents, screenshots, clipboard contents, or ordinary owner browsing URLs.

- Records expire after **30 days** or **10,000 entries** per profile, whichever
  comes first.
- Grant changes, control transfers, mode transitions, setup, profile lifecycle,
  and file exports also produce Activity Records.
- The owner can export or clear retained metadata.

```text
bb browser activity [--profile <id>] [--json]
bb browser activity-export [--profile <id>] [--json]
bb browser activity-clear [--profile <id>] --confirm "Clear Browser activity records" [--json]
```

The live actor and purpose of an active lease appear in `bb browser status`,
`bb browser diagnostics`, and the Browser Panel **only while the lease is
active**; the purpose is not retained.

## Sleep and wake

- A Browser Instance **sleeps after 30 minutes** without panel or agent
  activity. Its Browser Profile and Restorable Session remain on disk.
- At most **three profiles** are awake by default. A visible panel or active
  Control Lease keeps its instance awake; the least-recently-used hidden
  instance sleeps when capacity is needed.
- Instances **wake lazily** after BB or host restarts; updates never restart
  active work.

## Recovery states

- On a **browser crash**, active operations fail. The plugin attempts a clean
  restart, but after **three crashes within five minutes** it stops and exposes
  **Repair required** diagnostics (no further relaunch attempts).
- **Restorable Session** behavior: durable site authentication, storage, and
  open-tab locations restore after a restart; transient form state and exact
  navigation history are best-effort.
- Host disconnect: input freezes, the panel shows an **Host offline** state, and
  on reconnect the host inventory is reconciled to the same profile. Profiles
  never fail over between hosts.

See [troubleshooting.md](troubleshooting.md) for diagnosing each state and
[verification-report.md](verification-report.md) for the evidence behind each
claim.
