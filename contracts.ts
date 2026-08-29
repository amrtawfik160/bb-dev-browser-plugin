import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_PROFILE_ID = "bb-personal";
export const SETUP_REQUIRED_MESSAGE =
  "Browser host setup has not been completed.";
export const BROWSER_STORAGE_ROOT = "/var/lib/bb-browser";
export const BROWSER_CONFIGURATION_ROOT = "/etc/bb-browser";
export const STOP_BROWSER_CONFIRMATION = "Stop Browser processes";

export function browserHostStorageSegment(hostId: string) {
  return encodeURIComponent(hostId).replaceAll(".", "%2E");
}

export const SETUP_STEP_IDS = [
  "dedicated-user",
  "system-packages",
  "protected-storage",
] as const;

export const setupStepIdSchema = z.enum(SETUP_STEP_IDS);
export type SetupStepId = z.infer<typeof setupStepIdSchema>;

export const SETUP_STEP_DEFINITIONS = [
  {
    id: "dedicated-user",
    label: "Create the dedicated browser user",
    description:
      "Create bb-browser with a non-login shell and no administrative privileges.",
    confirmationText: "Create bb-browser",
  },
  {
    id: "system-packages",
    label: "Install Browser system packages",
    description:
      "Install the pinned Browser runtime and Safe Login display helpers.",
    confirmationText: "Install Browser packages",
  },
  {
    id: "protected-storage",
    label: "Configure protected Browser storage",
    description:
      "Create installation- and host-scoped storage owned only by bb-browser.",
    confirmationText: "Configure protected Browser storage",
  },
] as const satisfies readonly {
  id: SetupStepId;
  label: string;
  description: string;
  confirmationText: string;
}[];

export const browserSetupStepSchema = z
  .object({
    id: setupStepIdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    confirmationText: z.string().min(1),
    state: z.enum(["pending", "completed", "failed"]),
    failure: z.string().min(1).nullable(),
  })
  .strict();

export const browserSetupPlanSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    installationId: z.string().min(1),
    state: z.enum(["pending", "in-progress", "partial-failure", "ready"]),
    nextStepId: setupStepIdSchema.nullable(),
    storageRoot: z.string().min(1),
    hostStoragePath: z.string().min(1),
    storageOwner: z.literal("bb-browser"),
    storageMode: z.literal("0700"),
    configurationPath: z.string().min(1),
    runtime: z
      .object({
        runAsUser: z.literal("bb-browser"),
        homeDirectory: z.string().min(1),
        shell: z.literal("/usr/sbin/nologin"),
        sandbox: z.literal("required"),
        noSandbox: z.literal(false),
      })
      .strict(),
    packages: z
      .array(
        z
          .object({
            name: z.string().min(1),
            purpose: z.string().min(1),
          })
          .strict(),
      )
      .length(4),
    steps: z.array(browserSetupStepSchema).length(3),
  })
  .strict();

export const browserSetupRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    stepId: setupStepIdSchema,
    confirmation: z.string().min(1),
  })
  .strict();

export const browserSetupResponseSchema = z
  .object({
    outcome: z.enum([
      "confirmation-required",
      "blocked",
      "progressed",
      "completed",
      "already-complete",
      "partial-failure",
    ]),
    message: z.string().min(1),
    plan: browserSetupPlanSchema,
  })
  .strict();

export const browserLifecycleRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    confirmation: z.string().min(1),
  })
  .strict();

export const browserLifecycleResponseSchema = z
  .object({
    action: z.enum(["disable", "uninstall"]),
    outcome: z.enum([
      "confirmation-required",
      "stopped",
      "already-stopped",
      "failed",
    ]),
    message: z.string().min(1),
    confirmationText: z.string().min(1),
    profilesRetained: z.literal(true),
  })
  .strict();

export const browserPurgeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("processes"),
      id: z.literal("stop-owned-processes"),
      scope: z.literal("Browser-owned processes"),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser-data"),
      id: z.literal("browser-data"),
      path: z.string().min(1),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("configuration"),
      id: z.literal("configuration"),
      path: z.string().min(1),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system-user"),
      id: z.literal("dedicated-user"),
      username: z.literal("bb-browser"),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
]);

