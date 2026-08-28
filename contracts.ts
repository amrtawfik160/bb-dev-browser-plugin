import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_PROFILE_ID = "bb-personal";
export const PROFILE_MANIFEST_VERSION = 1 as const;
export const PROFILE_DEFAULT_LOCALE = "en-US";
export const PROFILE_DEFAULT_TIMEZONE = "UTC";
export const SETUP_REQUIRED_MESSAGE =
  "Browser host setup has not been completed.";
export const BROWSER_STORAGE_ROOT = "/var/lib/bb-browser";
export const BROWSER_CONFIGURATION_ROOT = "/etc/bb-browser";
export const STOP_BROWSER_CONFIRMATION = "Stop Browser processes";
export const CLEAR_ACTIVITY_CONFIRMATION = "Clear Browser activity records";
export const ACTIVITY_RECORD_LIMIT = 10_000;
export const ACTIVITY_RETENTION_DAYS = 30;
export const ACTIVITY_OUTBOX_BATCH_LIMIT = 100;

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

export const browserProfileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
export const browserProfileNameSchema = z.string().trim().min(1).max(80);
export const browserProfileLocaleSchema = z.string().trim().min(2).max(64);
export const browserProfileTimezoneSchema = z.string().trim().min(1).max(128);

export const browserProfileStartupSchema = z
  .object({
    initialTabUrl: z.literal("about:blank"),
    suppressWelcome: z.literal(true),
    chromeArguments: z.tuple([
      z.literal("--no-first-run"),
      z.literal("--no-default-browser-check"),
    ]),
  })
  .strict();

export const browserProfileStorageSchema = z
  .object({
    owner: z.literal("bb-browser"),
    directoryMode: z.literal("0700"),
    manifestMode: z.literal("0600"),
  })
  .strict();

export const browserProfileManifestSchema = z
  .object({
    version: z.literal(PROFILE_MANIFEST_VERSION),
    profileId: browserProfileIdSchema,
    name: browserProfileNameSchema,
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    locale: browserProfileLocaleSchema,
    timezone: browserProfileTimezoneSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    state: z.literal("active"),
    startup: browserProfileStartupSchema,
    storage: browserProfileStorageSchema,
  })
  .strict();

export const browserProfileSchema = browserProfileManifestSchema
  .extend({ selected: z.boolean() })
  .strict();

export const browserProfileHostTargetSchema = z
  .object({ hostId: z.string().min(1) })
  .strict();

export const browserProfileCreateRequestSchema = z
  .object({
    hostId: z.string().min(1),
    name: browserProfileNameSchema,
    locale: browserProfileLocaleSchema.optional(),
    timezone: browserProfileTimezoneSchema.optional(),
  })
  .strict();

export const browserProfileRenameRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    name: browserProfileNameSchema,
    locale: browserProfileLocaleSchema.optional(),
    timezone: browserProfileTimezoneSchema.optional(),
  })
  .strict();

export const browserProfileSelectRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
  })
  .strict();

const browserProfileContextSchema = z
  .object({
    projectId: z.string().min(1).nullable().optional(),
    threadId: z.string().min(1).optional(),
  })
  .strict();

export const browserProfileQuerySchema = browserProfileHostTargetSchema
  .extend(browserProfileContextSchema.shape)
  .strict();

export const browserProfileSelectionRequestSchema =
  browserProfileSelectRequestSchema
    .extend(browserProfileContextSchema.shape)
    .strict();

export const browserProfileInventorySchema = z
  .object({
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    selectedProfileId: browserProfileIdSchema,
    profiles: z.array(browserProfileSchema),
  })
  .strict();

export const browserHostChoiceSchema = z
  .object({
    hostId: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const browserHostChoicesInputSchema = z.discriminatedUnion("surface", [
  z
    .object({
      surface: z.literal("thread"),
      threadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      surface: z.literal("new-thread"),
      projectId: z.string().min(1).nullable(),
    })
    .strict(),
]);
export const browserHostChoicesSchema = z.array(browserHostChoiceSchema);

export type BrowserProfileManifest = z.infer<
  typeof browserProfileManifestSchema
>;
export type BrowserProfile = z.infer<typeof browserProfileSchema>;
export type BrowserProfileHostTarget = z.infer<
  typeof browserProfileHostTargetSchema
>;
export type BrowserProfileCreateRequest = z.infer<
  typeof browserProfileCreateRequestSchema
>;
export type BrowserProfileRenameRequest = z.infer<
  typeof browserProfileRenameRequestSchema
>;
export type BrowserProfileSelectRequest = z.infer<
  typeof browserProfileSelectRequestSchema
>;
export type BrowserProfileQuery = z.infer<typeof browserProfileQuerySchema>;
export type BrowserProfileSelectionRequest = z.infer<
  typeof browserProfileSelectionRequestSchema
>;
export type BrowserProfileInventory = z.infer<
  typeof browserProfileInventorySchema
>;
export type BrowserHostChoice = z.infer<typeof browserHostChoiceSchema>;
export type BrowserHostChoicesInput = z.infer<
  typeof browserHostChoicesInputSchema
>;

const browserProfileRecoveryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path) => !path.includes("\0"),
    "Recovery paths cannot contain NUL bytes.",
  );

