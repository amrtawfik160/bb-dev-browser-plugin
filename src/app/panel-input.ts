import { useEffect, useRef, type RefObject } from "react";
import { PANEL_CLIENT_INPUT_MAX_PER_SECOND } from "../shared/contracts.js";

/**
 * Pointer moves and wheel deltas are sent at most this often. The stream shows
 * at most 15 frames a second, so a faster pace adds load without being seen.
 */
const CONTINUOUS_INPUT_INTERVAL_MS = 25;
const RATE_WINDOW_MS = 1_000;

type WheelInput = {
  kind: "wheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers: number;
};

export type InputPacerOptions = {
  send: (payload: unknown) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  maxPerSecond?: number;
};

/**
 * Pace page input below the host's per-second limit. Pointer moves keep only
 * the latest position and wheel events add their deltas together, so a fast
 * trackpad flick arrives as a few messages that still scroll the full
 * distance. Clicks, keys, and text are never delayed or dropped; a click
 * sends any pending move or scroll first so the page sees them in order.
 */
export function createInputPacer(options: InputPacerOptions) {
  const now = options.now ?? (() => performance.now());
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const maxPerSecond =
    options.maxPerSecond ?? PANEL_CLIENT_INPUT_MAX_PER_SECOND;
  const sentAt: number[] = [];
  let pendingMove: unknown = null;
  let pendingWheel: WheelInput | null = null;
  let lastContinuousAt = -Infinity;
  let timer: unknown;

  function emit(payload: unknown, at: number) {
    sentAt.push(at);
    options.send(payload);
  }

  function pendingCount() {
    return Number(pendingMove !== null) + Number(pendingWheel !== null);
  }

  function flushPending(at: number) {
    if (pendingCount() === 0) return;
    if (pendingMove !== null) emit(pendingMove, at);
    if (pendingWheel !== null) emit(pendingWheel, at);
    pendingMove = null;
    pendingWheel = null;
    lastContinuousAt = at;
  }

  /** Milliseconds until the pending input fits both the pace and the cap. */
  function delayUntilRoom(at: number) {
    while (sentAt.length > 0 && at - sentAt[0]! >= RATE_WINDOW_MS)
      sentAt.shift();
    const paced = lastContinuousAt + CONTINUOUS_INPUT_INTERVAL_MS - at;
    const over = sentAt.length + pendingCount() - maxPerSecond;
    const capped = over <= 0 ? 0 : sentAt[over - 1]! + RATE_WINDOW_MS - at;
    return Math.max(0, paced, capped);
  }

  function schedule() {
    if (timer !== undefined) return;
    const at = now();
    const delay = delayUntilRoom(at);
    if (delay === 0) {
      flushPending(at);
      return;
    }
    timer = setTimer(() => {
      timer = undefined;
      schedule();
    }, delay);
  }

  function cancelTimer() {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }

  return {
    move(payload: unknown) {
      pendingMove = payload;
      schedule();
    },
    wheel(payload: WheelInput) {
      if (
        pendingWheel !== null &&
        pendingWheel.modifiers !== payload.modifiers
      ) {
        // A modifier changes what scrolling means (zoom, horizontal), so the
        // earlier deltas go out on their own.
        cancelTimer();
        flushPending(now());
      }
      pendingWheel =
        pendingWheel === null
          ? payload
          : {
              ...payload,
              deltaX: pendingWheel.deltaX + payload.deltaX,
              deltaY: pendingWheel.deltaY + payload.deltaY,
            };
      schedule();
    },
    /** Press or release: any pending move or scroll lands first. */
    button(payload: unknown) {
      cancelTimer();
      const at = now();
      flushPending(at);
      emit(payload, at);
    },
    /**
     * Keys and text go out at once. They do not depend on where the pointer
     * is, so pending moves and scrolls keep their pace instead of being
     * flushed early on every keystroke.
     */
    key(payload: unknown) {
      emit(payload, now());
    },
    dispose() {
      cancelTimer();
      flushPending(now());
    },
  };
}

type Modifiers = {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

function modifiers(event: Modifiers) {
  return (
    Number(event.altKey) |
    (Number(event.ctrlKey) << 1) |
    (Number(event.metaKey) << 2) |
    (Number(event.shiftKey) << 3)
  );
}

/** Match object-contain, including the empty margins around the page. */
export function browserPagePoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
) {
  const rect = canvas.getBoundingClientRect();
  const width = Number(canvas.dataset.viewportWidth) || canvas.width;
  const height = Number(canvas.dataset.viewportHeight) || canvas.height;
  const scale = Math.min(rect.width / width, rect.height / height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x = (clientX - rect.left - (rect.width - width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - height * scale) / 2) / scale;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x, y, scale };
}

function keyPayload(event: KeyboardEvent, action: "keyDown" | "keyUp") {
  const text =
    action === "keyDown" &&
    !event.isComposing &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.key.length === 1
      ? event.key
      : undefined;
  return {
    kind: "key",
    action,
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode: event.keyCode,
    modifiers: modifiers(event),
    autoRepeat: event.repeat,
    ...(text === undefined ? {} : { text }),
  };
}

