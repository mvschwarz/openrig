/**
 * Slice 51-02 (L2 test-system) — the REAL-DEPS adapter.
 *
 * Binds the dumb runner core (scenario-runner.ts) to a LIVE scenario-local daemon:
 *   • runAction — maps each action verb to the SHIPPED `rig … --json` invocation
 *     (product-is-truth transport), run as a real subprocess against the daemon.
 *   • observe   — reads a shipped surface via readSurface (bound to the daemon).
 *   • the `daemon` verb drives the scenario-local daemon LIFECYCLE (sigterm/restart)
 *     directly — it is the test harness's own daemon, not a rig subprocess.
 *
 * Verb → shipped `rig` command (traced at 13e26355):
 *   up            → rig up <topology> --json --yes         (captures rigId/rigName)
 *   send          → rig send <to> <text> --json
 *   restart <seat>→ rig launch <rigId> <seat> --json       (seat relaunch/resume;
 *                                                            there is no top-level
 *                                                            `restart` command)
 *   down          → rig down <rigName|rigId> --json --force
 *   daemon {op}   → the ScenarioDaemon lifecycle (sigterm | restart)
 *
 * restore/emit/mutate/policy/seed_regression have NO shipped runtime binding at v1
 * (they ride 51-03 / A5 items 6-8) — the adapter FAILS LOUD with a named
 * UnboundActionError rather than fabricating a call (same floor as the FLAG-1
 * `proof` surface: unbound is never silently-skipped).
 *
 * `rigBin` is injected (the single 51-04 container-mode seam); `runRig` is injected
 * so the verb→argv MAPPING is unit-testable without a live daemon.
 */

import { runRig as realRunRig, type RigResult, type ScenarioDaemon } from "./scenario-daemon.js";
import { readSurface } from "./scenario-surfaces.js";
import type { ExpectSurface } from "./scenario-schema.js";
import type { ScenarioRunnerDeps, ActionResult } from "./scenario-runner.js";
import type { RunRecord } from "./scenario-run-record.js";

/** Thrown when an action verb has no shipped runtime binding in v1 (FLAG-1-style floor). */
export class UnboundActionError extends Error {
  readonly verb: string;
  constructor(verb: string) {
    super(
      `action verb "${verb}" is UNBOUND in v1: it has no shipped runtime binding, so the ` +
        `runner FAILS LOUD here rather than fabricating a call (its binding rides 51-03 / A5 ` +
        `items 6-8). This is not a silently-skipped action.`,
    );
    this.name = "UnboundActionError";
    this.verb = verb;
  }
}

/** The subset of a live ScenarioDaemon the adapter needs (readEnv + lifecycle). */
export type RealDepsDaemon = Pick<ScenarioDaemon, "readEnv" | "baseUrl" | "sigterm" | "restart">;

export interface RealDepsOptions {
  daemon: RealDepsDaemon;
  /** Path to the shipped `rig` bin (the single 51-04 injectable invocation seam). */
  rigBin: string;
  /** Resolved rig-spec path for the `up` verb (the scenario's `topology`). */
  topologyPath: string;
  /**
   * Scratch working directory passed to `rig up --cwd` so a seat's `cwd: "."`
   * resolves under the hermetic scaffold (its managed-file writes — AGENTS.md,
   * the stub readiness sidecar — never pollute the launch cwd). Omitted → the
   * shipped default (the daemon's cwd).
   */
  seatCwd?: string;
  /** Injected `rig` runner (defaults to the real subprocess runner; tests inject a spy). */
  runRig?: (
    args: string[],
    env: Record<string, string | undefined>,
    rigBin: string,
    timeoutMs?: number,
  ) => Promise<RigResult>;
  /** Injected scenario-local clock (ms) for the poll bound. Defaults to Date.now. */
  now?: () => number;
  /** Injected sleep between polls. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional run-record sink. */
  appendRecord?: (rec: RunRecord) => void;
  /** The single default within/poll pair. */
  defaults?: { withinMs: number; pollIntervalMs: number };
  /** Optional cross-surface normalizer for the `equals` mode (its shape rides 51-03). */
  normalizer?: (surface: ExpectSurface, value: unknown) => unknown;
}

