import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  PANEL_AUTH_ROTATION_MS,
  PANEL_RECLAIM_WINDOW_MS,
} from "./contracts.js";

const shareSchema = z.object({
  hostId: z.string(),
  port: z.number().int(),
  url: z.string().url(),
});
const removalSchema = z.object({ removed: z.boolean() });
type PanelTarget = {
  hostId: string;
  profileId: string;
  panelId: string;
  ownerSessionId: string;
};

export function createPanelPortSharing(bb: BbPluginApi) {
  const shares = new Map<
    string,
    { target: PanelTarget; port: number; timer: ReturnType<typeof setTimeout> }
  >();

  async function remove(key: string) {
    const share = shares.get(key);
    if (share === undefined) return;
    await bb.sdk.plugins.callRpc({
      pluginId: "connect",
      method: "unexpose",
      input: { hostId: share.target.hostId, port: share.port },
      outputSchema: removalSchema,
    });
    clearTimeout(share.timer);
    shares.delete(key);
  }

  bb.onDispose(async () => {
    for (const share of shares.values()) clearTimeout(share.timer);
    await Promise.allSettled([...shares.keys()].map(remove));
  });

  return {
    async expose(target: PanelTarget, port: number) {
      // Connect selects the server's existing tunnel or the enrolled remote machine.
      const share = await bb.sdk.plugins.callRpc({
        pluginId: "connect",
        method: "expose",
        input: { hostId: target.hostId, port },
        outputSchema: shareSchema,
      });
      const key = JSON.stringify([target.hostId, port]);
      const previous = shares.get(key);
      if (previous !== undefined) clearTimeout(previous.timer);
      const timer = setTimeout(() => {
        void remove(key).catch(() =>
          bb.log.warn("Could not retire an expired Browser Panel port share."),
        );
      }, PANEL_AUTH_ROTATION_MS + PANEL_RECLAIM_WINDOW_MS);
      timer.unref?.();
      shares.set(key, { target, port, timer });
      const url = new URL(share.url);
      const separator = `--${port}.`;
      const index = url.hostname.indexOf(separator);
      if (
        share.hostId !== target.hostId ||
        share.port !== port ||
        url.protocol !== "https:" ||
        index <= 0 ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        await remove(key);
        throw new Error(
          "BB Connect did not return an authenticated Browser Panel share URL.",
        );
      }
      return {
        label: url.hostname.slice(0, index),
        baseDomain: url.hostname.slice(index + separator.length),
      };
    },
    async release(target: PanelTarget) {
      await Promise.all(
        [...shares]
          .filter(
            ([, share]) =>
              share.target.hostId === target.hostId &&
              share.target.profileId === target.profileId &&
              share.target.panelId === target.panelId &&
              share.target.ownerSessionId === target.ownerSessionId,
          )
          .map(([key]) => remove(key)),
      );
    },
  };
}
