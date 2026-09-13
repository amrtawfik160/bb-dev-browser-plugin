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
