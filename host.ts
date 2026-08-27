import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserStatus,
} from "./contracts.js";
import { browserHostContract } from "./host-contract.js";

export interface HostSetupBoundary {
  inspect(target: BrowserHostTarget): BrowserStatus | Promise<BrowserStatus>;
  provision(): void | Promise<void>;
}

export function createBrowserHostEntry(setup: HostSetupBoundary) {
  return experimental_defineHostEntry({
    contract: browserHostContract,
    handlers: {
      status: (target) => setup.inspect(target),
      browserScript: async ({ hostId, profileId }) => ({
        ok: false as const,
        error: await setup.inspect({ hostId, profileId }),
      }),
    },
  });
}

const absentHostSetup: HostSetupBoundary = {
  inspect: setupRequiredStatus,
  provision() {
    throw new Error("Privileged Browser setup is outside issue #2.");
  },
};

export default createBrowserHostEntry(absentHostSetup);
