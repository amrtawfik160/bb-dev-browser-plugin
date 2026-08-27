import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  browserDiagnosticsSchema,
  browserActivityAcknowledgementRequestSchema,
  browserActivityAcknowledgementResponseSchema,
  browserActivityOutboxRequestSchema,
  browserActivityOutboxSchema,
  browserActivityReconciliationRequestSchema,
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
  browserProfileCreateRequestSchema,
  browserProfileHostTargetSchema,
  browserProfileInventorySchema,
  browserProfileRenameRequestSchema,
  browserProfileSchema,
  browserProfileSelectRequestSchema,
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
  activityOutbox: {
    input: browserActivityOutboxRequestSchema,
    output: browserActivityOutboxSchema,
  },
  acknowledgeActivity: {
    input: browserActivityAcknowledgementRequestSchema,
    output: browserActivityAcknowledgementResponseSchema,
  },
  reconcileActivity: {
    input: browserActivityReconciliationRequestSchema,
    output: browserActivityOutboxSchema,
  },
  listProfiles: {
    input: browserProfileHostTargetSchema,
    output: browserProfileInventorySchema,
  },
  createProfile: {
    input: browserProfileCreateRequestSchema,
    output: browserProfileSchema,
  },
  renameProfile: {
    input: browserProfileRenameRequestSchema,
    output: browserProfileSchema,
  },
  selectProfile: {
    input: browserProfileSelectRequestSchema,
    output: browserProfileInventorySchema,
  },
});