export function useBrowserPageInput(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  textInputRef: RefObject<HTMLTextAreaElement | null>,
  enabled: boolean,
  send: (payload: unknown) => void,
) {
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const element = canvasRef.current;
    const inputElement = textInputRef.current;
    if (element === null || inputElement === null || !enabled) return;
    const canvas = element;
    const textInput = inputElement;
    const keys = new Map<string, KeyboardEvent>();
    let heldMouse: ReturnType<typeof mousePayload> | null = null;
    const pacer = createInputPacer({
      send: (payload) => sendRef.current(payload),
    });

    function mousePayload(event: MouseEvent, action: string) {
      const point = browserPagePoint(canvas, event.clientX, event.clientY);
      if (point === null) return null;
      return {
        kind: "mouse",
        action,
        x: point.x,
        y: point.y,
        button:
          ["left", "middle", "right", "back", "forward"][event.button] ??
          "none",
        buttons: event.buttons,
        count:
          action === "mouseMoved" ? 0 : Math.min(3, Math.max(1, event.detail)),
        modifiers: modifiers(event),
      };
    }
    function mouseDown(event: MouseEvent) {
      const payload = mousePayload(event, "mousePressed");
      if (payload === null) return;
      event.preventDefault();
      textInput.focus({ preventScroll: true });
      heldMouse = payload;
      pacer.button(payload);
    }
    function mouseUp(event: MouseEvent) {
      if (heldMouse === null) return;
      pacer.button(
        mousePayload(event, "mouseReleased") ?? {
          ...heldMouse,
          action: "mouseReleased",
          buttons: 0,
        },
      );
      heldMouse = null;
    }
    function mouseMove(event: MouseEvent) {
      const payload = mousePayload(event, "mouseMoved");
      if (payload !== null) pacer.move(payload);
    }
    function wheel(event: WheelEvent) {
      const point = browserPagePoint(canvas, event.clientX, event.clientY);
      if (point === null) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? Number(canvas.dataset.viewportHeight) || canvas.height
            : 1 / point.scale;
      pacer.wheel({
        kind: "wheel",
        x: point.x,
        y: point.y,
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        modifiers: modifiers(event),
      });
    }
    function keyDown(event: KeyboardEvent) {
      // The focused page owns its shortcuts. Letting modified keys bubble
      // can run BB's panel-toggle/close commands and remove the input surface.
      event.stopPropagation();
      if (event.isComposing || event.key === "Process") return;
      // Escape back to BB without trapping the owner inside a pixel surface.
      if (event.key === "Escape" && event.shiftKey) {
        event.preventDefault();
        textInput.blur();
        return;
      }
      // Keep the native clipboard paste event, but keep the shortcut inside
      // this surface. The paste handler sends the clipboard text once.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "v"
      )
        return;
      event.preventDefault();
      keys.set(event.code || event.key, event);
      pacer.key(keyPayload(event, "keyDown"));
    }
    function keyUp(event: KeyboardEvent) {
      event.stopPropagation();
      if (!keys.delete(event.code || event.key)) return;
      event.preventDefault();
      pacer.key(keyPayload(event, "keyUp"));
    }
    function releaseInput() {
      for (const event of keys.values()) pacer.key(keyPayload(event, "keyUp"));
      keys.clear();
      if (heldMouse !== null)
        pacer.button({ ...heldMouse, action: "mouseReleased", buttons: 0 });
      heldMouse = null;
    }
    function compositionEnd(event: CompositionEvent) {
      if (event.data !== "") pacer.key({ kind: "text", text: event.data });
      textInput.value = "";
    }
    function focusTextInput() {
      textInput.focus({ preventScroll: true });
    }
    function paste(event: ClipboardEvent) {
      event.stopPropagation();
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      pacer.key({ kind: "text", text });
    }
    canvas.addEventListener("focus", focusTextInput);
    window.addEventListener("blur", releaseInput);
    canvas.addEventListener("mousedown", mouseDown);
    canvas.addEventListener("mousemove", mouseMove);
    window.addEventListener("mouseup", mouseUp);
    canvas.addEventListener("wheel", wheel, { passive: false });
    textInput.addEventListener("keydown", keyDown);
    textInput.addEventListener("keyup", keyUp);
    textInput.addEventListener("blur", releaseInput);
    textInput.addEventListener("compositionend", compositionEnd);
    textInput.addEventListener("paste", paste);
    return () => {
      releaseInput();
      pacer.dispose();
      textInput.value = "";
      canvas.removeEventListener("focus", focusTextInput);
      window.removeEventListener("blur", releaseInput);
      canvas.removeEventListener("mousedown", mouseDown);
      canvas.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("mouseup", mouseUp);
      canvas.removeEventListener("wheel", wheel);
      textInput.removeEventListener("keydown", keyDown);
      textInput.removeEventListener("keyup", keyUp);
      textInput.removeEventListener("blur", releaseInput);
      textInput.removeEventListener("compositionend", compositionEnd);
      textInput.removeEventListener("paste", paste);
    };
  }, [canvasRef, textInputRef, enabled]);
}
