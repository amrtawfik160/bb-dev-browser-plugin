import { z } from "zod";

export const PANEL_SCREENSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const PANEL_SCREENSHOT_MAX_BASE64_LENGTH =
  4 * Math.ceil(PANEL_SCREENSHOT_MAX_BYTES / 3);
export const PANEL_SCREENSHOT_CHUNK_LENGTH = 256 * 1024;
export const PANEL_SCREENSHOT_MAX_PIXELS = 64 * 1024 * 1024;

/** Only these owner-facing failures may cross the panel boundary. */
export class PanelScreenshotCaptureError extends Error {}

export const panelScreenshotRequestSchema = z
  .object({
    type: z.literal("screenshot_request"),
    requestId: z.string().min(1).max(120),
    fullPage: z.boolean(),
  })
  .strict();

export const panelScreenshotChunkSchema = z
  .object({
    type: z.literal("screenshot_chunk"),
    requestId: z.string().min(1).max(120),
    index: z.number().int().nonnegative(),
    last: z.boolean(),
    data: z.string().min(1).max(PANEL_SCREENSHOT_CHUNK_LENGTH),
  })
  .strict();

export const panelScreenshotErrorSchema = z
  .object({
    type: z.literal("screenshot_error"),
    requestId: z.string().min(1).max(120),
    message: z.string().min(1).max(200),
  })
  .strict();

export type PanelScreenshotRequest = z.infer<
  typeof panelScreenshotRequestSchema
>;
