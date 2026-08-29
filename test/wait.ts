/**
 * Deterministic async-waiting helpers for the contract test suites.
 *
 * The transport/screencast contract tests drive real loopback WebSockets and
 * an async screencast source. Earlier revisions used tight fixed waits
 * (e.g. 20/50 ms `setTimeout`) before asserting an event arrived, which
 * intermittently missed the event under full-suite load. These helpers poll
 * for the real event/signal with a bounded timeout instead, so the suite is
 * deterministic without retrying (issue #23, S2).
 */

/**
 * Poll a predicate until it returns a truthy value, resolving with that value.
 * Rejects if the predicate stays falsy past `timeoutMs` (the event never came).
 */
export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 2_000, intervalMs = 5 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value as T;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Assert a predicate stays true for a bounded settling window. Use for
 * no-op/drop assertions where the transport sends no ack and produces no side
 * effect: a broken drop would flip the predicate false (failing fast), while a
 * correct drop keeps it true through the window. Unlike a blind fixed wait,
 * this fails the instant an unwanted side effect lands rather than after it.
 */
export async function waitForSettled(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 100, intervalMs = 5 } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!predicate()) {
      throw new Error("waitForSettled: predicate became false while settling");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
