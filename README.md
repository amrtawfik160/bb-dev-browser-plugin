# Browser — a host-local Workspace Browser for BB

`bb-plugin-browser` (v0.1.0, MIT) is a BB plugin that puts an interactive
browser in BB's right panel. The browser runs on the enrolled host that owns
the repository, backed by a named **Browser Profile** whose cookies, site
storage, and Restorable Session persist locally across repositories and
restarts. The owner sees and controls the browser through a streamed panel;
agents with a matching **Profile Grant** can run bounded Playwright automation
through the same browser. Authenticated browser state is treated as sensitive
host-local data — raw browser-control endpoints are never exposed, and agents
are denied by default.

> **Status:** version one. Implemented and reviewed across tickets #2–#25.
> Supports Ubuntu and Debian on x86_64, requires BB Connect enrollment even for
> a locally displayed panel, and runs the browser as a dedicated unprivileged
> `bb-browser` user. Sends no analytics or telemetry. See
> [Limitations](#limitations).

---

## Why

BB owners currently leave BB to use an interactive browser. That separates the
human login session from the agent's automation, makes repository-local apps
awkward to reach, and prevents the owner and authorized agents from sharing the
same authenticated browsing state. This plugin keeps the browser on the
repository's enrolled host, lets the owner personally enter credentials, and
exposes automation to agents only through explicit, revocable authorization.

## Features

- **Browser Panel** on two launch surfaces — existing threads and the New
  thread launcher. Repeated actions focus the existing panel tab for that
  profile.
- **Browser Profiles** — named, host-local identities reused across
  repositories on the same host, never synchronized to another host. Create,
  rename, select, archive, reset, delete, import, back up, and restore.
- **Automation Mode** — the owner and authorized agents share observation and
  control through a streamed panel.
- **Safe Login Mode** — owner-only mode for sign-in flows that reject
  automation. Relaunches the same profile without an automation attachment;
  agents get neither pixels nor DOM access while it is active.
- **Profile Grants & Grant Requests** — agents are denied by default. An owner
  grants exact origins, subdomain scopes, or whole-web access in authenticated
  Browser Settings. Denied web origins produce a typed result and a non-blocking
  Grant Request the owner can approve for one retry, one hour, or persistent
  access; non-web navigation is denied without a request.
- **Origin Scope enforcement** — exact `scheme://host:port` origins and
  optional subdomain patterns. The host route matches web grants, the pinned
  Playwright boundary rejects direct non-web `Frame.goto` calls before they
  reach Chromium, and the CDP guard fails closed for renderer, popup, and
  frame navigations. Denied pages are removed and denial remains sticky even
  when a script navigates back or throws. Exact `about:blank` is the only safe
  internal exception.
- **Control Leases** — one owner client or agent controls input at a time. The
  owner has priority and can revoke an agent's lease; control transfers
  explicitly between owner clients.
- **Shared Browser Tabs** — one shared active tab and ordered tab set per
  profile, observed by every panel using that profile.
- **Clipboard** — explicit, owner-initiated text copy/paste only; never
  continuous sync. Outcomes report byte counts, never contents.
- **Uploads via Transfer Staging** — one-use host storage that brokers a file
  between a client or workspace and the browser without giving browser
  processes repository access. Traversal, symlink escape, and special files
  fail closed.
- **Host Downloads** — quarantined files retained on the host, never opened or
  executed automatically. Per-file and per-profile quotas, expiry, and explicit
  export to client or workspace.
- **Activity Records** — metadata-only audit entries (actor, project, origin,
  timing, outcome). Never scripts, passwords, keystrokes, page contents, or
  screenshots. Expire after 30 days or 10,000 entries per profile.
- **Restorable Session & recovery** — durable auth, storage, and open-tab
  locations restore after a restart; transient form state is best-effort.
  Instances sleep after inactivity and wake lazily after restarts.

## Requirements

- **Host:** Ubuntu or Debian on x86_64.
- **BB:** `>=0.40` with the plugin SDK `>=0.4.21`.
- **BB Connect** enrollment, even for a locally displayed panel.
- A dedicated unprivileged `bb-browser` OS user is created during setup.
- At least **5 GiB** host free space for new instances and downloads.

## Install

Version one is installed locally from its path (not from a marketplace). From
the repository root:

```bash
npm install
npm run build          # produces dist/ (host.js, app.css, and metadata)
```

Then install the plugin into BB from this path, and on first use run the
consent-gated setup (`bb browser setup`) which provisions the `bb-browser`
user and browser binaries. The panel reports **Setup required** until the host
is healthy.

## Quick start

### Owner

Open the **Browser** action from any thread's right panel or the New thread
launcher. Use the authenticated Browser Settings surface to manage grants.
Read host state from a terminal:

```text
bb browser status                            # host, instance, lease, and mode state
bb browser list                              # host-local profiles
```

The default profile is `bb-personal`. Manage grants only from authenticated
Browser Settings. Profile and host operations remain available on the CLI:

```text
bb browser list                              # list host-local profiles
bb browser create --name "Work"              # create a profile
bb browser select --profile <id>             # set the selected profile
bb browser status [--json]                   # host, instance, lease, and mode state
bb browser setup                             # consent-gated host provisioning
```

For sign-in flows that reject automation, choose **Safe Login** in the panel.
The plugin warns about unsaved state, interrupts agents, and relaunches the
profile without an automation attachment for up to 30 minutes.

### Agent

Agents are denied by default until the owner grants an origin in authenticated
Browser Settings. An agent then drives the browser through `browser_script` or
`bb browser script`. `page` is the active tab; `return` values become the
result. Always pass an exact origin:

```text
bb browser script --purpose "Read the page title" \
  --origin https://example.com \
  --code "return await page.title()"
```

A denied web origin returns a typed `origin_denied` result and raises a Grant
Request the owner can approve. Non-web navigation returns the same typed error
without a request. There is no `document` global.

See the bundled skill at [`skills/browser/SKILL.md`](skills/browser/SKILL.md)
and the [agent reference](docs/browser/agent-reference.md) for the full
contract, typed results, contention, and retry behavior.

## CLI surface

The complete `bb browser` command surface — profiles, safe request reads,
transfers, downloads, activity, diagnostics, and status — is documented with
exact flags in [`docs/browser/cli-reference.md`](docs/browser/cli-reference.md).
Most commands accept `--json` for structured output.

## Project structure

```
server.ts            Plugin entry: RPC registration + bb browser CLI
host.ts              Host runtime: browser lifecycle, RPC handlers, leases
app.tsx              Frontend: Browser Panel, dialogs, downloads, settings
contracts.ts        Zod schemas and RPC contracts for every surface
browser-runtime.ts  Workspace Browser runtime and operation options
browser-process.ts   Browser process management and DevTools transport
browser-screencast.ts CDP-backed screencast source for the panel stream
panel-transport.ts   WebSocket loopback gateway driving the screencast
panel-control-state.ts Multi-client controller/spectator coordination
panel-gateway.ts     Per-owner panel gateway and stream multiplexing
authorization.ts      Profile Grants, Origin Scope, and Grant Requests
grant-requests.ts    Grant Request lifecycle and owner approvals
control-lease.ts     Exclusive input lease for owner or agent
safe-login.ts        Owner-only Safe Login Mode policy
origin-scope.ts      Host-owned Origin Scope navigation guard
transfer-staging.ts  One-use host storage brokering file transfers
host-downloads.ts    Profile-scoped download quarantine and export
activity-records.ts  Metadata-only audit entries
profile-storage.ts   Browser Profile storage, backup, restore, import
profile-recovery.ts  Profile lifecycle recovery
readiness.ts         Host readiness capabilities (disk, identity, browser)
docs/browser/        Handoff documentation (16 guides)
test/                58 test files: contract, evidence, integration, release
scripts/             release-gate.sh + owner wizards
skills/browser/      Bundled agent skill
```

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm run format:check  # prettier --check .   (npm run format to write)
npm run build         # bb plugin build  -> dist/
npm test              # vitest run  (deterministic suite)
npm run release-gate  # scripts/release-gate.sh: typecheck, lint, format, build, test
```

### Testing discipline

The deterministic suite (`npm test`) is the release gate and must pass with no
failures and no non-deterministic skips. Tests that need a real provisioned
browser are gated behind `it.runIf(integrationEnabled)` and a module-load
throw under `BB_BROWSER_REAL_INTEGRATION_REQUIRED=1`, so they skip
deterministically in CI and only run when a host is actually provisioned:

```bash
npm run test:real-browser   # opts into real-browser integration tests
```

Evidence suites live under `test/` (contract, evidence, boundary, release, and
host-acceptance tests). The non-vacuous-scan convention requires privacy scans
to drive the same retained surfaces the real flow produces, not a self-built
fixture.

## Security and privacy

- Agents are **denied by default**; every automation act requires a Profile
  Grant bound to the exact BB project identifier.
- Raw browser-control endpoints are never exposed; automation goes through
  bounded `browser_script` invocations with typed results.
- The browser runs as a dedicated unprivileged `bb-browser` user and never
  receives repository access. Workspace file transfers resolve through
  BB's environment APIs and one-use Transfer Staging that is removed after use.
- Safe Login Mode gives agents neither pixels nor DOM access.
- Activity Records are metadata-only and never retain sensitive input or
  ordinary owner browsing.
- No analytics, telemetry, or browser data leaves the host; BB Connect is the
  only remote authenticated transport.

The trust boundaries, threat model, guarantees, and exclusions are in
[`docs/browser/security.md`](docs/browser/security.md).

## Documentation

The full handoff documentation lives in [`docs/browser/`](docs/browser/):

| Guide                                                         | For                                               |
| ------------------------------------------------------------- | ------------------------------------------------- |
| [quickstart.md](docs/browser/quickstart.md)                   | Everyday use for owners and agents                |
| [operators.md](docs/browser/operators.md)                     | Host operators: setup, repair, retention, backups |
| [security.md](docs/browser/security.md)                       | Reviewers: trust boundaries and threat model      |
| [agent-reference.md](docs/browser/agent-reference.md)         | Agents: `browser_script`, CLI, typed results      |
| [cli-reference.md](docs/browser/cli-reference.md)             | Complete `bb browser` command surface             |
| [safe-login.md](docs/browser/safe-login.md)                   | Owner-only Safe Login Mode                        |
| [architecture.md](docs/browser/architecture.md)               | Runtime architecture and ADR index                |
| [permissions.md](docs/browser/permissions.md)                 | Host, OS-user, browser, network, data permissions |
| [troubleshooting.md](docs/browser/troubleshooting.md)         | Diagnosing states and recovery                    |
| [limitations.md](docs/browser/limitations.md)                 | Explicit version-one limitations                  |
| [verification-report.md](docs/browser/verification-report.md) | Each requirement mapped to evidence               |
| [third-party-notices.md](docs/browser/third-party-notices.md) | Pinned dependencies and licenses                  |

Glossary terms (Browser Panel, Browser Profile, Profile Grant, Origin Scope,
Control Lease, Safe Login Mode, Host Download, Transfer Staging, Activity
Record, Restorable Session) are defined in [`CONTEXT.md`](CONTEXT.md).

## Limitations

Version one supports Ubuntu and Debian on x86_64 only. BB Connect enrollment is
required even for a locally displayed panel. Automation Mode omits native
Chrome context menus and DevTools. Transient form state and exact navigation
history are best-effort across restarts. Clipboard is text-only with a 4 MiB
cap. See [`docs/browser/limitations.md`](docs/browser/limitations.md) for the
full list and the evidence behind each claim.

Two tickets (#24 host provisioning, #25 third-party login smoke test) are
`ready-for-human`: the agent-doable preparation (runbooks, gated suites,
wizards) is complete and merged, but the final privileged steps — provisioning
the host and personally entering credentials — are performed by the owner via
`scripts/host-provisioning-wizard.sh` and
`scripts/third-party-login-wizard.sh`.

## License

MIT — see [`LICENSE`](LICENSE). Third-party notices and pinned dependency
licenses are in [`docs/browser/third-party-notices.md`](docs/browser/third-party-notices.md).
