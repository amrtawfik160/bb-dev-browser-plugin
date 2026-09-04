# Browser, a host-local Workspace Browser for BB

`bb-plugin-browser` v0.1.0. MIT.

It puts a real browser in BB's right panel, running on the enrolled host that
owns the repository. Cookies, site storage, and a Restorable Session live in a
named Browser Profile on that host. You watch and drive it from a streamed
Browser Panel. Agents only get Playwright access after you grant them a
Profile Grant.

Agents start with nothing. There is no public browser-control URL.

Version 0.1.0 runs on Ubuntu and Debian x86_64. It needs BB Connect even if
you are sitting at the same machine. The browser process runs as a dedicated
unprivileged `bb-browser` user. Nothing is sent off-host for analytics. See
[Limitations](#limitations).

## Why

Leaving BB to log in somewhere else splits your session from the agent's. This
plugin keeps the login on the repository host, so you type passwords yourself
and agents only act where you said they could.

## What it does

**Browser Panel.** Opens from an existing thread or the New thread launcher.
Opening it again focuses the panel already using that profile.

**Browser Profiles.** Named identities on one host. Reuse them across
repositories on that host. They never copy to another machine.

**Automation Mode.** You and granted agents share the stream and take turns
with input.

**Safe Login Mode.** For sites that reject automation. You sign in. Agents get
no pixels and no DOM until it ends.

**Profile Grants and Grant Requests.** You grant exact origins, subdomain
patterns, or `*` in authenticated Browser Settings. A denied web origin
returns a typed error and can raise a Grant Request. A non-web navigation
returns the same typed error and does not raise a request.

**Origin Scope.** Exact `scheme://host:port`, optional subdomain patterns.
Denied pages are removed. Exact `about:blank` is the safe internal page. Restored Chrome new-tab / error documents are cleared to `about:blank` before agent access.

**Control Lease.** One owner client or one agent sends input at a time. You
can take it back.

**Shared Browser Tabs.** Every panel on a profile sees the same ordered tabs
and the same active tab.

**Clipboard.** You copy or paste text on purpose. The reply reports how many
bytes moved, not the text. Cap is 4 MiB.

**Uploads.** Transfer Staging holds one file once, then deletes it. The
browser user never gets the repository.

**Host Downloads.** Files land in a quarantine on the host. Nothing opens or
runs them for you.

**Activity Records.** Metadata only. No scripts, passwords, keystrokes, page
contents, or screenshots.

**Restorable Session.** Auth, storage, and open-tab locations come back after
a restart. Form fields and exact history may not.

## Requirements

- Ubuntu or Debian on x86_64
- BB `>=0.40` and plugin SDK `>=0.4.21`
- BB Connect enrollment
- The `bb-browser` OS user, created during setup
- At least 5 GiB free on the host for new instances and downloads

## Install

Version 0.1.0 installs from this path, not a marketplace.

```bash
npm install
npm run build
bb plugin install path:. --yes
```

Then provision the OS user and browser binaries:

```text
bb browser setup
```

Until that finishes, the panel shows **Setup required**.

## Quick start

### Owner

Open **Browser** from a thread's right panel or the New thread launcher. Grant
origins only in authenticated Browser Settings.

```text
bb browser status
bb browser list
bb browser create --name "Work"
bb browser select --profile <id>
```

The default profile is `bb-personal`. Use **Safe Login** in the panel when a
site fights automation.

### Agent

Do not drive anything until the owner grants an origin in Browser Settings.
Then use `browser_script` or `bb browser script`. `page` is the active tab.
Whatever you `return` is the result. Pass an exact origin every time.

```text
bb browser script --purpose "Read the page title" \
  --origin https://example.com \
  --code "return await page.title()"
```

A denied web origin returns `origin_denied` and may raise a Grant Request. A
non-web navigation returns `origin_denied` and does not. There is no
`document` global.

Typed results, contention, and retry live in
[`skills/browser/SKILL.md`](skills/browser/SKILL.md) and
[agent-reference.md](docs/browser/agent-reference.md).

The names `trust`, `untrust`, `grants`, `grant`, `revoke`, `approve`, and
`deny` always fail and tell you to use Browser Settings. A shell is not an
owner session.

## CLI

Full flags are in
[`docs/browser/cli-reference.md`](docs/browser/cli-reference.md). Most
commands accept `--json`.

Workspace files stage through a BB environment id, not a raw host path:

```text
bb browser transfer --kind workspace --environment <id> --path <relative-path>
bb browser transfer --kind client --file <local-path>
bb browser transfer --progress --transfer-id <id>
bb browser transfer --cancel --transfer-id <id>
```

## Development

```bash
npm run typecheck
npm run lint
npm run format:check    # npm run format to write
npm run build           # bb plugin build → dist/
npm test                # vitest run
npm run release-gate    # typecheck, lint, format, build, test
```

`npm test` is the deterministic suite. Tests that need a provisioned browser
use `it.runIf(integrationEnabled)` and throw at module load if
`BB_BROWSER_REAL_INTEGRATION_REQUIRED=1` is set without
`BB_BROWSER_REAL_INTEGRATION=1`.

```bash
npm run test:real-browser
```

That runs `test/browser-auth.integration.test.ts` only.

## Layout

```
app.tsx, panel-*.ts(x)   Browser Panel UI, protocol, and shared session
host.ts                  Workspace-host browser runtime
server.ts                Plugin RPC and bb browser CLI
docs/browser/            Owner, operator, agent, and security guides
docs/adr/                Architecture decisions
test/                    Contract, evidence, and integration tests
scripts/                 release-gate.sh and owner wizards
skills/browser/          Bundled agent skill
CONTEXT.md               Glossary
```

## Security and privacy

Agents are denied by default. Each automation act needs a Profile Grant bound
to the BB project.

Automation goes through bounded `browser_script` calls with typed results.

The browser runs as `bb-browser` and never gets the repository. Workspace
files go through Transfer Staging and are deleted after use.

Safe Login Mode gives agents no pixels and no DOM.

Activity Records keep metadata only.

No analytics, telemetry, or browser data leave the host. BB Connect is the
only remote authenticated path.

Threat model: [`docs/browser/security.md`](docs/browser/security.md).

## Documentation

| Guide                                                         | For                                  |
| ------------------------------------------------------------- | ------------------------------------ |
| [quickstart.md](docs/browser/quickstart.md)                   | Everyday use                         |
| [operators.md](docs/browser/operators.md)                     | Setup, repair, retention, backups    |
| [security.md](docs/browser/security.md)                       | Trust boundaries and threat model    |
| [agent-reference.md](docs/browser/agent-reference.md)         | `browser_script`, CLI, typed results |
| [cli-reference.md](docs/browser/cli-reference.md)             | Complete `bb browser` flags          |
| [safe-login.md](docs/browser/safe-login.md)                   | Owner-only Safe Login Mode           |
| [architecture.md](docs/browser/architecture.md)               | Runtime and ADR index                |
| [permissions.md](docs/browser/permissions.md)                 | Host, OS-user, and data permissions  |
| [troubleshooting.md](docs/browser/troubleshooting.md)         | Diagnosing states                    |
| [limitations.md](docs/browser/limitations.md)                 | Version-one limitations              |
| [verification-report.md](docs/browser/verification-report.md) | Requirements mapped to evidence      |
| [third-party-notices.md](docs/browser/third-party-notices.md) | Pinned dependencies and licenses     |

Glossary: [`CONTEXT.md`](CONTEXT.md).

## Limitations

Version 0.1.0 is Ubuntu and Debian on x86_64 only. BB Connect is required even
for a panel on this machine. Automation Mode has no native Chrome context
menus or DevTools. Form fields and exact history may not survive a restart.
Clipboard is text-only, 4 MiB. Details:
[`docs/browser/limitations.md`](docs/browser/limitations.md).

You still run host provisioning and third-party login smoke tests yourself:
`scripts/host-provisioning-wizard.sh` and
`scripts/third-party-login-wizard.sh`.

## License

MIT. See [`LICENSE`](LICENSE). Third-party notices:
[`docs/browser/third-party-notices.md`](docs/browser/third-party-notices.md).