export const browserPurgePlanSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    installationId: z.string().min(1),
    state: z.enum(["pending", "in-progress", "partial-failure", "purged"]),
    confirmationText: z.string().min(1),
    targets: z.array(browserPurgeTargetSchema).length(4),
  })
  .strict();

export const browserPurgeRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    confirmation: z.string().min(1),
  })
  .strict();

export const browserPurgeResponseSchema = z
  .object({
    outcome: z.enum([
      "confirmation-required",
      "progressed",
      "purged",
      "already-purged",
      "partial-failure",
    ]),
    message: z.string().min(1),
    plan: browserPurgePlanSchema,
  })
  .strict();

export type BrowserSetupPlan = z.infer<typeof browserSetupPlanSchema>;
export type BrowserSetupRequest = z.infer<typeof browserSetupRequestSchema>;
export type BrowserSetupResponse = z.infer<typeof browserSetupResponseSchema>;
export type BrowserLifecycleRequest = z.infer<
  typeof browserLifecycleRequestSchema
>;
export type BrowserLifecycleResponse = z.infer<
  typeof browserLifecycleResponseSchema
>;
export type BrowserPurgePlan = z.infer<typeof browserPurgePlanSchema>;
export type BrowserPurgeRequest = z.infer<typeof browserPurgeRequestSchema>;
export type BrowserPurgeResponse = z.infer<typeof browserPurgeResponseSchema>;

export const readinessCapabilityIdSchema = z.enum([
  "operating-system",
  "architecture",
  "bb-connect",
  "browser",
  "sandbox",
  "dedicated-user",
  "protected-storage",
  "disk-headroom",
  "loopback",
]);

export const readinessCapabilitySchema = z
  .object({
    id: readinessCapabilityIdSchema,
    label: z.string().min(1),
    status: z.enum([
      "ready",
      "missing",
      "failed",
      "unsupported",
      "unavailable",
    ]),
    reason: z.string().min(1),
  })
  .strict();

export const browserStatusTargetSchema = z
  .object({
    hostId: z.string().min(1).nullable(),
    profileId: z.string().min(1),
  })
  .strict();

export const browserHostTargetSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict();

const browserStatusFields = {
  ...browserStatusTargetSchema.shape,
  capabilities: z.array(readinessCapabilitySchema).length(9),
};

export const browserStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...browserStatusFields,
      state: z.literal("setup-required"),
      code: z.literal("setup_required"),
      label: z.literal("Setup required"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("host-offline"),
      code: z.literal("host_offline"),
      label: z.literal("Host offline"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("repair-required"),
      code: z.literal("repair_required"),
      label: z.literal("Repair required"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("unsupported"),
      code: z.literal("unsupported"),
      label: z.literal("Unsupported"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("healthy"),
      code: z.literal("healthy"),
      label: z.literal("Ready"),
      message: z.string().min(1),
    })
    .strict(),
]);

export type BrowserStatusTarget = z.infer<typeof browserStatusTargetSchema>;
export type BrowserHostTarget = z.infer<typeof browserHostTargetSchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export type ReadinessCapability = z.infer<typeof readinessCapabilitySchema>;

export const READINESS_CAPABILITIES = [
  ["operating-system", "Operating system"],
  ["architecture", "Architecture"],
  ["bb-connect", "BB Connect"],
  ["browser", "Browser"],
  ["sandbox", "Browser sandbox"],
  ["dedicated-user", "Dedicated browser user"],
  ["protected-storage", "Protected storage"],
  ["disk-headroom", "Disk headroom"],
  ["loopback", "Loopback networking"],
] as const;

function unavailableCapabilities(reason: string): ReadinessCapability[] {
  return READINESS_CAPABILITIES.map(([id, label]) => ({
    id,
    label,
    status: "unavailable",
    reason,
  }));
}

