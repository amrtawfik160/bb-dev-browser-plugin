import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { join } from "node:path";
import {
  createActivityOutbox,
  type ActivityOutbox,
} from "./activity-outbox.js";
import { browserHostContract } from "./host-contract.js";
import {
  createBrowserUserProfileOwnershipBoundary,
  createFileBrowserProfileStore,
  type BrowserProfileStore,
} from "./profile-storage.js";
import {
  createFileHostAdministrationStateStore,
  createReadOnlyHostAdministrationBoundary,
  type HostAdministrationBoundary,
} from "./host-operations.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  hostInstallationId,
  type HostReadinessBoundary,
} from "./readiness.js";
import {
  BROWSER_STORAGE_ROOT,
  DEFAULT_PROFILE_ID,
  browserProfileUnavailableStatus,
  type BrowserActivityEvent,
  type BrowserScriptRequest,
  type BrowserScriptResponse,
} from "./contracts.js";

export type HostSetupBoundary = HostReadinessBoundary;
type HostBoundary = HostReadinessBoundary | HostAdministrationBoundary;
type HostBoundarySource = HostBoundary | ((dataDir: string) => HostBoundary);
type ProfileStoreSource =
  BrowserProfileStore | ((dataDir: string) => BrowserProfileStore);

type ScriptSignalContext = { signal: AbortSignal };
type ScriptActivityOutcome = "succeeded" | "failed";

function isAdministrationBoundary(
  boundary: HostBoundary,
): boundary is HostAdministrationBoundary {
  return "setupPlan" in boundary;
}

async function requireReadyForProfileMutation(
  boundary: HostAdministrationBoundary,
  target: { hostId: string; profileId: string },
) {
  const status = await boundary.inspect(target);
  if (status.state !== "healthy") throw new Error(status.message);
}

function scriptActivityEvent(
  request: BrowserScriptRequest,
  context: ScriptSignalContext,
  outcome: ScriptActivityOutcome,
  startedAt: number,
): BrowserActivityEvent {
  const interrupted = context.signal.aborted;
  return {
    eventId: request.activityEventId,
    actor: "agent",
    projectId: request.projectId,
    hostId: request.hostId,
    profileId: request.profileId,
    destinationOrigin: request.destinationOrigin ?? null,
    occurredAt: request.activityOccurredAt,
    kind: "agent-operation",
    action: "browser-script",
    outcome: interrupted ? "interrupted" : outcome,
    interrupted,
    interruptionReason: interrupted ? "request-aborted" : null,
    durationMs: Math.min(Math.max(Date.now() - startedAt, 0), 30_000),
  };
}

async function recordScriptActivity(
  outbox: ActivityOutbox,
  request: BrowserScriptRequest,
  context: ScriptSignalContext,
  outcome: ScriptActivityOutcome,
  startedAt: number,
) {
  await outbox.enqueue(
    scriptActivityEvent(request, context, outcome, startedAt),
  );
}

