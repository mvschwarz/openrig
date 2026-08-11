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
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  validateScenario,
  type ValidatedScenario,
  type ValidationError,
} from "./scenario-schema.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./hermetic-env.js";
import {
  spawnScenarioDaemon,
  runRig as realRunRig,
  type RigResult,
  type ScenarioDaemon,
} from "./scenario-daemon.js";
import { buildRealDeps, type RealDepsOptions } from "./scenario-real-deps.js";
import { runValidatedScenario, type RunScenarioResult } from "./scenario-runner.js";
import type { RunRecord } from "./scenario-run-record.js";
import { stageTopologyRoot, deliverStubScripts, resolveStubScriptTargets } from "./scenario-stage.js";
import { provisionTui, spawnShippedTui, type ProvisionedTui, type TuiProcessLike } from "./scenario-tui.js";

/** The tui package root, resolved from this helper's own location. */
const TUI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tui");

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

/** Thrown when a scenario asks for a capability this daemon mode cannot honor. */
export class ScenarioModeUnsupportedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ScenarioModeUnsupportedError";
  }
}

/** Extract + shape-check `env.stub_scripts` (D1). Shape is validator-checked at
 *  load; this is the pipeline's own read of the same field. */
export function extractStubScripts(env: Record<string, unknown> | undefined): Record<string, string> {
  const raw = env?.stub_scripts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ScenarioPreconditionError("env.stub_scripts must be a mapping of <seat> → <script path>");
  }
  const out: Record<string, string> = {};
  for (const [seat, p] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof p !== "string" || p.length === 0) {
      throw new ScenarioPreconditionError(`env.stub_scripts.${seat}: a non-empty script path is required`);
    }
    out[seat] = p;
  }
  return out;
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

/**
 * Apply the queue-baton preconditions via shipped `rig queue` writes. Fail-closed.
 *
 * Identity (post-P21): `--source` was RETIRED by P21 I3 (c4fad7b39, 2026-08-07 —
 * deprecated + IGNORED; queue-spine verbs stop sending body identity). The sender
 * now rides the transport header, which the CLI derives from OPENRIG_SESSION_NAME.
 * The fixture's declared provenance therefore travels as the per-call ENV identity
 * — creator = `source`, claimant = `destination` — the same transport-not-body
 * doctrine the product enforces, converging with it rather than working around it.
 */
