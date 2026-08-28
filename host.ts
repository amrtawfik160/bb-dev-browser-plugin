import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createActivityOutbox,
  type ActivityOutbox,
} from "./activity-outbox.js";
import { browserHostContract } from "./host-contract.js";
import {
  createBrowserUserProfileOwnershipBoundary,
  createFileBrowserProfileStore,
  type BrowserProfileLifecycleBoundary,
  type BrowserProfileStore,
} from "./profile-storage.js";
import {
  createFileBrowserProfileRecovery,
  type BrowserProfileRecovery,
} from "./profile-recovery.js";
import {
  createFileHostAdministrationStateStore,
  createHostAdministrationBoundary,
  createProductionPrivilegedExecutor,
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
import {
  createBrowserInstanceRuntime,
  type BrowserInstanceRuntime,
} from "./browser-runtime.js";
import { createProductionBrowserProcessBoundary } from "./browser-process.js";
import { PINNED_BROWSER_RUNTIME } from "./dependency-inventory.js";

export type HostSetupBoundary = HostReadinessBoundary;
type HostBoundary = HostReadinessBoundary | HostAdministrationBoundary;
type HostBoundarySource = HostBoundary | ((dataDir: string) => HostBoundary);
type ProfileStoreSource =
  | BrowserProfileStore
  | ((
      dataDir: string,
      lifecycle: BrowserProfileLifecycleBoundary,
    ) => BrowserProfileStore);
type ProfileRecoverySource =
  BrowserProfileRecovery | ((dataDir: string) => BrowserProfileRecovery);
type BrowserRuntimeSource =
  BrowserInstanceRuntime | ((dataDir: string) => BrowserInstanceRuntime);

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

function unverifiedDevBrowserProfileIsStopped() {
  return false;
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

async function recordExpiredProfiles(
  outbox: ActivityOutbox,
  hostId: string,
  profileIds: readonly string[],
) {
  for (const profileId of profileIds) {
    await outbox.enqueue({
      eventId: `host-lifecycle-${randomUUID()}`,
      actor: "system",
      projectId: null,
      hostId,
      profileId,
      destinationOrigin: null,
      occurredAt: new Date().toISOString(),
      kind: "lifecycle",
      action: "archive-expired",
      outcome: "deleted",
      interrupted: false,
      interruptionReason: null,
      durationMs: null,
    });
  }
}

export function createBrowserHostEntry(
  source: HostBoundarySource,
  profileSource?: ProfileStoreSource,
  recoverySource?: ProfileRecoverySource,
  runtimeSource?: BrowserRuntimeSource,
) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  let retainedBoundary: HostAdministrationBoundary | undefined;
  let retainedProfiles: BrowserProfileStore | undefined;
  let retainedRecovery: BrowserProfileRecovery | undefined;
  let retainedOutbox: ActivityOutbox | undefined;
  let retainedRuntime: BrowserInstanceRuntime | undefined;
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
  function profileLifecycle(dataDir: string): BrowserProfileLifecycleBoundary {
    return {
      async stopProfile(hostId, profileId) {
        try {
          await runtime(dataDir)?.stop({ hostId, profileId });
        } finally {
          await administration(dataDir).stopProfile({ hostId, profileId });
        }
      },
    };
  }
  function runtime(dataDir: string) {
    if (retainedRuntime !== undefined) return retainedRuntime;
    if (runtimeSource === undefined) return undefined;
    retainedRuntime =
      typeof runtimeSource === "function"
        ? runtimeSource(dataDir)
        : runtimeSource;
    return retainedRuntime;
  }
  function profiles(dataDir: string) {
    if (retainedProfiles !== undefined) return retainedProfiles;
    retainedProfiles =
      profileSource === undefined
        ? createFileBrowserProfileStore({
            rootDirectory: join(dataDir, "browser-profiles"),
            installationId: hostInstallationId(dataDir),
            lifecycle: profileLifecycle(dataDir),
          })
        : typeof profileSource === "function"
          ? profileSource(dataDir, profileLifecycle(dataDir))
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
  function recovery(dataDir: string) {
    if (retainedRecovery !== undefined) return retainedRecovery;
    retainedRecovery =
      recoverySource === undefined
        ? createFileBrowserProfileRecovery({
            rootDirectory: join(dataDir, "browser-profiles"),
            installationId: hostInstallationId(dataDir),
            state: {
              isProfileStopped: (hostId, profileId) =>
                administration(dataDir).isProfileStopped({
                  hostId,
                  profileId,
                }),
              isDevBrowserProfileStopped: unverifiedDevBrowserProfileIsStopped,
            },
            ownership: createBrowserUserProfileOwnershipBoundary(),
          })
        : typeof recoverySource === "function"
          ? recoverySource(dataDir)
          : recoverySource;
    return retainedRecovery;
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
          const profile = inventory.profiles.find(
            (candidate) =>
              candidate.profileId === request.profileId &&
              candidate.state === "active",
          );
          if (profile === undefined) {
            response = {
              ok: false as const,
              error: browserProfileUnavailableStatus(target),
            };
            return response;
          }
          const browserRuntime = runtime(dataDir);
          if (browserRuntime !== undefined) {
            response = {
              ok: true as const,
              result: await browserRuntime.execute(
                {
                  hostId: request.hostId,
                  profileId: request.profileId,
                  locale: profile.locale,
                  timezone: profile.timezone,
                },
                request.code,
                request.timeoutMs,
              ),
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
      listProfiles: async (target, context) => {
        retainWorker(context);
        const store = profiles(context.experimental_paths.dataDir);
        const inventory = await store.listProfiles(target.hostId);
        if (inventory.profiles.length === 0) return inventory;
        await store.reconcileProfileLifecycle(target.hostId);
        const expired = await store.expireArchivedProfiles(target.hostId);
        await recordExpiredProfiles(
          outbox(context.experimental_paths.dataDir),
          target.hostId,
          expired.deletedProfileIds,
        );
        return store.listProfiles(target.hostId);
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
      archiveProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).archiveProfile(request);
      },
      restoreArchivedProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).restoreArchivedProfile(request);
      },
      resetProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).resetProfile(request);
      },
      deleteProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).deleteProfile(request);
      },
      expireArchivedProfiles: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const expired = await profiles(dataDir).expireArchivedProfiles(
          request.hostId,
        );
        await recordExpiredProfiles(
          outbox(dataDir),
          request.hostId,
          expired.deletedProfileIds,
        );
        return expired;
      },
      backupProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return recovery(dataDir).backupProfile(request);
      },
      restoreProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return recovery(dataDir).restoreProfile(request);
      },
      importProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), {
          hostId: request.hostId,
          profileId: DEFAULT_PROFILE_ID,
        });
        return recovery(dataDir).importDevBrowserProfile(request);
      },
    },
    dispose: async () => {
      try {
        await retainedRuntime?.dispose();
      } finally {
        await workerLease?.dispose();
      }
    },
  });
}

