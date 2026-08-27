import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { browserHostContract } from "./host-contract.js";
import {
  createHostReadinessBoundary,
  defaultHostSnapshotReader,
  type HostReadinessBoundary,
} from "./readiness.js";

export type HostSetupBoundary = HostReadinessBoundary;

export function createBrowserHostEntry(readiness: HostReadinessBoundary) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  return experimental_defineHostEntry({
    contract: browserHostContract,
    handlers: {
      status: (target, context) => {
        workerLease ??= context.experimental_retainWorker();
        return readiness.inspect(target);
      },
      diagnostics: (target, context) => {
        workerLease ??= context.experimental_retainWorker();
        return readiness.diagnostics(target);
      },
      browserScript: async ({ hostId, profileId }, context) => {
        workerLease ??= context.experimental_retainWorker();
        return {
          ok: false as const,
          error: await readiness.inspect({
            hostId,
            profileId,
            connectEnrolled: true,
          }),
        };
      },
    },
    dispose: async () => workerLease?.dispose(),
  });
}

export default createBrowserHostEntry(
  createHostReadinessBoundary(defaultHostSnapshotReader),
);