/** `rig up` is heavy (real tmux seat launch) — give it a generous ceiling. */
const UP_TIMEOUT_MS = 120_000;

const fail = (stderr: string): ActionResult => ({ code: 1, stdout: "", stderr });

/** Build the live ScenarioRunnerDeps for the dumb runner core. */
export function buildRealDeps(opts: RealDepsOptions): ScenarioRunnerDeps {
  const { daemon, rigBin, topologyPath } = opts;
  const runRig = opts.runRig ?? realRunRig;

  // Captured from the `up` result so down/restart target the real rig (never fabricated).
  let rigId: string | undefined;
  let rigName: string | undefined;

  const runAction = async (verb: string, payload: unknown, seat?: string): Promise<ActionResult> => {
    switch (verb) {
      case "up": {
        const upArgs = ["up", topologyPath, "--json", "--yes"];
        if (opts.seatCwd) upArgs.push("--cwd", opts.seatCwd);
        const r = await runRig(upArgs, daemon.readEnv, rigBin, UP_TIMEOUT_MS);
        if (r.code === 0) {
          try {
            const j = JSON.parse(r.stdout) as Record<string, unknown>;
            const rig = (j.rig as Record<string, unknown> | undefined) ?? undefined;
            rigId = (j.rigId as string) ?? (rig?.id as string) ?? rigId;
            rigName = (j.rigName as string) ?? (rig?.name as string) ?? rigName;
          } catch {
            /* non-JSON up output — leave the rig ids uncaptured; down/restart will fail loud */
          }
        }
        return r;
      }
      case "send": {
        const p = (payload && typeof payload === "object" ? payload : {}) as { to?: string; text?: string };
        const to = p.to ?? seat;
        const text = p.text ?? "";
        if (!to) return fail("send: no recipient (payload.to or a seat is required)");
        return runRig(["send", to, text, "--json"], daemon.readEnv, rigBin);
      }
      case "restart": {
        // Seat relaunch/resume — rig launch <rigId> <seat>. Distinct from the
        // `daemon` verb (which restarts the scenario-local DAEMON, not a seat).
        const node = typeof payload === "string" ? payload : seat;
        const target = rigId ?? rigName;
        if (!target) return fail("restart: no rig brought up yet (no rigId/rigName captured from `up`)");
        if (!node) return fail("restart: no seat named (restart <seat>)");
        return runRig(["launch", target, node, "--json"], daemon.readEnv, rigBin);
      }
      case "down": {
        const target = rigName ?? rigId;
        if (!target) return fail("down: no rig brought up yet (no rigId/rigName captured from `up`)");
        return runRig(["down", target, "--json", "--force"], daemon.readEnv, rigBin);
      }
      case "daemon": {
        const op = (payload && typeof payload === "object" ? (payload as { op?: string }).op : undefined);
        if (op === "sigterm") { await daemon.sigterm(); return { code: 0, stdout: "", stderr: "" }; }
        if (op === "restart") { await daemon.restart(); return { code: 0, stdout: "", stderr: "" }; }
        return fail(`daemon: unknown op ${JSON.stringify(op)} (allowed: sigterm, restart)`);
      }
      default:
        // restore / emit / mutate / policy / seed_regression — no shipped binding at v1.
        throw new UnboundActionError(verb);
    }
  };

  const observe = (surface: ExpectSurface, o: { seat?: string }): Promise<unknown> =>
    readSurface(surface, { rigBin, readEnv: daemon.readEnv, baseUrl: daemon.baseUrl }, { seat: o.seat });

  return {
    runAction,
    observe,
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))),
    appendRecord: opts.appendRecord,
    defaults: opts.defaults ?? { withinMs: 15_000, pollIntervalMs: 250 },
    normalizer: opts.normalizer,
  };
}