export const browserProfileBackupRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    archivePath: browserProfileRecoveryPathSchema,
  })
  .strict();

export const browserProfileRestoreRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    archivePath: browserProfileRecoveryPathSchema,
  })
  .strict();

export const browserProfileImportRequestSchema = z
  .object({
    hostId: z.string().min(1),
    name: browserProfileNameSchema,
    sourcePath: browserProfileRecoveryPathSchema,
  })
  .strict();

export const browserProfileRecoveryProgressSchema = z
  .object({
    phase: z.enum(["validating", "copying", "promoting", "completed"]),
    completedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();

const browserProfileBackupResponseSchema = z
  .object({
    outcome: z.literal("backed-up"),
    message: z.string().min(1),
    archivePath: browserProfileRecoveryPathSchema,
    credentialEquivalent: z.literal(true),
    progress: browserProfileRecoveryProgressSchema,
  })
  .strict();

const browserProfileRestoreResponseSchema = z
  .object({
    outcome: z.literal("restored"),
    message: z.string().min(1),
    archivePath: browserProfileRecoveryPathSchema,
    credentialEquivalent: z.literal(true),
    progress: browserProfileRecoveryProgressSchema,
  })
  .strict();

const browserProfileImportResponseSchema = z
  .object({
    outcome: z.literal("imported"),
    message: z.string().min(1),
    profileId: browserProfileIdSchema,
    progress: browserProfileRecoveryProgressSchema,
  })
  .strict();

export const browserProfileRecoveryResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    browserProfileBackupResponseSchema,
    browserProfileRestoreResponseSchema,
    browserProfileImportResponseSchema,
  ],
);

export type BrowserProfileBackupRequest = z.infer<
  typeof browserProfileBackupRequestSchema
>;
export type BrowserProfileRestoreRequest = z.infer<
  typeof browserProfileRestoreRequestSchema
>;
export type BrowserProfileImportRequest = z.infer<
  typeof browserProfileImportRequestSchema
>;
export type BrowserProfileRecoveryResponse = z.infer<
  typeof browserProfileRecoveryResponseSchema
>;

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

export const browserActivityEventIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u);

export const browserActivityOriginSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((candidate) => {
    try {
      const origin = new URL(candidate);
      return (
        (origin.protocol === "http:" || origin.protocol === "https:") &&
        origin.origin === candidate &&
        origin.username === "" &&
        origin.password === ""
      );
    } catch {
      return false;
    }
  }, "Activity destination must be an exact HTTP origin.");

export const browserActivityActorSchema = z.enum(["owner", "agent", "system"]);
export const browserActivityKindSchema = z.enum([
  "setup",
  "lifecycle",
  "purge",
  "agent-operation",
  "grant",
  "control",
  "mode",
  "export",
]);

const browserActivityMetadataShape = {
  eventId: browserActivityEventIdSchema,
  actor: browserActivityActorSchema,
  projectId: z.string().min(1).nullable(),
  hostId: z.string().min(1),
  profileId: z.string().min(1),
  destinationOrigin: browserActivityOriginSchema.nullable(),
  occurredAt: z.string().datetime(),
  kind: browserActivityKindSchema,
  action: z.string().trim().min(1).max(80),
  outcome: z.string().trim().min(1).max(80),
  interrupted: z.boolean(),
  interruptionReason: z.string().trim().min(1).max(120).nullable(),
  durationMs: z.number().int().nonnegative().max(30_000).nullable(),
};

export const browserActivityEventSchema = z
  .object(browserActivityMetadataShape)
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
  .object({ id: z.number().int().positive(), ...browserActivityMetadataShape })
  .strict();

export const browserActivityRecordsSchema = z
  .array(browserActivityRecordSchema)
  .max(ACTIVITY_RECORD_LIMIT);

export const browserActivityOutboxItemSchema = z
  .object({
    ...browserActivityMetadataShape,
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime(),
  })
  .strict();

export const browserActivityOutboxSchema = z
  .array(browserActivityOutboxItemSchema)
  .max(ACTIVITY_OUTBOX_BATCH_LIMIT);

export const browserActivityExportSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    exportedAt: z.string().datetime(),
    records: browserActivityRecordsSchema,
  })
  .strict();

export const browserActivityClearRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    confirmation: z.string().min(1),
  })
  .strict();

export const browserActivityClearResponseSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    clearedCount: z.number().int().nonnegative(),
    message: z.string().min(1),
  })
  .strict();

export const browserActivityOutboxRequestSchema = z
  .object({
    hostId: z.string().min(1),
    limit: z
      .number()
      .int()
      .positive()
      .max(ACTIVITY_OUTBOX_BATCH_LIMIT)
      .default(ACTIVITY_OUTBOX_BATCH_LIMIT),
  })
  .strict();

