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
