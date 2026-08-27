import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { join } from "node:path";
import { browserHostContract } from "./host-contract.js";
import {
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
  browserProfileUnavailableStatus,
} from "./contracts.js";

export type HostSetupBoundary = HostReadinessBoundary;
type HostBoundary = HostReadinessBoundary | HostAdministrationBoundary;
type HostBoundarySource = HostBoundary | ((dataDir: string) => HostBoundary);
type ProfileStoreSource =
  BrowserProfileStore | ((dataDir: string) => BrowserProfileStore);

function isAdministrationBoundary(
  boundary: HostBoundary,
): boundary is HostAdministrationBoundary {
  return "setupPlan" in boundary;
}

export function createBrowserHostEntry(
  source: HostBoundarySource,
  profileSource?: ProfileStoreSource,
) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  let retainedBoundary: HostAdministrationBoundary | undefined;
  let retainedProfiles: BrowserProfileStore | undefined;
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
        return administration(context.experimental_paths.dataDir).setup(
          request,
        );
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
      browserScript: async ({ hostId, profileId }, context) => {
        retainWorker(context);
        const inventory = await profiles(
          context.experimental_paths.dataDir,
        ).listProfiles(hostId);
        if (
          !inventory.profiles.some((profile) => profile.profileId === profileId)
        ) {
          return {
            ok: false as const,
            error: browserProfileUnavailableStatus({ hostId, profileId }),
          };
        }
        return {
          ok: false as const,
          error: await administration(
            context.experimental_paths.dataDir,
          ).inspect({
            hostId,
            profileId,
          }),
        };
      },
      listProfiles: (target, context) => {
        retainWorker(context);
        return profiles(context.experimental_paths.dataDir).listProfiles(
          target.hostId,
        );
      },
      createProfile: (request, context) => {
        retainWorker(context);
        return profiles(context.experimental_paths.dataDir).createProfile(
          request,
        );
      },
      renameProfile: (request, context) => {
        retainWorker(context);
        return profiles(context.experimental_paths.dataDir).renameProfile(
          request,
        );
      },
      selectProfile: (request, context) => {
        retainWorker(context);
        return profiles(context.experimental_paths.dataDir).selectProfile(
          request,
        );
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
    }),
);
