# Safe Login Mode

**Safe Login Mode** is an owner-only browser mode for sign-in flows that reject
automation. Agents cannot inspect or control the browser while this mode is
active.

## When to use it

Use Safe Login when a site's sign-in flow rejects an automated browser (for
example, anti-bot heuristics or non-automatable challenges). Safe Login improves
compatibility, but the plugin **does not claim universal login compatibility**:
hardware-bound passkeys, DRM, and corporate device policies may still prevent a
login. See [limitations.md](limitations.md).

## Entering Safe Login

1. From the Browser Panel, choose to enter Safe Login Mode for the current
   profile.
2. The plugin warns about **unsaved transient state**, interrupts agents, and
   gracefully restarts Chrome.
3. The profile relaunches **without an automation attachment** using Xvfb,
   x11vnc, and noVNC for the interactive stream.

### What changes

- **Only the initiating panel** receives Safe Login pixels.
- **Other owner panels** show an opaque mode indicator (no pixels).
- **Agents** receive neither pixels nor DOM access; `browser_script` calls
  return a typed `safe_login_denied` error.
- Native browser UI is retained (unlike Automation Mode, which omits native
  context menus and DevTools in v1).

## Lease lifecycle

Lease constants are verified in `safe-login.ts`:

| Constant                       | Value                      |
| ------------------------------ | -------------------------- |
| `SAFE_LOGIN_LEASE_MS`          | 15 minutes                 |
| `SAFE_LOGIN_MAX_EXTENSION_MS`  | 15 minutes (one extension) |
| `SAFE_LOGIN_MAX_TOTAL_MS`      | 30 minutes (hard ceiling)  |
| `SAFE_LOGIN_EXPIRY_WARNING_MS` | 60 seconds before expiry   |

- A lease lasts **15 minutes** and warns before expiry.
- It may be **extended once** by one additional term; total lease time cannot
  exceed **30 minutes**.
- The lease exits to Automation Mode when you choose **Done**, the lease
  expires, or the final Safe Login panel closes.

## Exiting Safe Login

Choosing **Done**, lease expiry, or closing the final Safe Login panel
gracefully returns the same profile to **Automation Mode** (reattaching the
automation endpoint). Because the profile is unchanged, your authenticated
session in that profile is preserved.

## Security notes

- Safe Login is owner-only by construction; there is no agent opt-in.
- Entering the mode interrupts any active agent lease and revokes agent
  observation for the duration.
- The Safe Login stream is loopback-origin and BB Connect-gated like Automation
  Mode; Chrome and VNC bind to loopback and are never exposed directly.
- Activity Records record the mode transition (kind `mode`); they retain no
  credentials, keystrokes, or page contents.
