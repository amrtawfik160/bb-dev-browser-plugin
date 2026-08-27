import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_PROFILE_ID = "bb-personal";
export const SETUP_REQUIRED_MESSAGE =
  "Browser host setup has not been completed.";

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

export const browserStatusSchema = browserStatusTargetSchema
  .extend({
    state: z.literal("setup-required"),
    code: z.literal("setup_required"),
    label: z.literal("Setup required"),
    message: z.literal(SETUP_REQUIRED_MESSAGE),
  })
  .strict();

export type BrowserStatusTarget = z.infer<typeof browserStatusTargetSchema>;
export type BrowserHostTarget = z.infer<typeof browserHostTargetSchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;

export function setupRequiredStatus(
  target: BrowserStatusTarget,
): BrowserStatus {
  return {
    ...target,
    state: "setup-required",
    code: "setup_required",
    label: "Setup required",
    message: SETUP_REQUIRED_MESSAGE,
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
