import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  browserDiagnosticsSchema,
  browserActivityAcknowledgementRequestSchema,
  browserActivityAcknowledgementResponseSchema,
  browserActivityOutboxRequestSchema,
  browserActivityOutboxSchema,
  browserActivityReconciliationRequestSchema,
  browserHostTargetSchema,
  browserHostConnectionRequestSchema,
  browserHostConnectionResponseSchema,
  browserServerFactsRequestSchema,
  browserServerFactsResponseSchema,
  browserLifecycleRequestSchema,
  browserLifecycleResponseSchema,
  browserPurgePlanSchema,
  browserPurgeRequestSchema,
  browserPurgeResponseSchema,
  browserSetupPlanSchema,
  browserSetupRequestSchema,
  browserSetupResponseSchema,
  browserScriptResponseSchema,
  browserScriptRequestSchema,
  browserAxiRequestSchema,
  browserAxiResponseSchema,
  browserNavigationRequestSchema,
  browserHistoryRequestSchema,
  browserNavigationResponseSchema,
  browserHostPanelVisibilityRequestSchema,
  browserPanelTransportRequestSchema,
  browserPanelTransportResponseSchema,
  browserPanelReleaseHostRequestSchema,
  browserPanelReleaseHostResponseSchema,
  browserTabsRequestSchema,
  browserTabActionRequestSchema,
  browserTabStripSchema,
  browserPanelControlRequestSchema,
  browserPanelControlResponseSchema,
  browserPanelTakeControlRequestSchema,
  browserPanelReclaimControlRequestSchema,
  browserHostReleaseControlRequestSchema,
  browserProfileCreateRequestSchema,
  browserScopedProfileRequestSchema,
  browserProfileDeleteRequestSchema,
  browserProfileExpiryResponseSchema,
  browserProfileBackupRequestSchema,
  browserProfileHostTargetSchema,
  browserProfileImportRequestSchema,
  browserProfileInventorySchema,
  browserProfileLifecycleResponseSchema,
  browserProfileRenameRequestSchema,
  browserProfileResetRequestSchema,
  browserProfileRecoveryResponseSchema,
  browserProfileRestoreRequestSchema,
  browserProfileSchema,
  browserProfileSelectRequestSchema,
  browserProfileTargetSchema,
  browserSessionSiteUpdateSchema,
  browserStatusSchema,
  browserTransferStageInputSchema,
  browserTransferConsumeInputSchema,
  browserTransferStagingResponseSchema,
  browserTransferOutcomeSchema,
  browserTransferReleaseInputSchema,
  browserTransferReleaseOutcomeSchema,
  browserTransferCancelInputSchema,
  browserTransferCancelOutcomeSchema,
  browserTransferProgressInputSchema,
  browserTransferProgressResultSchema,
  browserControlLeaseStateInputSchema,
  browserControlLeaseStateSchema,
  browserDownloadStartInputSchema,
  browserDownloadStartResponseSchema,
  browserDownloadAppendInputSchema,
  browserDownloadAppendOutcomeSchema,
  browserDownloadCompleteInputSchema,
  browserDownloadCompleteOutcomeSchema,
  browserDownloadFailInputSchema,
  browserDownloadFailOutcomeSchema,
  browserDownloadCancelInputSchema,
  browserDownloadCancelOutcomeSchema,
  browserDownloadListInputSchema,
  browserDownloadListResultSchema,
  browserDownloadLimitsInputSchema,
  browserDownloadLimitsSchema,
  browserDownloadTargetInputSchema,
  browserDownloadProgressResultSchema,
  browserDownloadExportClientInputSchema,
  browserDownloadExportWorkspaceInputSchema,
  browserDownloadExportOutcomeSchema,
  browserDownloadPurgeInputSchema,
  browserDownloadPurgeOutcomeSchema,
} from "./contracts.js";

/**
 * Sleeping stops a Browser Instance without touching its profile: storage,
 * restorable tab locations, and grants survive, and the next use wakes it.
 */
export const browserProfileSleepResponseSchema = z
  .object({ outcome: z.enum(["slept", "not-running"]) })
  .strict();

export type BrowserProfileSleepResponse = z.infer<
  typeof browserProfileSleepResponseSchema
>;

