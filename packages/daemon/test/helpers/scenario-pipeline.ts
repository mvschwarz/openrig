/**
 * Slice 51-02 (L2 test-system) — the scenario PIPELINE (parse → validate → run).
 *
 * loadScenarioFile is the pure front: read a scenario YAML, resolve its `topology`
 * rig-spec path relative to the scenario file, validate the arch shape. I/O and
 * YAML-syntax failures throw a LOUD ScenarioLoadError; content problems return the
 * validator's error list (never a silent no-op).
 *
 * runScenarioFile is the heavy integration back: it spawns a forced-local
 * scenario-local daemon under a hermetic scaffold, wires the real-deps adapter,
 * runs the validated scenario against the SHIPPED `rig` CLI as real subprocesses,
 * and tears the daemon down. The `up` verb stands up runtime:stub seats in real
 * tmux, so this path is the product-is-truth e2e — reserved for the integration
 * suite, not the pure unit tests.
 */

import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  validateScenario,
  type ValidatedScenario,
  type ValidationError,
} from "./scenario-schema.js";
import { prepareHermeticEnv } from "./hermetic-env.js";
import { spawnScenarioDaemon, runRig as realRunRig, type RigResult } from "./scenario-daemon.js";
import { buildRealDeps, type RealDepsOptions } from "./scenario-real-deps.js";
import { runValidatedScenario, type RunScenarioResult } from "./scenario-runner.js";

/** Thrown when a scenario file cannot be read or parsed (loud I/O/syntax floor). */
export class ScenarioLoadError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`could not load scenario ${JSON.stringify(path)}: ${detail}`);
    this.name = "ScenarioLoadError";
    this.path = path;
  }
}

/** Thrown when an `env` precondition (the fixture-level baton setup) fails. */
export class ScenarioPreconditionError extends Error {
  constructor(detail: string) {
    super(`scenario precondition failed: ${detail}`);
    this.name = "ScenarioPreconditionError";
  }
}

/**
 * A queue-baton precondition (fixture level). The scenario asserts observables;
 * `env.queue` establishes a claimed baton via the SHIPPED `rig queue create|claim`
 * writes BEFORE the steps run — there is no queue action verb, so the baton lives
 * outside the scenario grammar (per the locked verb set), visibly documented in
 * the scenario file. Queue state is daemon-side, independent of any seat process.
 */
export interface QueuePrecondition {
  id: string;
  source: string;
  destination: string;
  summary?: string;
  body?: string;
  /** Claim the created qitem so it lands in-progress + owned by `destination`. */
  claim?: boolean;
}

/** Extract + shape-check the `env.queue` preconditions (loud on a malformed entry). */
export function extractQueuePreconditions(env: Record<string, unknown> | undefined): QueuePrecondition[] {
  const q = env?.queue;
  if (q === undefined) return [];
  if (!Array.isArray(q)) {
    throw new ScenarioPreconditionError("env.queue must be a list of {id, source, destination, claim?} entries");
  }
  return q.map((raw, i) => {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    for (const key of ["id", "source", "destination"] as const) {
      if (typeof e[key] !== "string" || (e[key] as string).length === 0) {
        throw new ScenarioPreconditionError(`env.queue[${i}].${key} is required (non-empty string)`);
      }
    }
    return {
      id: e.id as string,
      source: e.source as string,
      destination: e.destination as string,
      summary: typeof e.summary === "string" ? e.summary : undefined,
      body: typeof e.body === "string" ? e.body : undefined,
      claim: e.claim === true,
    };
  });
}

export interface PreconditionContext {
  rigBin: string;
  readEnv: Record<string, string | undefined>;
  /** Injected `rig` runner (defaults to the real subprocess runner; tests inject a spy). */
  runRig?: (
    args: string[],
    env: Record<string, string | undefined>,
    rigBin: string,
    timeoutMs?: number,
  ) => Promise<RigResult>;
}

/** Apply the queue-baton preconditions via shipped `rig queue` writes. Fail-closed. */
export async function applyQueuePreconditions(
  preconditions: QueuePrecondition[],
  ctx: PreconditionContext,
): Promise<void> {
  const runRig = ctx.runRig ?? realRunRig;
  for (const p of preconditions) {
    const create = await runRig(
      ["queue", "create", "--id", p.id, "--source", p.source, "--destination", p.destination,
        "--summary", p.summary ?? p.id, "--body", p.body ?? `51-02 precondition baton ${p.id}`, "--json"],
      ctx.readEnv, ctx.rigBin,
    );
    if (create.code !== 0) {
      throw new ScenarioPreconditionError(`queue create ${p.id} (exit ${create.code}): ${create.stderr || create.stdout}`);
    }
    if (p.claim) {
      const claim = await runRig(
        ["queue", "claim", p.id, "--destination", p.destination, "--json"],
        ctx.readEnv, ctx.rigBin,
      );
      if (claim.code !== 0) {
        throw new ScenarioPreconditionError(`queue claim ${p.id} (exit ${claim.code}): ${claim.stderr || claim.stdout}`);
      }
    }
  }
}