const require = createRequire(import.meta.url);
const devBrowserPackageDirectory = dirname(
  require.resolve("dev-browser/package.json"),
);
const devBrowserExecutable = join(
  devBrowserPackageDirectory,
  "bin",
  "dev-browser.js",
);
const playwrightBrowserRoot =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  join(homedir(), ".cache", "ms-playwright");
const playwrightChromiumPath = join(
  playwrightBrowserRoot,
  `chromium-${PINNED_BROWSER_RUNTIME.chromiumRevision}`,
  "chrome-linux64",
  "chrome",
);

export default createBrowserHostEntry(
  (dataDir) =>
    createHostAdministrationBoundary({
      readiness: createHostReadinessBoundary(
        createDefaultHostSnapshotReader(dataDir),
      ),
      installationId: hostInstallationId(dataDir),
      executor: createProductionPrivilegedExecutor(),
      stateStore: createFileHostAdministrationStateStore(dataDir),
    }),
  (dataDir, lifecycle) =>
    createFileBrowserProfileStore({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      ownership: createBrowserUserProfileOwnershipBoundary(),
      lifecycle,
    }),
  (dataDir) =>
    createFileBrowserProfileRecovery({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      state: {
        isProfileStopped: (hostId, profileId) =>
          createHostAdministrationBoundary({
            readiness: createHostReadinessBoundary(
              createDefaultHostSnapshotReader(dataDir),
            ),
            installationId: hostInstallationId(dataDir),
            executor: createProductionPrivilegedExecutor(),
            stateStore: createFileHostAdministrationStateStore(dataDir),
          }).isProfileStopped({ hostId, profileId }),
        isDevBrowserProfileStopped: unverifiedDevBrowserProfileIsStopped,
      },
      ownership: createBrowserUserProfileOwnershipBoundary(),
    }),
  (dataDir) =>
    createBrowserInstanceRuntime({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      chromeStablePaths: [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
      ],
      playwrightChromiumPath,
      launchBoundary: createProductionBrowserProcessBoundary({
        devBrowserExecutable,
        devBrowserPackageDirectory,
      }),
    }),
);