export const browserDiagnosticsSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    generatedAt: z.string().datetime(),
    readiness: browserStatusSchema,
    dependencies: z.array(
      z
        .object({
          name: z.string().min(1),
          version: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    processes: z.array(
      z
        .object({
          name: z.string().min(1),
          state: z.enum(["running", "stopped", "failed"]),
          pid: z.number().int().positive().optional(),
        })
        .strict(),
    ),
    resourceUse: z
      .object({
        diskFreeBytes: z.number().nonnegative(),
        diskTotalBytes: z.number().nonnegative(),
        workerRssBytes: z.number().nonnegative(),
      })
      .strict(),
    exitLogs: z.array(z.string().max(500)).max(50),
  })
  .strict();

export type BrowserDiagnostics = z.infer<typeof browserDiagnosticsSchema>;

export const browserActivityRecordSchema = z
  .object({
    id: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    actor: z.literal("owner"),
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    kind: z.enum(["setup", "lifecycle", "purge"]),
    action: z.string().min(1),
    outcome: z.string().min(1),
    interrupted: z.boolean(),
  })
  .strict();

export const browserActivityRecordsSchema = z
  .array(browserActivityRecordSchema)
  .max(10_000);

export type BrowserActivityRecord = z.infer<typeof browserActivityRecordSchema>;

export function setupRequiredStatus(
  target: BrowserStatusTarget,
): BrowserStatus {
  return {
    ...target,
    state: "setup-required",
    code: "setup_required",
    label: "Setup required",
    message: SETUP_REQUIRED_MESSAGE,
    capabilities: unavailableCapabilities(
      target.hostId === null
        ? "Select a workspace host to run this check."
        : "Run Browser status on the workspace host to inspect this check.",
    ),
  };
}

export function hostOfflineStatus(target: BrowserStatusTarget): BrowserStatus {
  return {
    ...target,
    state: "host-offline",
    code: "host_offline",
    label: "Host offline",
    message: "Reconnect this workspace host to run Browser readiness checks.",
    capabilities: unavailableCapabilities(
      "Reconnect the host to inspect this capability.",
    ),
  };
}

export function hostProbeFailedStatus(
  target: BrowserStatusTarget,
): BrowserStatus {
  return {
    ...target,
    state: "repair-required",
    code: "repair_required",
    label: "Repair required",
    message:
      "Connected host readiness checks failed. Retry, then inspect Browser diagnostics.",
    capabilities: unavailableCapabilities(
      "The retained host worker could not complete this check.",
    ),
  };
}

const threadSurfaceSchema = z
  .object({
    surface: z.literal("thread"),
    threadId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict();

const newThreadSurfaceSchema = z
  .object({
    surface: z.literal("new-thread"),
    projectId: z.string().min(1).nullable(),
    profileId: z.string().min(1),
  })
  .strict();

export const browserStatusInputSchema = z.discriminatedUnion("surface", [
  threadSurfaceSchema,
  newThreadSurfaceSchema,
]);

export type BrowserStatusInput = z.infer<typeof browserStatusInputSchema>;

export const rpcContract = defineRpcContract({
  browser_status: {
    input: browserStatusInputSchema,
    output: browserStatusSchema,
  },
  browser_settings_status: {
    input: z.object({ profileId: z.string().min(1) }).strict(),
    output: z.array(browserStatusSchema),
  },
  browser_diagnostics: {
    input: browserStatusTargetSchema,
    output: browserDiagnosticsSchema,
  },
  browser_activity_records: {
    input: browserHostTargetSchema,
    output: browserActivityRecordsSchema,
  },
  browser_setup_plan: {
    input: browserHostTargetSchema,
    output: browserSetupPlanSchema,
  },
  browser_setup: {
    input: browserSetupRequestSchema,
    output: browserSetupResponseSchema,
  },
  browser_disable: {
    input: browserLifecycleRequestSchema,
    output: browserLifecycleResponseSchema,
  },
  browser_uninstall: {
    input: browserLifecycleRequestSchema,
    output: browserLifecycleResponseSchema,
  },
  browser_purge_plan: {
    input: browserHostTargetSchema,
    output: browserPurgePlanSchema,
  },
  browser_purge: {
    input: browserPurgeRequestSchema,
    output: browserPurgeResponseSchema,
  },
});

export const browserScriptParametersSchema = z
  .object({
    purpose: z.string().trim().min(1).max(200),
    code: z.string().min(1),
    profileId: z.string().min(1).optional(),
    tabId: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(30_000).default(30_000),
  })
  .strict();

export const browserScriptRequestSchema = browserScriptParametersSchema
  .extend({
    hostId: z.string().min(1),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict();

export const browserScriptFailureSchema = z
  .object({
    ok: z.literal(false),
    error: browserStatusSchema,
  })
  .strict();

export type BrowserScriptFailure = z.infer<typeof browserScriptFailureSchema>;
