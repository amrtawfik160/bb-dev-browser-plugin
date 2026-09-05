import { z } from "zod";

const modifiers = z.number().int().min(0).max(15).default(0);
const point = {
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  modifiers,
};
const browserInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mouse"),
      ...point,
      action: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
      button: z
        .enum(["none", "left", "middle", "right", "back", "forward"])
        .default("none"),
      buttons: z.number().int().min(0).max(31).default(0),
      count: z.number().int().min(0).max(3).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wheel"),
      ...point,
      deltaX: z.number().finite(),
      deltaY: z.number().finite(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("key"),
      action: z.enum(["keyDown", "keyUp"]),
      key: z.string().max(100),
      code: z.string().max(100).optional(),
      windowsVirtualKeyCode: z.number().int().min(0).max(65535).optional(),
      text: z.string().max(100).optional(),
      modifiers,
      autoRepeat: z.boolean().default(false),
    })
    .strict(),
  z
    .object({ kind: z.literal("text"), text: z.string().min(1).max(16384) })
    .strict(),
]);

export function browserInputCommand(payload: unknown) {
  const parsed = browserInputSchema.safeParse(payload);
  if (!parsed.success) return null;
  const input = parsed.data;
  switch (input.kind) {
    case "mouse": {
      return {
        method: "Input.dispatchMouseEvent",
        params: {
          type: input.action,
          x: input.x,
          y: input.y,
          button: input.button,
          buttons: input.buttons,
          clickCount: input.count,
          modifiers: input.modifiers,
        },
      };
    }
    case "key": {
      return {
        method: "Input.dispatchKeyEvent",
        params: {
          type: input.action,
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.windowsVirtualKeyCode,
          text:
            input.text ??
            (input.action === "keyDown" && input.key === "Enter"
              ? "\r"
              : undefined),
          modifiers: input.modifiers,
          autoRepeat: input.autoRepeat,
        },
      };
    }
    case "wheel": {
      return {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers,
        },
      };
    }
    case "text":
      return { method: "Input.insertText", params: { text: input.text } };
  }
}
