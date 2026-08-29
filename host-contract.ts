import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  browserDiagnosticsSchema,
  browserHostTargetSchema,
  browserScriptFailureSchema,
  browserScriptRequestSchema,
} from "./contracts.js";
import { browserStatusSchema } from "./contracts.js";

export const browserHostContract = defineRpcContract({
  status: {
    input: browserHostTargetSchema,
    output: browserStatusSchema,
  },
  diagnostics: {
    input: browserHostTargetSchema,
    output: browserDiagnosticsSchema,
  },
  browserScript: {
    input: browserScriptRequestSchema,
    output: browserScriptFailureSchema,
  },
});
