/**
 * Slice 51-02 (L2 test-system) — the runner's judgment-free `expect` core.
 *
 * The runner is a DUMB executor: for an `expect` step it polls the named shipped
 * surface until a structural match / substring / cross-surface equality holds, or
 * the `within` bound elapses — at which point it emits an expected-vs-last-observed
 * DIFF and FAILS the scenario (proof item 3, failure honesty). Zero heuristics,
 * zero "does it look right" judgment (that is L3, via agents, never the runner).
 *
 * `within` is the ONLY time dependence and it is a poll BOUND, never an assertion
 * input. The clock + sleep are injected so the loop is deterministic under test.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The `match` mode: is `expected` a deep structural SUBSET of `actual`?
 * - objects: every expected key exists in actual and subset-matches;
 * - arrays: every expected element subset-matches SOME actual element (contains
 *   semantics — a bare-array surface like `queue` "has an item shaped like X");
 * - primitives: strict equality.
 */
export function structuralSubsetMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((exp) => actual.some((act) => structuralSubsetMatch(act, exp)));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every(
      (k) => k in actual && structuralSubsetMatch(actual[k], expected[k]),
    );
  }
  return actual === expected;
}

/** The `contains` mode: substring match over a string surface (pane/transcript). */
export function containsMatch(actual: unknown, needle: string): boolean {
  return typeof actual === "string" && actual.includes(needle);
}

/** Render a readable expected-vs-observed DIFF for a failed assertion. */
export function formatDiff(expected: unknown, lastObserved: unknown): string {
  const j = (v: unknown) => {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  };
  return `assertion unmet within bound\n  expected: ${j(expected)}\n  observed (last): ${j(lastObserved)}`;
}

export interface PollUntilMatchOptions {
  /** Read the shipped surface once (async — a real CLI/socket read). */
  observe: () => Promise<unknown>;
  /** Does the observed value satisfy the assertion? */
  predicate: (observed: unknown) => boolean;
  /** The expected value, carried ONLY to render the DIFF on timeout. */
  expected?: unknown;
  /** Poll bound in ms (the `within` duration, resolved to ms by the runner). */
  withinMs: number;
  /** Interval between polls in ms. */
  pollIntervalMs: number;
  /** Injected monotonic clock (ms). */
  now: () => number;
  /** Injected sleep. */
  sleep: (ms: number) => Promise<void>;
}

export type PollResult =
  | { ok: true; lastObserved: unknown }
  | { ok: false; lastObserved: unknown; diff: string };

/**
 * Poll `observe` until `predicate` holds or `withinMs` elapses. Polls at least
 * once (so a zero bound still yields an honest last-observed). On timeout returns
 * the last observed value and a DIFF. Deterministic under the injected clock/sleep.
 */
export async function pollUntilMatch(opts: PollUntilMatchOptions): Promise<PollResult> {
  const { observe, predicate, expected, withinMs, pollIntervalMs, now, sleep } = opts;
  const start = now();
  let lastObserved: unknown;
  for (;;) {
    lastObserved = await observe();
    if (predicate(lastObserved)) return { ok: true, lastObserved };
    if (now() - start >= withinMs) {
      return { ok: false, lastObserved, diff: formatDiff(expected, lastObserved) };
    }
    await sleep(pollIntervalMs);
  }
}
