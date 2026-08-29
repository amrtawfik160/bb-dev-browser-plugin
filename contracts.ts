import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_PROFILE_ID = "bb-personal";
export const SETUP_REQUIRED_MESSAGE =
  "Browser host setup has not been completed.";

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
