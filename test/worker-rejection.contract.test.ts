import { EventEmitter } from "node:events";
import { expect, it } from "vitest";

it("logs a dialog rejection and does not exit the worker", async () => {
  const { installWorkerRejectionGuard } = await import(
    "../src/host/worker-guard.js"
  );
  const logs: string[] = [];
  const exits: number[] = [];
  const emitter = new EventEmitter();
  installWorkerRejectionGuard(
    {
      on: emitter.on.bind(emitter),
      exit: (code?: number) => {
        exits.push(code ?? 0);
      },
    },
    (line) => logs.push(line),
  );
  emitter.emit("unhandledRejection", new Error("No dialog is showing"));
  expect(exits).toEqual([]);
  expect(logs.join("\n")).toContain("No dialog is showing");
});

it("installs that guard when the worker entry loads", async () => {
  const before = new Set(process.listeners("unhandledRejection"));
  await import("../src/host/host.js");
  const added = process
    .listeners("unhandledRejection")
    .filter((listener) => !before.has(listener));
  expect(added).toHaveLength(1);
  const lines: string[] = [];
  const original = console.error;
  console.error = (line?: unknown) => {
    lines.push(String(line));
  };
  try {
    added[0]?.(new Error("No dialog is showing"), Promise.resolve());
  } finally {
    console.error = original;
  }
  expect(lines.join("\n")).toContain("No dialog is showing");
});
