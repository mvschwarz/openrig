/**
 * Slice 51-02 (L2 test-system) — the forced-local scenario daemon lifecycle.
 *
 * The hermetic helper SPAWNS a real scenario-local daemon via the shipped `rig`
 * bin under the scrubbed scratch env, and the runner drives it with real
 * `rig … --json` subprocesses. This proves the env-discipline at a real process
 * boundary (a direct in-process method call would not be a transport proof) and
 * makes the assertions read exactly what a user/agent observes (product-is-truth).
 *
 * The `rig` bin is a SINGLE injectable seam (`rigBin`) so 51-04 container-mode can
 * point it at the container's installed `rig` without touching this host-mode
 * contract.
 */

import { execFile } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { assertNoForeignDaemon, type HermeticScaffold } from "./hermetic-env.js";

export interface RigResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** A running scenario-local daemon + how to read it + how to tear it down. */
export interface ScenarioDaemon {
  /** The ephemeral port the daemon is listening on. */
  port: number;
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /**
   * Environment for shipped read/write subprocesses: the scaffold's scrubbed
   * scratch env with OPENRIG_URL pointed at THIS daemon (the helper's own — not a
   * foreign target).
   */
  readEnv: Record<string, string | undefined>;
  /**
   * SIGTERM the scenario-local daemon (the `daemon: {op: sigterm}` verb) — kills
   * it via the shipped `rig daemon stop`; the scaffold is KEPT so a restart can
   * re-spawn through the same guarantees. Idempotent.
   */
  sigterm: () => Promise<void>;
  /**
   * Restart the scenario-local daemon (the `daemon: {op: restart}` verb) — ensures
   * it is down, then RE-SPAWNS on the same port/db/scratch env, i.e. through the
   * SAME forced-local/scratch/fail-closed guarantees (single owner, no second
   * lifecycle path). Distinct from a seat-level restart, which never touches it.
   */
  restart: () => Promise<void>;
  /** Stop the daemon (via the shipped `rig daemon stop`) and remove the scaffold. */
  stop: () => Promise<void>;
  /**
   * L6 STEP-0 — translate a HOST topology path to a path the daemon can read. Host-mode omits this
   * (identity: the daemon reads the host path directly). CONTAINER-mode implements it by staging the
   * topology's directory INTO the container and returning the in-container path, so `rig up` is never
   * handed a host-absolute path a container daemon cannot resolve ("Source not found").
   */
  stageTopology?: (hostTopologyPath: string) => Promise<string>;
}

export interface SpawnScenarioDaemonOptions {
  /** Path to the shipped `rig` bin (the single injectable invocation seam). */
  rigBin: string;
  /** Override the port (default: an ephemeral free port). */
  port?: number;
  /** Per-invocation timeout for `rig` subprocesses (ms). */
  timeoutMs?: number;
}

/** Reserve an ephemeral free port on 127.0.0.1 (closed immediately; best-effort). */
export function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error("could not reserve a free port"))));
    });
  });
}

/** Invoke `node <rigBin> <args...>` with the given env. Never rejects — returns the exit code. */
export function runRig(
  args: string[],
  env: Record<string, string | undefined>,
  rigBin: string,
  timeoutMs = 30_000,
): Promise<RigResult> {
  // execFile replaces the environment wholesale — drop undefined values so a
  // scrubbed (deleted) var never leaks back in as the literal string "undefined".
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;
  return new Promise((resolve) => {
    execFile(
      "node",
      [rigBin, ...args],
      { env: cleanEnv, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

/**
 * Spawn a real forced-local scenario daemon under the hermetic scaffold. The
 * shipped `rig daemon start` waits for its own /healthz before returning, so a
 * zero exit means the daemon is accepting requests. Throws (fail-closed) if the
 * scaffold env still carries a foreign daemon target, or if start fails.
 */
export async function spawnScenarioDaemon(
  scaffold: HermeticScaffold,
  opts: SpawnScenarioDaemonOptions,
): Promise<ScenarioDaemon> {
  // Defense in depth: the scaffold env is already scrubbed, but never spawn
  // against a foreign target.
  assertNoForeignDaemon(scaffold.env);

  const { rigBin, timeoutMs } = opts;
  const port = opts.port ?? (await findFreePort());
  const db = join(scaffold.stateDir, "scenario.db");

  // The single start path — reused by initial spawn AND by restart, so a restart
  // re-spawns through EXACTLY the same forced-local/scratch/fail-closed guarantees.
  const startProc = async () => {
    const start = await runRig(
      ["daemon", "start", "--port", String(port), "--db", db, "--no-kernel"],
      scaffold.env,
      rigBin,
      timeoutMs,
    );
    if (start.code !== 0) {
      throw new Error(
        `scenario-local daemon failed to start (exit ${start.code}) on port ${port}: ${start.stderr || start.stdout}`,
      );
    }
  };
  const killProc = async () => {
    // `rig daemon stop` reads daemon.json under the scratch OPENRIG_HOME and
    // SIGTERMs the daemon. Best-effort (already-down is fine).
    await runRig(["daemon", "stop"], scaffold.env, rigBin, timeoutMs).catch(() => {});
  };

  await startProc();

  const baseUrl = `http://127.0.0.1:${port}`;
  const readEnv: Record<string, string | undefined> = { ...scaffold.env, OPENRIG_URL: baseUrl };

  return {
    port,
    baseUrl,
    readEnv,
    sigterm: killProc,
    restart: async () => {
      await killProc();
      await startProc();
    },
    stop: async () => {
      await killProc();
      scaffold.cleanup();
    },
  };
}
