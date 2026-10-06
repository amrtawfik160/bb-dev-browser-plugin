# Browser, a host-local Workspace Browser for BB

`bb-plugin-browser` v0.1.0. MIT.

It puts a real browser in BB's right panel, running on the enrolled host that
owns the repository. Cookies, site storage, and a Restorable Session live in a
named Browser Profile on that host. You watch and drive it from a streamed
Browser Panel. Agents get Playwright access to the whole web by default; the
grant that records it is visible and revocable in Browser Settings.

There is no public browser-control URL.

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
Opening it again focuses the panel already using that profile. A toolbar, one
scrolling tab strip, and the page below them, drawn in BB's own theme so it
follows light and dark. While an agent drives the browser the page carries an
amber frame and the agent's stated purpose; nothing else uses that colour.

**Browser Cards.** An agent can show the thread's browser inside its reply
with `::browser-live`: the profile, its state, the page it is on, and an
**Open in panel** button. When a site needs you to sign in, the agent ends its
reply with a Sign-in Handoff, `::browser-sign-in{origin="https://…"}`. Its
Open button opens the Browser Panel on that site so you sign in yourself. Click
**Done** to send a reply and save this profile for other agents to reuse on
the same host. Cards stream no pixels and never wake a sleeping browser.

**Reuse a login.** Agents use `browser_sessions` to find profiles by site and
select one for their thread. A Salesforce login can serve another agent on the
same host. Cookies stay in that profile; each thread gets a separate tab.
Sign-in confirmations show who checked and when. Agents verify authentication
before continuing because a session can expire. Existing profiles also show
origins from recent agent activity, which helps discovery without claiming a
login is current.

**Browser Settings.** Six sections under Browser in BB settings: **Browser**
(hosts and readiness), **Agent access** (grants and pending requests),
**Profiles**, **Downloads**, **Activity**, and **Maintenance** (setup,
backups, disable, uninstall, purge, diagnostics).

**Browser Profiles.** Named identities on one host. Reuse them across
repositories on that host. They never copy to another machine.

Each thread gets a separate default profile, so another agent cannot change
its page between calls. Calls without a thread use a project default. Tool,
CLI, and Browser Panel use the same selection. An explicit profile selection
opts into sharing; a project selection applies to its threads unless a thread
has its own selection. New profiles start with separate logins and cookies.

At most three Browser Instances run on a host. An idle profile sleeps after
five minutes; a fourth request can retire the least recently used idle instance.
Active scripts and visible panels prevent retirement. If all three are busy,
the request fails with `awake-limit`. Profiles retain at most 12 tabs, closing
the oldest inactive pages beyond that limit. These bounds reduce resource use;
they are not a fixed RAM quota. Sleeping profiles retain their data on disk. Archiving a thread puts its browser
to sleep; deleting a thread archives its unsaved browser profile, which stays
recoverable until it expires. Profiles saved by a confirmed sign-in survive
thread deletion until you archive or delete them in Browser Settings.

**Automation Mode.** You and granted agents share the stream and take turns
with input.

**Safe Login Mode.** For sites that reject automation. You sign in. Agents get
no pixels and no DOM until it ends.

**Profile Grants and Grant Requests.** A project's first agent call on a
profile records a whole-web grant automatically. Revoke it in authenticated
Browser Settings to put that project back on the request flow, where you grant
exact origins, subdomain patterns, or `*`, and a denied web origin raises a
Grant Request. A non-web navigation returns a typed error and does not raise a
request.

**Origin Scope.** Exact `scheme://host:port`, optional subdomain patterns.
Each agent session connects through its own Session CDP Proxy and sees only
its own tabs, so the owner's tabs are never read or touched (ADR 0021). Exact
`about:blank` is the safe internal page. Restored
Chrome new-tab / error documents are cleared to `about:blank` before agent
access.

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
bb plugin run browser setup
```

Until that finishes, the panel shows **Setup required**.

## Quick start

### Owner

Open **Browser** from a thread's right panel or the New thread launcher. Agent
access is on by default; review or revoke it under **Agent access** in
authenticated Browser Settings.

```text
bb plugin run browser status
bb plugin run browser list
bb plugin run browser create --name "Work"
bb plugin run browser select --profile <id>
```

Threads use separate default profiles; Browser Settings defaults to `bb-personal`.
Use **Safe Login** in the panel when a
site fights automation.

### Agent

Agents drive their own tabs with [chrome-devtools-axi](https://github.com/kunchenguid/chrome-devtools-axi),
unchanged and bundled inside the plugin (ADR 0022):

```bash
bb plugin run browser axi open https://example.com
bb plugin run browser axi click @g1:3
bb plugin run browser axi --help
```

It behaves exactly like `chrome-devtools-axi <command>` in your shell, against
this thread's own tabs; the `browser_axi` tool is the same for shell-less
agents. `browser_script` / `bb plugin run browser script` remain for opt-in
multi-step Playwright logic.
`page` is this thread's named tab from its first script call on every profile.
Saving or sharing the profile preserves that binding. Whatever you `return` is the result. Pass an exact origin
every time.

```text
bb plugin run browser script --purpose "Read the page title" \
  --origin https://example.com \
  --code "return await page.title()"
```

`origin_denied` means the owner revoked this project's access (a Grant Request
is attached) or the navigation is non-web (no request). There is no
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
bb plugin run browser transfer --kind workspace --environment <id> --path <relative-path>
bb plugin run browser transfer --kind client --file <local-path>
bb plugin run browser transfer --progress --transfer-id <id>
bb plugin run browser transfer --cancel --transfer-id <id>
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

That runs the authentication and empty-profile recovery integration tests
against real Chromium and QuickJS.

Inside a BB session, `BB_CLI` may override the locally installed CLI. To build
with this project's pinned BB and SDK versions, run
`env -u BB_CLI npm run build` before the release checks.

## Layout

```
src/app/         Browser Panel and Browser Settings UI
src/server/      Plugin registration, RPC, CLI, and dispatch to hosts
src/host/        Host entry, provisioning, profiles, downloads, and staging
src/browser/     Browser processes, automation, Origin Scope, and Control Leases
src/panel/       Shared panel sessions, gateways, streams, and transport
src/access/      Profile Grants, Default Access, and Grant Requests
src/activity/    Server Activity Records, host outbox, and reconciliation
src/shared/      Wire contracts, shared constants, and owner-session identity
docs/browser/    Owner, operator, agent, and security guides
docs/adr/        Architecture decisions
test/            Contract, evidence, and integration tests
scripts/         Release gate and owner wizards
skills/browser/  Bundled agent skill
CONTEXT.md       Domain glossary
```

The manifest points directly to the app, server, and host entries under `src/`.
Imports name the owning module directly. Activity persistence remains split:
`activity-records.ts` uses the server database, while `activity-outbox.ts` uses
host storage. `activity-sync.ts` reconciles them through typed host RPC and
commits expired-profile authority changes with event ingestion in one transaction.

`panel-session.ts` owns connection generations. Each joined connection exposes
activation, active-state inspection, disconnect, and transport binding; host
callers do not select generations or coordinate replacement cleanup.

## Security and privacy

Agents may drive any web origin by default. Each automation act still runs
under a Profile Grant bound to the BB project, recorded automatically on first
use and revocable in Browser Settings.

Agent browsing goes through chrome-devtools-axi on each thread's Session CDP
Proxy, which exposes only that thread's tabs; Playwright scripts are bounded
`browser_script` calls with typed results.

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
| [cli-reference.md](docs/browser/cli-reference.md)             | Complete plugin CLI flags            |
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
