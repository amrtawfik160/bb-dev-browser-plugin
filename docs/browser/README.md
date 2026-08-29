# Browser documentation

This is the handoff documentation for the **Browser** plugin (`bb-plugin-browser`
v0.1.0, MIT): a host-local Workspace Browser shared by a BB owner and
explicitly authorized agents across repositories on the same enrolled host.

The plugin is locally installed from its path in version one and is not
submitted to a marketplace. Everything below describes verified behavior from
the implemented tickets (#2–#21) plus the version-one limitations they record.
Where a behavior cannot yet be exercised in this environment it is stated as a
**limitation** with its evidence status rather than as a working feature.

## Audience map

| Document                                         | For                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [quickstart.md](quickstart.md)                   | Owners and agents — everyday use from both launch surfaces through recovery.                                                    |
| [operators.md](operators.md)                     | Host operators — supported hosts, BB Connect, setup, repair, retention, purge, backups, restores, imports, quotas, diagnostics. |
| [security.md](security.md)                       | Reviewers and security owners — trust boundaries, threat model, guarantees, and exclusions.                                     |
| [agent-reference.md](agent-reference.md)         | Agents and agent authors — `browser_script`, the BB browser CLI, the bundled skill, typed results, contention, and retry.       |
| [cli-reference.md](cli-reference.md)             | Everyone — the complete `bb browser` command surface with exact flags.                                                          |
| [safe-login.md](safe-login.md)                   | Owners — owner-only Safe Login Mode for sites that reject automation.                                                           |
| [architecture.md](architecture.md)               | Reviewers — runtime architecture, modes, transport, and ADR index.                                                              |
| [permissions.md](permissions.md)                 | Reviewers — host, OS-user, browser, network, and data permissions.                                                              |
| [troubleshooting.md](troubleshooting.md)         | Everyone — diagnosing states and recovery.                                                                                      |
| [limitations.md](limitations.md)                 | Everyone — explicit version-one limitations.                                                                                    |
| [third-party-notices.md](third-party-notices.md) | Reviewers and marketplace — exact pinned dependencies, engine, and licenses.                                                    |
| [verification-report.md](verification-report.md) | Reviewers — every parent requirement mapped to automated evidence, planned human acceptance, or an explicit limitation.         |

## Conventions

- **Glossary terms** follow [`CONTEXT.md`](../../CONTEXT.md). This documentation
  uses the defined terms (Browser Panel, Browser Profile, Profile Grant, Origin
  Scope, Control Lease, Safe Login Mode, Host Download, Transfer Staging,
  Activity Record, Restorable Session) rather than rejected synonyms.
- **CLI examples** are the exact flags accepted by the registered commands in
  [`server.ts`](../../server.ts). They were verified against the source; do not
  substitute alternative flag names (for example, `transfer` uses
  `--environment <id> --path <relative-path>`, not `--source`).
- **`--json`** is accepted wherever shown; without it, commands print
  human-readable text. The `browser_script` agent tool always returns structured
  results.
- **Evidence status** is recorded per claim in the
  [verification report](verification-report.md). Claims marked "automated" are
  exercised by a passing test in `test/`; claims marked "planned human
  acceptance" require the owner's authenticated BB Connect session; claims marked
  "limitation" are recorded in [limitations.md](limitations.md).

## Version-one scope

Version one supports Ubuntu and Debian on x86_64, requires BB Connect
enrollment even for a locally displayed panel, and runs the browser as a
dedicated unprivileged `bb-browser` user. It sends no analytics, telemetry, or
browser data to any external service; BB Connect is the only existing remote
authenticated transport. See [limitations.md](limitations.md) for the full list.
