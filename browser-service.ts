import type Database from "better-sqlite3";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  browserScriptParametersSchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatusInput,
} from "./contracts.js";
import { browserHostContract } from "./host-contract.js";

const migrations = [
  `CREATE TABLE browser_preferences (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    default_profile_id TEXT NOT NULL
  )`,
  `INSERT INTO browser_preferences (singleton, default_profile_id)
   VALUES (1, '${DEFAULT_PROFILE_ID}')`,
];

const profileRowSchema = z.object({ default_profile_id: z.string().min(1) });
type BrowserScriptParameters = z.output<typeof browserScriptParametersSchema>;
type BrowserIdentity = { projectId?: string; threadId?: string };

function defaultProfileId(database: Database.Database): string {
  const row = database
    .prepare(
      "SELECT default_profile_id FROM browser_preferences WHERE singleton = 1",
    )
    .get();
  return profileRowSchema.parse(row).default_profile_id;
}

async function projectHostId(bb: BbPluginApi, projectId: string) {
  const project = await bb.sdk.projects.get({ projectId });
  return (
    project.sources.find((source) => source.isDefault)?.hostId ??
    project.sources[0]?.hostId ??
    null
  );
}

async function threadHostId(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId === null) {
    return projectHostId(bb, thread.projectId);
  }
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  return environment.hostId;
}

async function resolvedHostId(bb: BbPluginApi, identity: BrowserIdentity) {
  if (identity.threadId !== undefined) {
    return threadHostId(bb, identity.threadId);
  }
  if (identity.projectId !== undefined) {
    return projectHostId(bb, identity.projectId);
  }
  return null;
}

export function panelIdentity(input: BrowserStatusInput): BrowserIdentity {
  return input.surface === "thread"
    ? { threadId: input.threadId }
    : { projectId: input.projectId ?? undefined };
}

export function createBrowserService(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, migrations);
  const host = bb.hosts.experimental_client({ contract: browserHostContract });

  async function status(
    identity: BrowserIdentity,
    profileId = defaultProfileId(database),
    signal?: AbortSignal,
  ) {
    const hostId = await resolvedHostId(bb, identity);
    if (hostId === null) return setupRequiredStatus({ hostId, profileId });
    return host.call("status", { hostId, profileId }, { hostId, signal });
  }

  async function browserScript(
    parameters: BrowserScriptParameters,
    context: PluginAgentToolContext,
  ) {
    const profileId = parameters.profileId ?? defaultProfileId(database);
    const hostId = await resolvedHostId(bb, context);
    if (hostId === null) {
      return {
        ok: false as const,
        error: setupRequiredStatus({ hostId, profileId }),
      };
    }
    return host.call(
      "browserScript",
      {
        purpose: parameters.purpose,
        code: parameters.code,
        profileId,
        ...(parameters.tabId === undefined ? {} : { tabId: parameters.tabId }),
        timeoutMs: parameters.timeoutMs,
        hostId,
        projectId: context.projectId,
        threadId: context.threadId,
      },
      { hostId, signal: context.signal },
    );
  }

  return { browserScript, status };
}

export type BrowserService = ReturnType<typeof createBrowserService>;
