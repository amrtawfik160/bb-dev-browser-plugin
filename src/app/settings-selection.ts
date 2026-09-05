import { useSyncExternalStore } from "react";

/**
 * Which Browser Profile each settings section works on, per host. The BB app
 * mounts each registered settings section as its own slot, so a React
 * context cannot span them; a module-level store can, and it is tiny.
 */
const selections = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function selectProfileForHost(hostId: string, profileId: string) {
  if (selections.get(hostId) === profileId) return;
  selections.set(hostId, profileId);
  for (const listener of listeners) listener();
}

export function useSelectedProfile(hostId: string, fallback: string) {
  return useSyncExternalStore(
    subscribe,
    () => selections.get(hostId) ?? fallback,
    () => selections.get(hostId) ?? fallback,
  );
}
