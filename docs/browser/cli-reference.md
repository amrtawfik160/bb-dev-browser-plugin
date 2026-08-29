# `bb browser` CLI reference

Every command below is the exact surface registered in `server.ts` and was
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
bb browser script --purpose <text> --code <source> \
  [--profile <id>] [--tab <id>] [--origin <origin>] [--timeout <ms>] \
  [--screenshot] [--file-transfer] [--invalid-certificate] [--json]
```

`--purpose` and `--code` are required. `--timeout` must be an integer from 1 to 30000. `--host` and `--confirm` are invalid for `script`. See
[agent-reference.md](agent-reference.md) for typed results.

## Activity records

```text
bb browser activity [--profile <id>] [--host <id>] [--json]
bb browser activity-export [--profile <id>] [--host <id>] [--json]
bb browser activity-clear [--profile <id>] --confirm "Clear Browser activity records" [--json]
```

`activity-clear` requires the literal confirmation text shown above.

## Grant requests

```text
bb browser requests [--json]
bb browser request-status --request <id> [--json]
```

Grant approval itself happens in authenticated Browser Settings; the CLI exposes
inspection only. `--request` is only valid for `request-status`.

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