export async function applyQueuePreconditions(
  preconditions: QueuePrecondition[],
  ctx: PreconditionContext,
): Promise<void> {
  const runRig = ctx.runRig ?? realRunRig;
  for (const p of preconditions) {
    const create = await runRig(
      ["queue", "create", "--id", p.id, "--destination", p.destination,
        "--summary", p.summary ?? p.id, "--body", p.body ?? `51-02 precondition baton ${p.id}`, "--json"],
      { ...ctx.readEnv, OPENRIG_SESSION_NAME: p.source }, ctx.rigBin,
    );
    if (create.code !== 0) {
      throw new ScenarioPreconditionError(`queue create ${p.id} (exit ${create.code}): ${create.stderr || create.stdout}`);
    }
    if (p.claim) {
      const claim = await runRig(
        ["queue", "claim", p.id, "--destination", p.destination, "--json"],
        { ...ctx.readEnv, OPENRIG_SESSION_NAME: p.destination }, ctx.rigBin,
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
  /**
   * 51-04 opt-in: how the scenario-local daemon is stood up. ABSENT => host-mode,
   * byte-identical to pre-51-04 (`defaultHostDaemon` = spawnScenarioDaemon with rigBin).
   * Container-mode (scenario-container.ts) supplies its own spawner here; nothing else
   * on the host-mode path changes, so the 51-02 contract stays byte-intact.
   */
  daemon?: ScenarioDaemonSpawner;
  /**
   * 51-04 container-mode: the testbed image manifest identity (digest) this run
   * executed against. When set, it is stamped onto every results-ledger record so
   * runs are comparable across image versions (plan §4). ABSENT in host-mode.
   */
  imageId?: string;
  /**
   * D7: how the shipped TUI is spawned when a scenario declares `env.tui: true`
   * (the tui_socket surface reads a control socket that exists only inside a
   * running TUI). ABSENT => the real binary. Injected by tests so the readiness
   * and early-exit paths are exercisable without a terminal.
   */
  spawnTui?: (env: Record<string, string | undefined>) => TuiProcessLike;
  /** D7: path to the shipped TUI entry (defaults to the built tui package main). */
  tuiBin?: string;
  /**
   * D8: the A3-R3 injected clock (an ISO instant) for this run. Threaded into the
   * hermetic scaffold, which sets OPENRIG_TEST_CLOCK_NOW for every child — the
   * daemon, the `rig` CLI, and the stub runner — so compaction-asset stamps and
   * the stub's own stamps are deterministic. ABSENT => unset => real wall clock
   * (production behavior). A determinism claim that does not pass this is
   * asserting stability it never asked for.
   */
  injectClockNow?: string;
  /**
   * D7: readiness bounds for TUI provisioning. Exposed so the failure matrix can
   * be exercised THROUGH this function (guard finding 3) rather than only against
   * the helper — a helper-only pin cannot show that the pipeline propagates the
   * named failure and still tears down.
   */
  tuiReadiness?: { readinessTimeoutMs?: number; probeIntervalMs?: number };
}

/**
 * Stamp the image manifest id onto every record an appendRecord sink receives. Returns
 * the ORIGINAL sink unchanged when no image id is supplied (host-mode: the ledger rows
 * stay byte-for-byte pre-51-04) or when there is no sink to record into. The stamp is a
 * COPY — the caller's record object is never mutated.
 */
export function withImageId(
  appendRecord: ((rec: RunRecord) => void) | undefined,
  imageId: string | undefined,
): ((rec: RunRecord) => void) | undefined {
  if (!imageId || !appendRecord) return appendRecord;
  return (rec) => appendRecord({ ...rec, imageId });
}

/**
 * Stand a scenario-local daemon up and return the ScenarioDaemon contract. The default
 * is host-mode (`defaultHostDaemon`); 51-04 container-mode injects its own spawner via
 * RunScenarioFileOptions.daemon. runScenarioFile binds to whatever this returns purely
 * through the ScenarioDaemon interface, so the two modes are interchangeable.
 */
export type ScenarioDaemonSpawner = (
  scaffold: HermeticScaffold,
  opts: RunScenarioFileOptions,
) => Promise<ScenarioDaemon>;

/** Host-mode default — the verbatim pre-51-04 standup (spawnScenarioDaemon + rigBin). */
export const defaultHostDaemon: ScenarioDaemonSpawner = (scaffold, opts) =>
  spawnScenarioDaemon(scaffold, { rigBin: opts.rigBin });

/**
 * Pick the daemon spawner: the caller's opt-in override, else host-mode. An ABSENT
 * override yields the exact host-mode standup unchanged (the additive-opt-in fence that
 * keeps the 51-02 host-mode contract byte-intact — no PM 51-02 gate crossed).
 */
export function resolveScenarioDaemonSpawner(opts: RunScenarioFileOptions): ScenarioDaemonSpawner {
  return opts.daemon ?? defaultHostDaemon;
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
  const stubScripts = extractStubScripts(loaded.loaded.scenario.env);

  // D1 key contract, checked against the SOURCE topology BEFORE any filesystem
  // or process effect: a misspelled/ambiguous/duplicate/non-stub target must
  // fail here, not after a daemon and a rig full of seats are already up.
  if (Object.keys(stubScripts).length > 0) {
    resolveStubScriptTargets(
      parseYaml(readFileSync(loaded.loaded.topologyPath, "utf-8")),
      stubScripts,
    );
  }

  const scaffold = prepareHermeticEnv({
    ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
    ...(opts.injectClockNow !== undefined ? { injectClockNow: opts.injectClockNow } : {}),
  });
  // Seats launch with cwd under the scaffold so their managed writes (AGENTS.md,
  // the stub sidecar) stay in scratch and never pollute the launch cwd.
  const seatCwd = join(scaffold.root, "seat-cwd");
  mkdirSync(seatCwd, { recursive: true });
  const daemon = await resolveScenarioDaemonSpawner(opts)(scaffold, opts);
  let tui: ProvisionedTui | undefined;
  try {
    // L6 STEP-0 — container-mode translates the HOST topology path to the in-container staged path
    // (host-mode has no stageTopology → the host path passes through unchanged). A stage/fence
    // failure throws here (loud, named) and the finally tears the container down — never a mystery
    // "Source not found" from `rig up` reading a host path it cannot see inside the container.
    // D1 per-seat scripts (host-mode only). Container mode translates host paths
    // into the container; composing that with host-side per-seat staging is not
    // proven, so a scripted scenario there fails LOUD and named (routed to 51-04)
    // rather than silently delivering scripts the container cannot see. Container
    // mode WITHOUT scripts keeps its existing stage path byte-untouched.
    const wantsStubScripts = Object.keys(stubScripts).length > 0;
    if (wantsStubScripts && daemon.stageTopology) {
      throw new ScenarioModeUnsupportedError(
        "env.stub_scripts is not supported in container mode yet: per-seat script delivery stages a " +
          "host-side topology root with per-seat CWDs, which the container's own path translation does " +
          "not yet compose with. Run this scenario in host mode (51-04 owns the container binding).",
      );
    }

    // Host mode with scripts: stage a SELF-CONTAINED topology root (the relative
    // culture_file / local: agent closure travels), author a distinct cwd per seat
    // in the staged copy, and deliver each mapped seat's script into its own cwd.
    // No `--cwd` override then — resolveLaunchCwd would make one dir win for every
    // seat, which is exactly what makes per-seat scripts impossible.
    let staged: ReturnType<typeof stageTopologyRoot> | undefined;
    if (wantsStubScripts) {
      staged = stageTopologyRoot(loaded.loaded.topologyPath, join(scaffold.root, "topology"));
      deliverStubScripts(staged, stubScripts, dirname(path));
    }

    const upTopologyPath = staged
      ? staged.topologyPath
      : daemon.stageTopology
        ? await daemon.stageTopology(loaded.loaded.topologyPath)
        : loaded.loaded.topologyPath;
    const baseDeps = buildRealDeps({
      daemon,
      rigBin: opts.rigBin,
      topologyPath: upTopologyPath,
      // Staged runs author per-seat cwds IN the spec; a --cwd override would
      // collapse them back to one directory.
      seatCwd: staged ? undefined : seatCwd,
      scopeMission: typeof loaded.loaded.scenario.env?.scope_mission === "string"
        ? (loaded.loaded.scenario.env.scope_mission as string)
        : undefined,
      ...opts.deps,
      // Container-mode stamps the image id onto every ledger row; host-mode (no
      // imageId) leaves opts.deps.appendRecord exactly as supplied (byte-intact).
      appendRecord: withImageId(opts.deps?.appendRecord, opts.imageId),
    });

    // Fixture-level preconditions (the baton) are applied RIGHT AFTER the topology
    // is up: `rig queue create` rejects a destination whose rig is not yet up
    // (unknown_destination_rig), so the baton cannot precede `up`. It is still setup,
    // not an asserted observable — visibly declared in the scenario `env` block.
    let batonApplied = preconditions.length === 0;
    // D7: the control socket lives INSIDE a running TUI, so an opted-in scenario
    // provisions one after `up` — bounded readiness on a real `state` round-trip,
    // named failure on early exit/timeout, and the socket path threaded into the
    // read env so the tui_socket surface can find it. Never the operator's TUI:
    // it runs in the scaffold's own tmux server (D5) on a scaffold socket path.
    const wantsTui = loaded.loaded.scenario.env?.tui === true;
    const tuiSocketPath = join(scaffold.root, "tui.sock");
    const runAction: typeof baseDeps.runAction = async (verb, payload, seat) => {
      const res = await baseDeps.runAction(verb, payload, seat);
      if (!batonApplied && verb === "up" && res.code === 0) {
        batonApplied = true;
        await applyQueuePreconditions(preconditions, { rigBin: opts.rigBin, readEnv: daemon.readEnv });
      }
      if (wantsTui && !tui && verb === "up" && res.code === 0) {
        const tuiEnv = { ...daemon.readEnv, OPENRIG_TUI_SOCKET: tuiSocketPath };
        tui = await provisionTui({
          socketPath: tuiSocketPath,
          spawnTui: () => (opts.spawnTui ? opts.spawnTui(tuiEnv) : spawnShippedTui(resolveTuiBin(opts), tuiEnv)),
          ...(opts.tuiReadiness ?? {}),
        });
        // the surface reader finds the socket through the SAME env the CLI reads
        daemon.readEnv.OPENRIG_TUI_SOCKET = tuiSocketPath;
      }
      return res;
    };

    return await runValidatedScenario(loaded.loaded.scenario, { ...baseDeps, runAction });
  } finally {
    // Teardown on EVERY path — success, assertion failure, or provisioning error.
    await tui?.stop().catch(() => {});
    await daemon.stop().catch(() => {});
  }
}

/** The shipped TUI entry (built package main); overridable for container/test runs. */
function resolveTuiBin(opts: RunScenarioFileOptions): string {
  return opts.tuiBin ?? resolve(TUI_PACKAGE_ROOT, "dist", "main.js");
}
