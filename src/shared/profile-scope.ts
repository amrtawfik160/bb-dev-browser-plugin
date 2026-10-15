import { createHash } from "node:crypto";

export type BrowserProfileScope = { projectId: string; threadId?: string };

export function profileScopeKey(scope: BrowserProfileScope): string {
  return JSON.stringify([scope.projectId, scope.threadId ?? null]);
}

export function scopedProfileId(scope: BrowserProfileScope): string {
  const hash = createHash("sha256")
    .update(profileScopeKey(scope))
    .digest("hex");
  return `bb-${scope.threadId === undefined ? "project" : "thread"}-${hash.slice(0, 32)}`;
}

const THREAD_PROFILE_PREFIX = "bb-thread-";

/** A thread's default profile, created for a worker thread on first use. */
export function isThreadProfileId(profileId: string): boolean {
  return profileId.startsWith(THREAD_PROFILE_PREFIX);
}

/**
 * The name a thread's default profile is created with. Any other name was
 * given by the owner.
 */
export function threadProfileDefaultName(profileId: string): string {
  return `Thread ${profileId.slice(THREAD_PROFILE_PREFIX.length)}`;
}