export interface LoadedScenario {
  scenario: ValidatedScenario;
  /** Absolute rig-spec path, resolved relative to the scenario file's directory. */
  topologyPath: string;
}

export type LoadScenarioResult =
  | { ok: true; loaded: LoadedScenario }
  | { ok: false; errors: ValidationError[] };

export interface LoadScenarioOptions {
  topologyKind?: "stub" | "real";
}

/** Read + parse + validate a scenario file. Throws ScenarioLoadError on I/O/YAML failure. */
export function loadScenarioFile(path: string, opts: LoadScenarioOptions = {}): LoadScenarioResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ScenarioLoadError(path, `read failed: ${(err as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new ScenarioLoadError(path, `YAML parse failed: ${(err as Error).message}`);
  }

  const result = validateScenario(doc, { topologyKind: opts.topologyKind });
  if (!result.ok) return { ok: false, errors: result.errors };

  const topologyPath = resolve(dirname(path), result.scenario.topology);
  return { ok: true, loaded: { scenario: result.scenario, topologyPath } };
}

export interface RunScenarioFileOptions {
  /** Path to the shipped `rig` bin (the single 51-04 invocation seam). */
  rigBin: string;
  topologyKind?: "stub" | "real";
  /** Base environment for the hermetic scaffold (HOME/PATH/TERM). */
  baseEnv?: Record<string, string | undefined>;
  /** Overrides forwarded to buildRealDeps (clock/sleep/appendRecord/defaults/normalizer). */
  deps?: Partial<Pick<RealDepsOptions, "now" | "sleep" | "appendRecord" | "defaults" | "normalizer">>;
}

/**
 * Full e2e: load a scenario, spawn a forced-local scenario-local daemon, run the
 * validated scenario against the shipped `rig` CLI, and tear down. Throws
 * ScenarioLoadError (I/O/YAML) or an aggregated validation error before any spawn.
 */
export async function runScenarioFile(
  path: string,
  opts: RunScenarioFileOptions,
): Promise<RunScenarioResult> {
  const loaded = loadScenarioFile(path, { topologyKind: opts.topologyKind });
  if (!loaded.ok) {
    throw new ScenarioLoadError(path, `validation failed:\n  ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join("\n  ")}`);
  }

  const preconditions = extractQueuePreconditions(loaded.loaded.scenario.env);
  const scaffold = prepareHermeticEnv(opts.baseEnv ? { baseEnv: opts.baseEnv } : {});
  // Seats launch with cwd under the scaffold so their managed writes (AGENTS.md,
  // the stub sidecar) stay in scratch and never pollute the launch cwd.
  const seatCwd = join(scaffold.root, "seat-cwd");
  mkdirSync(seatCwd, { recursive: true });
  const daemon = await spawnScenarioDaemon(scaffold, { rigBin: opts.rigBin });
  try {
    const baseDeps = buildRealDeps({
      daemon,
      rigBin: opts.rigBin,
      topologyPath: loaded.loaded.topologyPath,
      seatCwd,
      ...opts.deps,
    });

    // Fixture-level preconditions (the baton) are applied RIGHT AFTER the topology
    // is up: `rig queue create` rejects a destination whose rig is not yet up
    // (unknown_destination_rig), so the baton cannot precede `up`. It is still setup,
    // not an asserted observable — visibly declared in the scenario `env` block.
    let batonApplied = preconditions.length === 0;
    const runAction: typeof baseDeps.runAction = async (verb, payload, seat) => {
      const res = await baseDeps.runAction(verb, payload, seat);
      if (!batonApplied && verb === "up" && res.code === 0) {
        batonApplied = true;
        await applyQueuePreconditions(preconditions, { rigBin: opts.rigBin, readEnv: daemon.readEnv });
      }
      return res;
    };

    return await runValidatedScenario(loaded.loaded.scenario, { ...baseDeps, runAction });
  } finally {
    await daemon.stop().catch(() => {});
  }
}
