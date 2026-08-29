# `bb browser` CLI reference

Every command below is the exact surface handled in `server.ts` and was
verified against the source. The plugin namespace is `browser`. Flag names are
not interchangeable — for example, `transfer` uses `--environment <id>
--path <relative-path>`, not `--source`/`--environment-root`.

Common conventions:

- `--json` (where shown) returns structured output; without it, commands print
  human-readable text.
- `--host <id>` (where shown) selects a host. The `script` command does not
  accept `--host` — it derives the host from BB context.
- `--profile <id>` (where shown) selects a Browser Profile; omit it to use the
  selected profile.

## Opening the browser

```text
bb browser open [url] [--profile <id>] [--timeout <ms>] [--screenshot] [--json]
```

Navigates the active tab and reports the resulting URL, page title, and tab ID.
Navigation runs as the owner, so it needs no Profile Grant and wakes a sleeping
Browser Instance.

With no argument, `open` reports the tab the profile is already on without
navigating; a profile with no open tab yet says so and asks for a URL. Bare text
resolves through the profile's configured search engine and reports
`Chrome's configured search engine is unavailable.` when the profile has none.

Reading the page back does need a grant. Until one exists, `open` still reports
the navigation and prints a one-line hint pointing at `bb browser trust`.

## Readiness and diagnostics

```text
bb browser status [--profile <id>] [--host <id>] [--json]
bb browser diagnostics [--profile <id>] [--host <id>] [--json]
```

- `status` prints the label, message, and a nine-capability checklist (`✓`
  ready, `-` otherwise, with a reason per line). States: `setup-required`,
  `sleeping`, `waking`, `host-offline`, `safe-login-elsewhere`,
  `repair-required`, `unsupported`, `healthy`.
- `diagnostics` returns a redacted diagnostics bundle (excludes URLs, cookies,
  profile data, scripts, screenshots, form contents, and purposes).

## Agent script

```text
bb browser script --purpose <text> --code <source> --origin <origin> \
  [--profile <id>] [--tab <id>] [--timeout <ms>] \
  [--screenshot] [--file-transfer] [--invalid-certificate] [--json]
```

`--purpose`, `--code`, and `--origin` are required. `--origin` must be an exact
web origin such as `https://example.com`. `--timeout` must be an integer from 1
to 30000. `--host` and `--confirm` are invalid for `script`. The script runs with
Playwright `page` bound to the active tab; `return` values print as the result.
See [agent-reference.md](agent-reference.md) for typed results.

## Activity records

```text
bb browser activity [--profile <id>] [--host <id>] [--json]
bb browser activity-export [--profile <id>] [--host <id>] [--json]
bb browser activity-clear [--profile <id>] --confirm "Clear Browser activity records" [--json]
```

`activity-clear` requires the literal confirmation text shown above.

## Grants and grant requests

```text
bb browser trust [--origin <scope>] [--profile <id>] [--host <id>] [--file-transfer] [--json]
bb browser untrust [--origin <scope>] [--profile <id>] [--host <id>] [--json]
bb browser grants [--profile <id>] [--host <id>] [--all] [--json]
bb browser grant --origin <scope> [--profile <id>] [--host <id>] [--file-transfer] [--json]
bb browser revoke --grant <id> [--json]
bb browser requests [--json]
bb browser request-status --request <id> [--json]
bb browser approve --request <id> [--one-hour] [--json]
bb browser deny --request <id> [--json]
```

`trust` creates a persistent whole-web Profile Grant for the current project and
profile; it is idempotent and reports the existing grant instead of stacking
duplicates. `grant` requires `--origin` and creates the same grant narrowed to
one Origin Scope. Grantable scopes are exact origins (`https://example.com`),
explicit subdomain patterns (`https://*.example.com`), or `*`. Paths are not
grantable.

`approve` persists by default and supplies the persistence confirmation for you;
`--one-hour` approves temporarily instead. `--request` is valid for
`request-status`, `approve`, and `deny`. `--grant` is valid only for `revoke`.
`--all` is valid only for `grants`.

