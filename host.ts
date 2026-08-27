import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { browserHostContract } from "./host-contract.js";
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

export type HostSetupBoundary = HostReadinessBoundary;
type HostBoundary = HostReadinessBoundary | HostAdministrationBoundary;
type HostBoundarySource = HostBoundary | ((dataDir: string) => HostBoundary);

function isAdministrationBoundary(
  boundary: HostBoundary,
): boundary is HostAdministrationBoundary {
  return "setupPlan" in boundary;
}

export function createBrowserHostEntry(source: HostBoundarySource) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  let retainedBoundary: HostAdministrationBoundary | undefined;
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
    },
    dispose: async () => workerLease?.dispose(),
  });
}

export default createBrowserHostEntry((dataDir) =>
  createReadOnlyHostAdministrationBoundary({
    readiness: createHostReadinessBoundary(
      createDefaultHostSnapshotReader(dataDir),
    ),
    installationId: hostInstallationId(dataDir),
    stateStore: createFileHostAdministrationStateStore(dataDir),
  }),
);
