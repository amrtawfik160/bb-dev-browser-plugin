/**
 * User-facing Safe Login notices shared by the node-side policy machine and the
 * browser panel UI. This module is browser-safe: it imports nothing from Node,
 * so the panel bundle never pulls `node:crypto` or the activity-record store in
 * through the policy module.
 */

/** Warned before entering Safe Login about the cost of restarting the profile. */
export const SAFE_LOGIN_TRANSIENT_STATE_WARNING =
  "Entering Safe Login will restart this Browser Profile. Unsaved form input, transient tab state, and in-flight agent work will be lost; saved logins and tabs are preserved.";

/**
 * Stated wherever Safe Login is active so the owner knows compatibility is not
 * universal: hardware-bound passkeys, DRM, corporate device policy, and
 * site-specific anti-automation behavior may still prevent a login.
 */
export const SAFE_LOGIN_LIMITATIONS_NOTICE =
  "Safe Login improves compatibility with sites that reject automation, but hardware-bound passkeys, DRM content, corporate device policies, and site-specific anti-automation behavior may still prevent a login.";