export const browserActivityAcknowledgementRequestSchema = z
  .object({
    hostId: z.string().min(1),
    eventIds: z.array(browserActivityEventIdSchema).max(10_000),
  })
  .strict();

export const browserActivityAcknowledgementResponseSchema = z
  .object({
    acknowledgedEventIds: z.array(browserActivityEventIdSchema),
  })
  .strict();

export const browserActivityReconciliationRequestSchema = z
  .object({
    hostId: z.string().min(1),
    acknowledgedEventIds: z.array(browserActivityEventIdSchema).max(10_000),
    limit: z
      .number()
      .int()
      .positive()
      .max(ACTIVITY_OUTBOX_BATCH_LIMIT)
      .default(ACTIVITY_OUTBOX_BATCH_LIMIT),
  })
  .strict();

export type BrowserActivityRecord = z.infer<typeof browserActivityRecordSchema>;
export type BrowserActivityEvent = z.infer<typeof browserActivityEventSchema>;
export type BrowserActivityOutboxItem = z.infer<
  typeof browserActivityOutboxItemSchema
>;
export type BrowserActivityExport = z.infer<typeof browserActivityExportSchema>;
export type BrowserActivityClearResponse = z.infer<
  typeof browserActivityClearResponseSchema
>;

export function browserActivityEventFromOutboxItem(
  outboxItem: BrowserActivityOutboxItem,
): BrowserActivityEvent {
  return browserActivityEventSchema.parse({
    eventId: outboxItem.eventId,
    actor: outboxItem.actor,
    projectId: outboxItem.projectId,
    hostId: outboxItem.hostId,
    profileId: outboxItem.profileId,
    destinationOrigin: outboxItem.destinationOrigin,
    occurredAt: outboxItem.occurredAt,
    kind: outboxItem.kind,
    action: outboxItem.action,
    outcome: outboxItem.outcome,
    interrupted: outboxItem.interrupted,
    interruptionReason: outboxItem.interruptionReason,
    durationMs: outboxItem.durationMs,
  });
}

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

export function browserProfileUnavailableStatus(
  target: BrowserStatusTarget,
): BrowserStatus {
  return {
    ...target,
    state: "repair-required",
    code: "repair_required",
    label: "Repair required",
    message: "The requested Browser Profile is not available on this host.",
    capabilities: unavailableCapabilities(
      "Select a profile listed for this workspace host.",
    ),
  };
}

const threadSurfaceSchema = z
  .object({
    surface: z.literal("thread"),
    threadId: z.string().min(1),
    profileId: z.string().min(1),
    hostId: z.string().min(1).optional(),
    profileSelection: z.literal("selected").optional(),
  })
  .strict();

const newThreadSurfaceSchema = z
  .object({
    surface: z.literal("new-thread"),
    projectId: z.string().min(1).nullable(),
    profileId: z.string().min(1),
    hostId: z.string().min(1).optional(),
    profileSelection: z.literal("selected").optional(),
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
  browser_activity_export: {
    input: browserHostTargetSchema,
    output: browserActivityExportSchema,
  },
  browser_activity_clear: {
    input: browserActivityClearRequestSchema,
    output: browserActivityClearResponseSchema,
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
  browser_profiles: {
    input: browserProfileQuerySchema,
    output: browserProfileInventorySchema,
  },
  browser_profile_create: {
    input: browserProfileCreateRequestSchema,
    output: browserProfileSchema,
  },
  browser_profile_rename: {
    input: browserProfileRenameRequestSchema,
    output: browserProfileSchema,
  },
  browser_profile_select: {
    input: browserProfileSelectionRequestSchema,
    output: browserProfileInventorySchema,
  },
  browser_profile_backup: {
    input: browserProfileBackupRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  browser_profile_restore: {
    input: browserProfileRestoreRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  browser_profile_import: {
    input: browserProfileImportRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  browser_host_choices: {
    input: browserHostChoicesInputSchema,
    output: z.array(browserHostChoiceSchema),
  },
});

export const browserScriptParametersSchema = z
  .object({
    purpose: z.string().trim().min(1).max(200),
    code: z.string().min(1),
    destinationOrigin: browserActivityOriginSchema.optional(),
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
    activityEventId: browserActivityEventIdSchema,
    activityOccurredAt: z.string().datetime(),
    profileId: z.string().min(1),
  })
  .strict();

export const browserScriptFailureSchema = z
  .object({
    ok: z.literal(false),
    error: browserStatusSchema,
  })
  .strict();

export const browserScriptSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const browserScriptResponseSchema = z.discriminatedUnion("ok", [
  browserScriptSuccessSchema,
  browserScriptFailureSchema,
]);

export type BrowserScriptRequest = z.infer<typeof browserScriptRequestSchema>;
export type BrowserScriptFailure = z.infer<typeof browserScriptFailureSchema>;
export type BrowserScriptResponse = z.infer<typeof browserScriptResponseSchema>;
