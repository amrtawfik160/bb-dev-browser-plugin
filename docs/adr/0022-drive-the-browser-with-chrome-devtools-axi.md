# Drive the browser with chrome-devtools-axi

> Builds on [ADR 0021](0021-give-each-agent-session-its-own-tab-and-lane.md).
> Amends ADR 0004 and ADR 0015 for agent browsing through axi.

Agents should use the browser exactly the way chrome-devtools-axi works, with
no BB-specific dialect to learn. A hand-written imitation of axi's commands,
output, and refs drifts from axi and lacks its console, network, emulation,
performance, Lighthouse, and heap tools.

## Decision

Agents run chrome-devtools-axi itself.

- **One stable endpoint per agent session.** The runtime keeps one Session
  CDP Proxy per profile and lane for the life of the host worker. Each new
  connection wakes the Browser Instance and reaches whichever instance is
  running, so axi's bridge keeps one address across sleep and restarts.
  Commands keep the instance awake; idle sessions let it sleep.
- **axi, unchanged.** `bb plugin run browser axi <command…>` (and the
  `browser_axi` tool) run the plugin's bundled `chrome-devtools-axi` with
  `CHROME_DEVTOOLS_AXI_BROWSER_URL` set to the session's proxy,
  `CHROME_DEVTOOLS_AXI_SESSION` set to a per-thread name, and the bundled
  `chrome-devtools-mcp`, in the caller's working directory. Output is axi's
  own; its `chrome-devtools-axi …` hints are rewritten to the BB launcher so
  they stay runnable. Only `update` and `setup`, which would change the pinned
  install, are refused. axi state lives under the host data directory.
- **Selected tools.** Agents get `browser_axi` and `browser_sessions` by
  default. `browser_script` stays registered for opt-in multi-step
  Playwright work; the `script` CLI is unchanged.
- **Boundaries that stay.** The proxy shows each session only its own tabs
  and their popups, and refuses non-web navigation (`file:`, `chrome:`,
  `devtools:`, `view-source:`) plus uploads, drags, or download folders inside
  the browser's own profile storage. Profile grants, setup, host readiness,
  and Safe Login are checked before every axi command.

- **Bundled, not installed.** Both ship inside the plugin under
  `vendor/node_modules/`: axi and its libraries bundled into its CLI and
  bridge files, chrome-devtools-mcp as published (it has no runtime
  dependencies). `scripts/vendor-axi.mjs` rebuilds them for a version bump.
  Nothing is installed on the host and no global axi is used.

## Consequences

Agents get every axi feature, and its behaviour tracks the pinned axi version.

A project's access is all-or-nothing for axi browsing: exact-origin Origin
Scopes from ADR 0004 still bind `browser_script`, but axi navigation is not
checked per origin. Non-web pages remain blocked for both.

Each active agent session keeps one axi bridge, one chrome-devtools-mcp
process, and one loopback proxy while its host worker runs. The Browser Panel
picks up an axi session's tabs after each command.

Agent browsing through axi is not written to Activity Records per command;
grant decisions still are.
