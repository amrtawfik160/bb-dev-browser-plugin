import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  browserDiagnosticsSchema,
  browserHostTargetSchema,
  browserLifecycleRequestSchema,
  browserLifecycleResponseSchema,
  browserPurgePlanSchema,
  browserPurgeRequestSchema,
  browserPurgeResponseSchema,
  browserSetupPlanSchema,
  browserSetupRequestSchema,
  browserSetupResponseSchema,
  browserScriptFailureSchema,
  browserScriptRequestSchema,
  browserStatusSchema,
} from "./contracts.js";

export const browserHostContract = defineRpcContract({
  status: {
    input: browserHostTargetSchema,
    output: browserStatusSchema,
  },
  diagnostics: {
    input: browserHostTargetSchema,
    output: browserDiagnosticsSchema,
  },
  setupPlan: {
    input: browserHostTargetSchema,
    output: browserSetupPlanSchema,
  },
  setup: {
    input: browserSetupRequestSchema,
    output: browserSetupResponseSchema,
  },
  disable: {
    input: browserLifecycleRequestSchema,
    output: browserLifecycleResponseSchema,
  },
  uninstall: {
    input: browserLifecycleRequestSchema,
    output: browserLifecycleResponseSchema,
  },
  purgePlan: {
    input: browserHostTargetSchema,
    output: browserPurgePlanSchema,
  },
  purge: {
    input: browserPurgeRequestSchema,
    output: browserPurgeResponseSchema,
  },
  browserScript: {
    input: browserScriptRequestSchema,
    output: browserScriptFailureSchema,
  },
});
