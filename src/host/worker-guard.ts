const installed = new WeakSet<object>();

type RejectionHost = {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  exit?: (code?: number) => void;
};

/**
 * A rejected dialog dismiss used to end the whole plugin worker.
 * Logging the rejection keeps every other in-flight call alive.
 */
export function installWorkerRejectionGuard(
  host: RejectionHost,
  log: (line: string) => void = (line) => {
    console.error(line);
  },
) {
  if (installed.has(host)) return;
  installed.add(host);
  host.on("unhandledRejection", (reason: unknown) => {
    const detail =
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason);
    log(`Browser worker kept running after an unhandled rejection: ${detail}`);
  });
}
