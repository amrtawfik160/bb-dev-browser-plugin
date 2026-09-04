/**
 * Derive the owner session identity that a Browser Panel binds its Panel
 * Capability to from the BB app context, rather than a hardcoded literal.
 * The capability binds to one owner session, panel instance, host, and
 * profile; the owner session is the BB surface (thread or New thread
 * project) the panel is displayed in. It is stable for a given surface so a
 * reconnecting panel reclaims the same session, but distinct surfaces never
 * share a capability.
 */
export function ownerSessionIdFromContext(context: {
  projectId: string | null;
  threadId: string | null;
}): string {
  if (context.threadId !== null)
    return `bb-owner-session:thread:${context.threadId}`;
  if (context.projectId !== null)
    return `bb-owner-session:project:${context.projectId}`;
  return "bb-owner-session:compose";
}

export type TrustedOwnerSession =
  | { kind: "thread"; threadId: string; ownerSessionId: string }
  | { kind: "project"; projectId: string; ownerSessionId: string }
  | { kind: "compose"; ownerSessionId: string };

const THREAD_SESSION = /^bb-owner-session:thread:(.+)$/;
const PROJECT_SESSION = /^bb-owner-session:project:(.+)$/;

/**
 * Accept only owner-session identities production can issue from BB app
 * context. Anything else is a mismatch, not a value to replace with a fixture.
 */
export function parseOwnerSessionId(
  ownerSessionId: string,
): TrustedOwnerSession | null {
  if (ownerSessionId === "bb-owner-session:compose") {
    return { kind: "compose", ownerSessionId };
  }
  const thread = THREAD_SESSION.exec(ownerSessionId);
  if (thread?.[1]) {
    return {
      kind: "thread",
      threadId: thread[1],
      ownerSessionId,
    };
  }
  const project = PROJECT_SESSION.exec(ownerSessionId);
  if (project?.[1]) {
    return {
      kind: "project",
      projectId: project[1],
      ownerSessionId,
    };
  }
  return null;
}