export function createBrowserHostEntry(
  source: HostBoundarySource,
  profileSource?: ProfileStoreSource,
) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  let retainedBoundary: HostAdministrationBoundary | undefined;
  let retainedProfiles: BrowserProfileStore | undefined;
  let retainedOutbox: ActivityOutbox | undefined;
  function administration(dataDir: string) {
    if (retainedBoundary !== undefined) return retainedBoundary;
    const boundary = typeof source === "function" ? source(dataDir) : source;
    retainedBoundary = isAdministrationBoundary(boundary)
      ? boundary
      : createReadOnlyHostAdministrationBoundary({
          readiness: boundary,
          installationId: hostInstallationId(dataDir),
          stateStore: createFileHostAdministrationStateStore(dataDir),
        });
    return retainedBoundary;
  }
  function profiles(dataDir: string) {
    if (retainedProfiles !== undefined) return retainedProfiles;
    retainedProfiles =
      profileSource === undefined
        ? createFileBrowserProfileStore({
            rootDirectory: join(dataDir, "browser-profiles"),
            installationId: hostInstallationId(dataDir),
          })
        : typeof profileSource === "function"
          ? profileSource(dataDir)
          : profileSource;
    return retainedProfiles;
  }
  function outbox(dataDir: string) {
    if (retainedOutbox !== undefined) return retainedOutbox;
    retainedOutbox = createActivityOutbox({
      filePath: join(dataDir, "browser-activity-outbox.json"),
    });
    return retainedOutbox;
  }
  function retainWorker(context: {
    experimental_retainWorker(): { dispose(): Promise<void> };
  }) {
    workerLease ??= context.experimental_retainWorker();
  }
  return experimental_defineHostEntry({
    contract: browserHostContract,
    handlers: {
      status: (target, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).inspect(
          target,
        );
      },
      diagnostics: (target, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).diagnostics(
          target,
        );
      },
      setupPlan: (target, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).setupPlan(
          target,
        );
      },
      setup: (request, context) => {
        retainWorker(context);
        return (async () => {
          const dataDir = context.experimental_paths.dataDir;
          const response = await administration(dataDir).setup(request);
          if (response.plan.state === "ready") {
            await profiles(dataDir).initialize(request.hostId);
          }
          return response;
        })();
      },
      disable: (request, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).disable(
          request,
        );
      },
      uninstall: (request, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).uninstall(
          request,
        );
      },
      purgePlan: (target, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).purgePlan(
          target,
        );
      },
      purge: (request, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).purge(
          request,
        );
      },
      browserScript: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const startedAt = Date.now();
        const target = {
          hostId: request.hostId,
          profileId: request.profileId,
        };
        let response: BrowserScriptResponse | undefined;
        try {
          const readiness = await administration(dataDir).inspect(target);
          if (readiness.state !== "healthy") {
            response = { ok: false as const, error: readiness };
            return response;
          }
          const inventory = await profiles(dataDir).listProfiles(
            request.hostId,
          );
          if (
            !inventory.profiles.some(
              (profile) => profile.profileId === request.profileId,
            )
          ) {
            response = {
              ok: false as const,
              error: browserProfileUnavailableStatus(target),
            };
            return response;
          }
          response = {
            ok: false as const,
            error: await administration(
              context.experimental_paths.dataDir,
            ).inspect(target),
          };
          return response;
        } finally {
          await recordScriptActivity(
            outbox(dataDir),
            request,
            context,
            response?.ok === true ? "succeeded" : "failed",
            startedAt,
          );
        }
      },
      activityOutbox: async ({ limit }, context) => {
        retainWorker(context);
        return outbox(context.experimental_paths.dataDir).claim({
          now: new Date(),
          limit,
        });
      },
      acknowledgeActivity: async ({ eventIds }, context) => {
        retainWorker(context);
        const acknowledgedEventIds = await outbox(
          context.experimental_paths.dataDir,
        ).acknowledge(eventIds);
        return { acknowledgedEventIds };
      },
      reconcileActivity: async ({ acknowledgedEventIds, limit }, context) => {
        retainWorker(context);
        return outbox(context.experimental_paths.dataDir).reconcile({
          acknowledgedEventIds,
          limit,
        });
      },
      listProfiles: (target, context) => {
        retainWorker(context);
        return profiles(context.experimental_paths.dataDir).listProfiles(
          target.hostId,
        );
      },
      createProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), {
          hostId: request.hostId,
          profileId: DEFAULT_PROFILE_ID,
        });
        return profiles(dataDir).createProfile(request);
      },
      renameProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).renameProfile(request);
      },
      selectProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).selectProfile(request);
      },
    },
    dispose: async () => workerLease?.dispose(),
  });
}

export default createBrowserHostEntry(
  (dataDir) =>
    createReadOnlyHostAdministrationBoundary({
      readiness: createHostReadinessBoundary(
        createDefaultHostSnapshotReader(dataDir),
      ),
      installationId: hostInstallationId(dataDir),
      stateStore: createFileHostAdministrationStateStore(dataDir),
    }),
  (dataDir) =>
    createFileBrowserProfileStore({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      ownership: createBrowserUserProfileOwnershipBoundary(),
    }),
);
