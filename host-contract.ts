import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
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
  browserScript: {
    input: browserScriptRequestSchema,
    output: browserScriptFailureSchema,
  },
});
