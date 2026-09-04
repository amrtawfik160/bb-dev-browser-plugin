import { useEffect, useRef, type RefObject } from "react";
import { isBbGlobalShortcut } from "./panel-chrome.js";

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
  const scale = Math.min(
    rect.width / canvas.width,
    rect.height / canvas.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x =
    (clientX - rect.left - (rect.width - canvas.width * scale) / 2) / scale;
  const y =
    (clientY - rect.top - (rect.height - canvas.height * scale) / 2) / scale;
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  return { x, y, scale };
}

function keyPayload(event: KeyboardEvent, action: "keyDown" | "keyUp") {
  const text =
    action === "keyDown" && !event.isComposing && event.key.length === 1
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
    let lastMove = 0;
    const emit = (payload: unknown) => sendRef.current(payload);

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
      emit(payload);
    }
    function mouseUp(event: MouseEvent) {
      if (heldMouse === null) return;
      emit(
        mousePayload(event, "mouseReleased") ?? {
          ...heldMouse,
          action: "mouseReleased",
          buttons: 0,
        },
      );
      heldMouse = null;
    }
    function mouseMove(event: MouseEvent) {
      if (event.timeStamp - lastMove < 16) return;
      lastMove = event.timeStamp;
      const payload = mousePayload(event, "mouseMoved");
      if (payload !== null) emit(payload);
    }
    function wheel(event: WheelEvent) {
      const point = browserPagePoint(canvas, event.clientX, event.clientY);
      if (point === null) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? canvas.height
            : 1 / point.scale;
      emit({
        kind: "wheel",
        x: point.x,
        y: point.y,
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        modifiers: modifiers(event),
      });
    }
    function keyDown(event: KeyboardEvent) {
      if (
        isBbGlobalShortcut(event) ||
        event.isComposing ||
        event.key === "Process"
      )
        return;
      // Escape back to BB without trapping the owner inside a pixel surface.
      if (event.key === "Escape" && event.shiftKey) {
        textInput.blur();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      keys.set(event.code || event.key, event);
      emit(keyPayload(event, "keyDown"));
    }
    function keyUp(event: KeyboardEvent) {
      if (!keys.delete(event.code || event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      emit(keyPayload(event, "keyUp"));
    }
    function releaseInput() {
      for (const event of keys.values()) emit(keyPayload(event, "keyUp"));
      keys.clear();
      if (heldMouse !== null)
        emit({ ...heldMouse, action: "mouseReleased", buttons: 0 });
      heldMouse = null;
    }
    function compositionEnd(event: CompositionEvent) {
      if (event.data !== "") emit({ kind: "text", text: event.data });
      textInput.value = "";
    }
    function focusTextInput() {
      textInput.focus({ preventScroll: true });
    }
    function paste(event: ClipboardEvent) {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      emit({ kind: "text", text });
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