export const browserHostContract = defineRpcContract({
  hostConnection: {
    input: browserHostConnectionRequestSchema,
    output: browserHostConnectionResponseSchema,
  },
  serverFacts: {
    input: browserServerFactsRequestSchema,
    output: browserServerFactsResponseSchema,
  },
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
  browserAxi: {
    input: browserAxiRequestSchema,
    output: browserAxiResponseSchema,
  },
  browserScript: {
    input: browserScriptRequestSchema,
    output: browserScriptResponseSchema,
  },
  navigate: {
    input: browserNavigationRequestSchema,
    output: browserNavigationResponseSchema,
  },
  history: {
    input: browserHistoryRequestSchema,
    output: browserNavigationResponseSchema,
  },
  panelVisibility: {
    input: browserHostPanelVisibilityRequestSchema,
    output: browserStatusSchema,
  },
  panelTransport: {
    input: browserPanelTransportRequestSchema,
    output: browserPanelTransportResponseSchema,
  },
  panelRelease: {
    input: browserPanelReleaseHostRequestSchema,
    output: browserPanelReleaseHostResponseSchema,
  },
  tabs: {
    input: browserTabsRequestSchema,
    output: browserTabStripSchema,
  },
  tabAction: {
    input: browserTabActionRequestSchema,
    output: browserTabStripSchema,
  },
  panelControl: {
    input: browserPanelControlRequestSchema,
    output: browserPanelControlResponseSchema,
  },
  takeControl: {
    input: browserPanelTakeControlRequestSchema,
    output: browserPanelControlResponseSchema,
  },
  reclaimControl: {
    input: browserPanelReclaimControlRequestSchema,
    output: browserPanelControlResponseSchema,
  },
  releaseControl: {
    input: browserHostReleaseControlRequestSchema,
    output: browserPanelControlResponseSchema,
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
  ensureScopedProfile: {
    input: browserScopedProfileRequestSchema,
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
  recordSessionSite: {
    input: browserSessionSiteUpdateSchema,
    output: browserProfileSchema,
  },
  archiveProfile: {
    input: browserProfileTargetSchema,
    output: browserProfileLifecycleResponseSchema,
  },
  archiveUnsavedProfile: {
    input: browserProfileTargetSchema,
    output: browserProfileLifecycleResponseSchema.nullable(),
  },
  restoreArchivedProfile: {
    input: browserProfileTargetSchema,
    output: browserProfileLifecycleResponseSchema,
  },
  sleepProfile: {
    input: browserProfileTargetSchema,
    output: browserProfileSleepResponseSchema,
  },
  resetProfile: {
    input: browserProfileResetRequestSchema,
    output: browserProfileLifecycleResponseSchema,
  },
  deleteProfile: {
    input: browserProfileDeleteRequestSchema,
    output: browserProfileLifecycleResponseSchema,
  },
  expireArchivedProfiles: {
    input: browserProfileHostTargetSchema,
    output: browserProfileExpiryResponseSchema,
  },
  backupProfile: {
    input: browserProfileBackupRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  restoreProfile: {
    input: browserProfileRestoreRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  importProfile: {
    input: browserProfileImportRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  transferStage: {
    input: browserTransferStageInputSchema,
    output: browserTransferStagingResponseSchema,
  },
  transferConsume: {
    input: browserTransferConsumeInputSchema,
    output: browserTransferOutcomeSchema,
  },
  transferRelease: {
    input: browserTransferReleaseInputSchema,
    output: browserTransferReleaseOutcomeSchema,
  },
  transferCancel: {
    input: browserTransferCancelInputSchema,
    output: browserTransferCancelOutcomeSchema,
  },
  transferProgress: {
    input: browserTransferProgressInputSchema,
    output: browserTransferProgressResultSchema,
  },
  controlLeaseState: {
    input: browserControlLeaseStateInputSchema,
    output: browserControlLeaseStateSchema,
  },
  downloadStart: {
    input: browserDownloadStartInputSchema,
    output: browserDownloadStartResponseSchema,
  },
  downloadAppend: {
    input: browserDownloadAppendInputSchema,
    output: browserDownloadAppendOutcomeSchema,
  },
  downloadComplete: {
    input: browserDownloadCompleteInputSchema,
    output: browserDownloadCompleteOutcomeSchema,
  },
  downloadFail: {
    input: browserDownloadFailInputSchema,
    output: browserDownloadFailOutcomeSchema,
  },
  downloadCancel: {
    input: browserDownloadCancelInputSchema,
    output: browserDownloadCancelOutcomeSchema,
  },
  downloadList: {
    input: browserDownloadListInputSchema,
    output: browserDownloadListResultSchema,
  },
  downloadLimits: {
    input: browserDownloadLimitsInputSchema,
    output: browserDownloadLimitsSchema,
  },
  downloadProgress: {
    input: browserDownloadTargetInputSchema,
    output: browserDownloadProgressResultSchema,
  },
  downloadExportClient: {
    input: browserDownloadExportClientInputSchema,
    output: browserDownloadExportOutcomeSchema,
  },
  downloadExportWorkspace: {
    input: browserDownloadExportWorkspaceInputSchema,
    output: browserDownloadExportOutcomeSchema,
  },
  downloadPurge: {
    input: browserDownloadPurgeInputSchema,
    output: browserDownloadPurgeOutcomeSchema,
  },
});
