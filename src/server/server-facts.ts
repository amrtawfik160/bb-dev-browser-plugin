import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BrowserServerFacts } from "../shared/contracts.js";

const PLUGIN_PACKAGE_NAME = "bb-plugin-browser";
/** How long a host's copy counts as fresh before the server sends it again. */
const SERVER_FACTS_REFRESH_MS = 10_000;
const connectStatusSchema = z.object({ paired: z.boolean() });

/**
 * The plugin's install directory, found from the running server entry: the
 * nearest ancestor whose `package.json` is this plugin's.
 */
export function resolvePluginSourcePath(
  fromFileUrl: string = import.meta.url,
): string | null {
  let directory: string;
  try {
    directory = dirname(fileURLToPath(fromFileUrl));
  } catch {
    return null;
  }
  for (;;) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (manifest.name === PLUGIN_PACKAGE_NAME) return directory;
    } catch {
      // No readable manifest here; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function connectEnrolled(bb: BbPluginApi): Promise<boolean> {
  try {
    const status = await bb.sdk.plugins.callRpc({
      pluginId: "connect",
      method: "status",
      input: null,
      outputSchema: connectStatusSchema,
    });
    return status.paired;
  } catch {
    return false;
  }
}

/**
 * Keeps each host's copy of the server facts fresh, so the host never has to
 * open the server's database for them.
 */
export function createServerFactsSync(
  bb: BbPluginApi,
  send: (hostId: string, facts: BrowserServerFacts) => Promise<unknown>,
  options: { pluginSourcePath?: string | null; now?: () => number } = {},
) {
  const pluginSourcePath =
    options.pluginSourcePath === undefined
      ? resolvePluginSourcePath()
      : options.pluginSourcePath;
  const now = options.now ?? Date.now;
  const sentAt = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();

  async function deliver(hostId: string) {
    try {
      await send(hostId, {
        connectEnrolled: await connectEnrolled(bb),
        pluginSourcePath,
      });
      sentAt.set(hostId, now());
    } catch {
      // The host keeps its last copy; the next call tries again.
    }
  }

  return {
    /** Resolves once the host has fresh facts, or the attempt has failed. */
    ensure(hostId: string): Promise<void> {
      const last = sentAt.get(hostId);
      if (last !== undefined && now() - last < SERVER_FACTS_REFRESH_MS) {
        return Promise.resolve();
      }
      let delivery = pending.get(hostId);
      if (delivery === undefined) {
        delivery = deliver(hostId).finally(() => pending.delete(hostId));
        pending.set(hostId, delivery);
      }
      return delivery;
    },
  };
}
