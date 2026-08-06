/**
 * Slice 51-02 (L2 test-system) — the runner CORE (dumb executor).
 *
 * Executes a VALIDATED scenario's steps in order: action verbs via the injected
 * `runAction` (a shipped `rig` write/lifecycle call), `expect` via poll-until-match
 * over the injected `observe` (a shipped surface read). On the first failed step it
 * emits an expected-vs-last-observed DIFF, appends a FAIL run-record row, and stops.
 * All steps pass → PASS + a PASS row. Zero judgment, zero heuristics — determinism
 * judges everything observable (agent judgment is L3, never here).
 *
 * Dependencies are injected so the orchestration is unit-testable without a live
 * daemon; the real wiring supplies runRig/readSurface + the scenario-local clock.
 */

import type { ExpectSurface, ValidatedScenario } from "./scenario-schema.js";
import { structuralSubsetMatch, containsMatch, pollUntilMatch } from "./scenario-expect.js";
import type { RunRecord } from "./scenario-run-record.js";

export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ScenarioRunnerDeps {
  /** Run an action verb (up/down/send/restart/restore/emit/mutate/policy/seed_regression/daemon). */
  runAction: (verb: string, payload: unknown, seat?: string) => Promise<ActionResult>;
  /** Read a shipped surface for an `expect`. */
  observe: (surface: ExpectSurface, opts: { seat?: string }) => Promise<unknown>;
  /** Injected monotonic clock (ms) for the poll bound. */
  now: () => number;
  /** Injected sleep between polls. */
  sleep: (ms: number) => Promise<void>;
  /** Optional run-record sink (append-only ledger). */
  appendRecord?: (rec: RunRecord) => void;
  /** The single default within/poll pair (overridable per-expect). */
  defaults: { withinMs: number; pollIntervalMs: number };
  /**
   * Declarative cross-surface normalizer for the `equals` mode (its final shape
   * rides 51-03 shaping; v1 accepts the interface). Given a surface + its observed
   * value, return the normalized comparison form.
   */
  normalizer?: (surface: ExpectSurface, value: unknown) => unknown;
}

export interface RunScenarioResult {
  scenario: string;
  verdict: "PASS" | "FAIL";
  /** 0-based index of the failing step (FAIL only). */
  failedStep?: number;
  diff?: string;
}

const DURATION_RE = /^(\d+)(ms|s|m|h)?$/;

/** Parse a relative poll duration to milliseconds. Bare number = ms. */
export function parseDuration(d: string): number {
  const m = DURATION_RE.exec(d);
  if (!m) throw new Error(`invalid duration: ${JSON.stringify(d)}`);
  const n = Number(m[1]);
  switch (m[2] ?? "ms") {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    default: return n * 3_600_000; // h
  }
}

/** Run a validated scenario's steps. Returns PASS/FAIL and appends a run-record. */
export async function runValidatedScenario(
  scenario: ValidatedScenario,
  deps: ScenarioRunnerDeps,
): Promise<RunScenarioResult> {
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    const verb = Object.keys(step)[0]!;
    const value = step[verb];

    if (verb === "expect") {
      const failDiff = await runExpect(value as Record<string, unknown>, deps);
      if (failDiff !== null) return fail(scenario.scenario, i, failDiff, deps);
      continue;
    }

    // Action verb.
    const seat = typeof value === "string" ? value : (value as { seat?: string } | null)?.seat;
    const res = await deps.runAction(verb, value, seat);
    if (res.code !== 0) {
      return fail(scenario.scenario, i, `action \`${verb}\` failed (exit ${res.code}): ${res.stderr || res.stdout}`, deps);
    }
  }

  const rec: RunRecord = { scenario: scenario.scenario, verdict: "PASS" };
  deps.appendRecord?.(rec);
  return { scenario: scenario.scenario, verdict: "PASS" };
}

/** Execute one `expect`. Returns null on match, or the DIFF string on failure. */
async function runExpect(
  exp: Record<string, unknown>,
  deps: ScenarioRunnerDeps,
): Promise<string | null> {
  const surface = exp.surface as ExpectSurface;
  const seat = exp.seat as string | undefined;
  const withinMs = exp.within !== undefined ? parseDuration(String(exp.within)) : deps.defaults.withinMs;
  const pollIntervalMs = deps.defaults.pollIntervalMs;

  // `equals` compares MULTIPLE surfaces after normalization — a distinct shape.
  if ("equals" in exp) {
    return runEqualsExpect(exp.equals, { withinMs, pollIntervalMs }, deps);
  }

  const { predicate, expected } = buildSingleSurfacePredicate(exp);
  const res = await pollUntilMatch({
    observe: () => deps.observe(surface, { seat }),
    predicate,
    expected,
    withinMs,
    pollIntervalMs,
    now: deps.now,
    sleep: deps.sleep,
  });
  return res.ok ? null : res.diff;
}

function buildSingleSurfacePredicate(exp: Record<string, unknown>): {
  predicate: (o: unknown) => boolean;
  expected: unknown;
} {
  if ("match" in exp) {
    return { predicate: (o) => structuralSubsetMatch(o, exp.match), expected: exp.match };
  }
  if ("contains" in exp) {
    const needle = String(exp.contains);
    return { predicate: (o) => containsMatch(o, needle), expected: exp.contains };
  }
  // The validator guarantees exactly one match mode; this is unreachable.
  throw new Error("expect has no match mode");
}

/**
 * The `equals` cross-surface executor (declarative-normalizer interface). Reads
 * each named surface, normalizes it via the injected normalizer, and passes when
 * all normalized forms are deep-equal. The normalizer's final shape rides 51-03.
 */
async function runEqualsExpect(
  equalsPayload: unknown,
  bounds: { withinMs: number; pollIntervalMs: number },
  deps: ScenarioRunnerDeps,
): Promise<string | null> {
  const surfaces = extractEqualsSurfaces(equalsPayload);
  if (!deps.normalizer) {
    throw new Error(
      "`equals` requires a declarative cross-surface normalizer (its shape rides 51-03 shaping)",
    );
  }
  const normalizer = deps.normalizer;
  const observeAllEqual = async (): Promise<{ equal: boolean; snapshot: unknown[] }> => {
    const snapshot = await Promise.all(
      surfaces.map(async (s) => normalizer(s, await deps.observe(s, {}))),
    );
    const first = JSON.stringify(snapshot[0]);
    return { equal: snapshot.every((v) => JSON.stringify(v) === first), snapshot };
  };

  const start = deps.now();
  let last: unknown[] = [];
  for (;;) {
    const { equal, snapshot } = await observeAllEqual();
    last = snapshot;
    if (equal) return null;
    if (deps.now() - start >= bounds.withinMs) {
      return `cross-surface equality unmet for [${surfaces.join(", ")}]\n  normalized: ${JSON.stringify(last, null, 2)}`;
    }
    await deps.sleep(bounds.pollIntervalMs);
  }
}

function extractEqualsSurfaces(payload: unknown): ExpectSurface[] {
  if (Array.isArray(payload)) return payload as ExpectSurface[];
  if (payload && typeof payload === "object") return Object.keys(payload) as ExpectSurface[];
  throw new Error("`equals` payload must name the surfaces to compare");
}

function fail(
  scenario: string,
  failedStep: number,
  diff: string,
  deps: ScenarioRunnerDeps,
): RunScenarioResult {
  const rec: RunRecord = { scenario, verdict: "FAIL", failedStep, diff };
  deps.appendRecord?.(rec);
  return { scenario, verdict: "FAIL", failedStep, diff };
}