The same decisions remain available in authenticated Browser Settings. Because
they are also on the CLI, anything that can run `bb` on this host can grant
itself the browser — see [security.md](security.md).

## Profiles

```text
bb browser list [--host <id>] [--json]
bb browser create --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]
bb browser rename --profile <id> --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]
bb browser select --profile <id> [--host <id>] [--json]
```

`--name` is valid for `create`, `rename`, and `import` only. `--locale` and
`--timezone` are valid for `create` and `rename` only.

## Profile recovery (owner operations)

```text
bb browser backup  --profile <id> --archive <path> [--host <id>] [--json]
bb browser restore --profile <id> --archive <path> [--host <id>] [--json]
bb browser import  --name <name> --source <path> [--host <id>] [--json]
```

`--archive` is valid for `backup` and `restore` only. `--source` is valid for
`import` only. These run a `validating → copying → promoting → completed`
pipeline and mark the archive `credentialEquivalent: true`. Best-effort restore
to the same host and BB installation; no cross-host restore.

## Profile lifecycle (owner operations)

```text
bb browser archive --profile <id> [--host <id>] [--json]
bb browser restore-archived --profile <id> [--host <id>] [--json]
bb browser reset --profile <id> --confirm <text> [--host <id>] [--json]
bb browser delete --profile <id> --confirm <name> [--host <id>] [--json]
```

- `archive` shows Archived Profile state; mutation requires owner Settings.
- `restore-archived` restores within 30 days through authenticated owner Settings.
- `reset` requires `--confirm <text>`; `delete` requires `--confirm <name>`
  (the profile's name). The current default profile cannot be removed until
  another default is selected.

## Setup, lifecycle, and purge

```text
bb browser setup [--step <id> --confirm <text>] [--json]
bb browser disable  --confirm "Stop Browser processes"
bb browser uninstall --confirm "Stop Browser processes"
bb browser purge [--confirm <text>] [--json]
```

- `setup` without `--step` shows the consent-gated plan; applying a step requires
  both `--step <id>` and `--confirm <text>`. Valid step ids: `dedicated-user`,
  `system-packages`, `protected-storage`.
- `disable` and `uninstall` require `--confirm` and retain profiles
  (`profilesRetained: true`).
- `purge` without `--confirm` shows the destructive plan; with `--confirm` it
  removes Browser-owned processes, browser data, configuration, and the
  `bb-browser` system user.

## File transfer

```text
bb browser transfer --kind workspace --environment <id> --path <relative-path> [--actor owner|agent] [--profile <id>] [--host <id>] [--transfer-id <id>] [--json]
bb browser transfer --kind client --file <local-path> [--transfer-id <id>] [--profile <id>] [--host <id>] [--json]
bb browser transfer --cancel --transfer-id <id> [--profile <id>] [--host <id>] [--json]
bb browser transfer --progress --transfer-id <id> [--profile <id>] [--host <id>] [--json]
```

Output is privacy-safe: transfer id, kind, size, and content type only. The
staged path and unrelated workspace paths are never printed. One-use staging is
removed after use, cancellation, failure, expiry, worker restart, or profile
lifecycle operations.

## Downloads

```text
bb browser downloads list [--profile <id>] [--host <id>] [--json]
bb browser downloads progress --download-id <id> [--profile <id>] [--host <id>] [--json]
bb browser downloads cancel --download-id <id> [--profile <id>] [--host <id>] [--json]
bb browser downloads export-client --download-id <id> [--actor owner|agent] [--profile <id>] [--host <id>] [--json]
bb browser downloads export-workspace --download-id <id> --environment <id> --path <relative-path> [--overwrite] [--actor owner|agent] [--profile <id>] [--host <id>] [--json]
bb browser downloads limits [--max-file-bytes <n>] [--max-profile-bytes <n>] [--expiry-ms <n>] [--profile <id>] [--host <id>] [--json]
bb browser downloads purge [--profile <id>] [--host <id>] [--json]
```

Downloads are untrusted quarantine objects: never auto-opened or executed.
`export-workspace` requires `--environment` and `--path`; `--overwrite` is
required to replace an existing workspace file. Agent exports require the
`file-transfer` grant.
