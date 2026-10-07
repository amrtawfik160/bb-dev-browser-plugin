import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk/host";

/**
 * BB force-kills the whole host worker when a call it cancelled, at its
 * deadline or because the agent stopped, is still running five seconds later.
 * That orphans every Browser Instance and helper on the host. A cancelled call
 * therefore answers within a second; its work keeps running behind it and
 * still releases its own lease, processes, and Activity Record.
 */
const CANCELLED_CALL_ANSWER_MS = 1_000;

function cancelledCallError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("The Browser call was cancelled."), {
    name: "AbortError",
  });
}

export function answerPromptlyWhenCancelled<Result>(
  signal: AbortSignal,
  work: Promise<Result>,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let answerTimer: NodeJS.Timeout | undefined;
    const answerSoon = () => {
      answerTimer = setTimeout(
        () => reject(cancelledCallError(signal)),
        CANCELLED_CALL_ANSWER_MS,
      );
    };
    if (signal.aborted) answerSoon();
    else signal.addEventListener("abort", answerSoon, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(answerTimer);
      signal.removeEventListener("abort", answerSoon);
    });
  });
}

/**
 * Wraps every handler of a host contract; each method keeps its own request,
 * context, and result types, and only the answer timing on cancel changes.
 */
export function withPromptCancellation<Contract extends PluginRpcContract>(
  _contract: Contract,
  handlers: ExperimentalHostRpcHandlers<Contract>,
): ExperimentalHostRpcHandlers<Contract> {
  const guarded = { ...handlers };
  for (const method of Object.keys(handlers) as (keyof Contract)[]) {
    const handler = handlers[method];
    guarded[method] = (input, context) =>
      answerPromptlyWhenCancelled(
        context.signal,
        Promise.resolve().then(() => handler(input, context)),
      );
  }
  return guarded;
}
