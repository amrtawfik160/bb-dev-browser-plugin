import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { browserHostContract } from "./host-contract.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  type HostReadinessBoundary,
} from "./readiness.js";

export type HostSetupBoundary = HostReadinessBoundary;
type HostSetupBoundarySource =
  HostSetupBoundary | ((dataDir: string) => HostSetupBoundary);

export function createBrowserHostEntry(source: HostSetupBoundarySource) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  let retainedReadiness: HostSetupBoundary | undefined;
  function readiness(dataDir: string) {
    retainedReadiness ??=
      typeof source === "function" ? source(dataDir) : source;
    return retainedReadiness;
  }
  return experimental_defineHostEntry({
    contract: browserHostContract,
    handlers: {
      status: (target, context) => {
        workerLease ??= context.experimental_retainWorker();
        return readiness(context.experimental_paths.dataDir).inspect(target);
      },
      diagnostics: (target, context) => {
        workerLease ??= context.experimental_retainWorker();
        return readiness(context.experimental_paths.dataDir).diagnostics(
          target,
        );
      },
      browserScript: async ({ hostId, profileId }, context) => {
        workerLease ??= context.experimental_retainWorker();
        return {
          ok: false as const,
          error: await readiness(context.experimental_paths.dataDir).inspect({
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
  createHostReadinessBoundary(createDefaultHostSnapshotReader(dataDir)),
);
