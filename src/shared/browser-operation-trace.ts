import { z } from "zod";

export const BROWSER_TRACE_MAX_PER_PROFILE = 200;
export const BROWSER_TRACE_RETENTION_MS = 30 * 60 * 1_000;
export const BROWSER_TRACE_MAX_STAGES = 24;

const traceStageSchema = z.enum([
  "readiness",
  "profile",
  "lease-wait",
  "browser-start",
  "renderer-check",
  "browser-execute",
  "tab-reconcile",
  "panel-transport",
]);

const traceStateSchema = z.enum(["running", "succeeded", "failed"]);

export const browserOperationTraceSchema = z
  .object({
    traceId: z.string().uuid(),
    operation: z.enum([
      "browser-script",
      "navigate",
      "history",
      "tab-open",
      "tab-activate",
      "tab-close",
      "panel-connect",
    ]),
    startedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    state: traceStateSchema,
    errorCode: z
      .enum([
        "browser_busy",
        "awake-limit",
        "browser_timeout",
        "result_too_large",
        "lease_revoked",
        "tab_invalid",
        "sandbox_violation",
        "script_failed",
        "safe_login_denied",
        "origin_denied",
        "not_ready",
        "cancelled",
        "runtime_failed",
      ])
      .optional(),
    connectionRetries: z.number().int().nonnegative(),
    targetedTab: z.boolean(),
    tabCount: z.number().int().nonnegative().optional(),
    tabGeneration: z.number().int().nonnegative().optional(),
    stages: z
      .array(
        z
          .object({
            stage: traceStageSchema,
            offsetMs: z.number().nonnegative(),
            durationMs: z.number().nonnegative(),
            state: traceStateSchema,
          })
          .strict(),
      )
      .max(BROWSER_TRACE_MAX_STAGES),
  })
  .strict();

export const browserOperationTracesSchema = z
  .object({
    workerId: z.string().uuid(),
    retentionMs: z.literal(BROWSER_TRACE_RETENTION_MS),
    maxTracesPerProfile: z.literal(BROWSER_TRACE_MAX_PER_PROFILE),
    traces: z
      .array(browserOperationTraceSchema)
      .max(BROWSER_TRACE_MAX_PER_PROFILE),
  })
  .strict();

export type BrowserOperationTraceRecord = z.infer<
  typeof browserOperationTraceSchema
>;
export type BrowserOperationTracesSnapshot = z.infer<
  typeof browserOperationTracesSchema
>;
export type BrowserTraceStage = z.infer<typeof traceStageSchema>;
export type BrowserTraceErrorCode = NonNullable<
  BrowserOperationTraceRecord["errorCode"]
>;
export type BrowserOperationTrace = {
  readonly traceId: string;
  measure<T>(stage: BrowserTraceStage, run: () => Promise<T>): Promise<T>;
  connectionRetried(): void;
  tabInventory(count: number, generation: number): void;
  finish(errorCode?: BrowserTraceErrorCode): void;
};

export function measureBrowserStage<T>(
  trace: BrowserOperationTrace | undefined,
  stage: BrowserTraceStage,
  run: () => Promise<T>,
): Promise<T> {
  return trace === undefined ? run() : trace.measure(stage, run);
}
