# Third-party notices

Exact pinned dependencies, browser engine, display helpers, and redistributable
assets for **`bb-plugin-browser`** v0.1.0.

## Plugin license

The plugin is licensed under the **MIT License**
(`Copyright (c) 2026 bb-plugin-browser contributors`), see
[`LICENSE`](../../LICENSE).

## Runtime dependencies

Pinned in `package.json` and surfaced by `dependencyInventory()` in
[`dependency-inventory.ts`](../../dependency-inventory.ts):

| Package              | Pinned version | Role                                                                                            |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `bb-plugin-browser`  | `0.1.0`        | This plugin.                                                                                    |
| `@get-bb/plugin-sdk` | `0.4.21`       | BB plugin backend/frontend SDK. Engine requires `bb >= 0.40` and `bbPluginSdk >= 0.4.21`.       |
| `dev-browser`        | `0.2.9`        | Attaches to the plugin-owned Automation Mode endpoint; provides the QuickJS Playwright sandbox. |
| `playwright`         | `1.58.2`       | Browser automation library behind `dev-browser` and the fallback browser.                       |

Additional runtime dependencies pinned in `package.json`:

| Package | Pinned version | Role                                  |
| ------- | -------------- | ------------------------------------- |
| `ws`    | `8.21.3`       | Loopback WebSocket gateway transport. |
| `zod`   | `4.3.6`        | Contract schema validation.           |

## Browser engine

Pinned in `dependency-inventory.ts` (`PINNED_BROWSER_RUNTIME`):

| Property           | Value          |
| ------------------ | -------------- |
| Playwright version | `1.58.2`       |
| Chromium revision  | `1208`         |
| Chromium version   | `145.0.7632.6` |

- **Official Chrome Stable** is the primary browser (updates through its signed
  system repository).
- A compatible pinned **Playwright Chromium** (revision `1208`,
  `145.0.7632.6`) is the fallback for ordinary browsing.
- The plugin never silently upgrades system packages; health checks report
  incompatible drift.

## Display helpers (Safe Login Mode)

Safe Login Mode relaunches the profile without an automation attachment and uses:

- **Xvfb** — virtual X display.
- **x11vnc** — VNC server attached to the Xvfb display.
- **noVNC** — VNC client in the browser stream.

These run as the dedicated unprivileged `bb-browser` user and bind to loopback
only; they are never exposed directly. They are installed through the
`system-packages` setup step with explicit owner confirmation.

## Redistributable assets

- The plugin ships a **bundled skill** at [`skills/browser/SKILL.md`](../../skills/browser/SKILL.md)
  and a **Globe** branding glyph registered for both panel actions and the
  `browser_script` tool. No third-party iconography or fonts are redistributed.
- Frontend chrome uses **BB components, typography, spacing, and light/dark
  themes** rather than custom visual branding.
- No browser binaries are redistributed with the plugin; Chrome Stable is
  installed from its signed system repository, and the pinned Playwright
  Chromium is fetched through the `playwright` package's own install path.

## Development dependencies (not redistributed)

These are `devDependencies` used for build, test, and type-checking only and are
not shipped to runtime: `typescript`, `eslint`, `typescript-eslint`,
`prettier`, `vitest`, `@testing-library/react`, `jsdom`, `react`/`react-dom`
(types), `@radix-ui/*` primitives, `better-sqlite3`, `hono`, `vaul`, `sonner`,
`tailwind-merge`, `class-variance-authority`, `clsx`, `bb-app`, `cron-parser`,
`@pierre/diffs`, and associated `@types/*`.

## Notice

This document records the exact pinned versions verified against
`package.json`, `package-lock.json`, and `dependency-inventory.ts` at the
`0.1.0` release. License texts for each dependency ship with the respective
package; the plugin itself is MIT-licensed.
