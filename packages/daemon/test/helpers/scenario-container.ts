// 51-04 step-3 — the CONTAINER-mode scenario daemon adapter (plan §4).
//
// The ScenarioDaemon-shaped sibling of spawnScenarioDaemon (scenario-daemon.ts):
// instead of spawning a scenario-local daemon on the HOST, it docker-runs the testbed
// image BY MANIFEST IDENTITY, starts the shipped daemon INSIDE the container, and points
// the host-side `rig` read/write subprocesses at the container's PUBLISHED port. It
// returns the identical ScenarioDaemon contract, so runScenarioFile's downstream
// (buildRealDeps + runValidatedScenario) binds to it unchanged — host-mode stays
// byte-intact and container-mode is a pure additive opt-in.
//
// The docker invoker is INJECTED (the container analogue of runRig's `node <rigBin>`
// seam) so this adapter unit-tests hermetically with NO real docker; the real-docker
// leg is the host-side L6 runbook. The load-bearing property mirrored from host-mode:
// readEnv.OPENRIG_URL is SELF-SET to the adapter's OWN published container URL — never
// a foreign target (the injectClockNow precedent) — and the fail-closed guard still
// refuses an inherited foreign target BEFORE any docker runs (the container is not an
// excuse to weaken the DAEMON_TARGET guard; the L4 claim).

import { randomBytes } from "node:crypto";
import { assertNoForeignDaemon, type HermeticScaffold } from "./hermetic-env.js";
import { type ScenarioDaemon } from "./scenario-daemon.js";
// The ONE published-daemon procedure — imported, never re-derived (drift is what the
// module's parity fence exists to catch): explicit 0.0.0.0 bind + the bearer that bind
// demands, the unqualified `P:C` publish, and the explicit non-ephemeral host port.
import {
  CONTAINER_PORT,
  L3_HOST_PORT,
  publishArg,
  publishedDaemonEnvFlags,
} from "./testbed-published-daemon.js";

/** The exit-carrying result of an injected docker invocation (mirrors RigResult). */
export interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Loud, typed failure — a container that will not start (or start its daemon) must
 *  fail, never a silent half-up container that would look scenario-ready. */
export class ContainerDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerDaemonError";
  }
}

export interface SpawnContainerDaemonOptions {
  /** The testbed image identity to run (manifest.image, e.g. "openrig-testbed:<gitSha>"). */
  image: string;
  /** Injected docker invoker — the container analogue of runRig's `node <rigBin>` seam. */
  docker: (args: string[]) => Promise<DockerResult>;
  /** The daemon port INSIDE the container (default CONTAINER_PORT = 7433). */
  containerPort?: number;
  /** Override the published host port. Default L3_HOST_PORT (19433) — EXPLICIT + non-ephemeral;
   *  `publishArg` throws on 0 (Apple container 1.2.0 rejects an ephemeral publish). */
  hostPort?: number;
  /** The bearer the 0.0.0.0 bind requires (assertBindAuthInvariant). Default: a fresh random token.
   *  Set on the daemon (OPENRIG_AUTH_BEARER_TOKEN) AND carried in readEnv so host-side `rig` reads
   *  authenticate to the guarded routes. */
  bearerToken?: string;
}

/**
 * Docker-run the testbed image and stand its daemon up INSIDE the container, returning
 * the ScenarioDaemon contract. Fail-closed (throws) if the scaffold env still carries a
 * foreign daemon target, if the container will not run, or if the in-container daemon
 * will not start (the created container is torn down so nothing leaks).
 */
export async function spawnContainerDaemon(
  scaffold: HermeticScaffold,
  opts: SpawnContainerDaemonOptions,
): Promise<ScenarioDaemon> {
  // The container is not an excuse to weaken the guard — refuse an inherited foreign
  // target before creating ANY container (mirrors spawnScenarioDaemon:118).
  assertNoForeignDaemon(scaffold.env);

  const { image, docker } = opts;
  const containerPort = opts.containerPort ?? CONTAINER_PORT;
  const hostPort = opts.hostPort ?? L3_HOST_PORT;
  const bearerToken = opts.bearerToken ?? randomBytes(16).toString("hex");
  // Unqualified `P:C` — Apple container 1.2.0 RESETS on the `127.0.0.1:P:C` form (and rejects an
  // ephemeral 0). publishArg throws on a non-positive port, so ephemeral allocation cannot sneak back.
  const publish = publishArg(hostPort, containerPort);

  // Start a long-lived container (entrypoint seeds the self-host id then execs the CMD);
  // `tail -f /dev/null` keeps PID 1 alive so the daemon can be started + probed via exec.
  const run = await docker(["run", "-d", "-p", publish, image, "tail", "-f", "/dev/null"]);
  if (run.code !== 0) {
    throw new ContainerDaemonError(
      `docker run failed (exit ${run.code}) for image '${image}': ${run.stderr || run.stdout}`,
    );
  }
  const containerId = run.stdout.trim();
  if (containerId.length === 0) {
    throw new ContainerDaemonError(`docker run for image '${image}' produced no container id`);
  }

  // The single in-container start path — reused by initial spawn AND by restart, so a
  // restart re-spawns through EXACTLY the same shipped `rig daemon start` (which blocks
  // on its own /healthz: a zero exit means the daemon is accepting requests).
  const startProc = async () => {
    const start = await docker([
      "exec",
      // Explicit bind (OPENRIG_HOST=0.0.0.0) + the bearer the bind demands — a published port is
      // unreachable on the default 127.0.0.1 bind, and the daemon REFUSES a non-loopback bind without
      // the bearer (assertBindAuthInvariant). Satisfy the guard; never weaken it.
      ...publishedDaemonEnvFlags(bearerToken),
      containerId,
      "rig",
      "daemon",
      "start",
      "--port",
      String(containerPort),
      "--no-kernel",
    ]);
    if (start.code !== 0) {
      throw new ContainerDaemonError(
        `in-container daemon failed to start (exit ${start.code}) in ${containerId}: ${start.stderr || start.stdout}`,
      );
    }
  };
  // Stop the in-container daemon but KEEP the container (a restart re-spawns). Best-effort.
  const killProc = async () => {
    await docker(["exec", containerId, "rig", "daemon", "stop"]).catch(() => {});
  };

  try {
    await startProc();
  } catch (err) {
    // Do not leak the container we created if its daemon never came up.
    await docker(["rm", "-f", containerId]).catch(() => {});
    throw err;
  }

  const baseUrl = `http://127.0.0.1:${hostPort}`;
  // readEnv = { ...scaffold.env, OPENRIG_URL: <our own published url> } — the exact
  // scenario-daemon.ts:148 shape; the URL is self-created by the adapter that spawned
  // the container (not foreign), so the host-side `rig` reads hit THIS container.
  const readEnv: Record<string, string | undefined> = {
    ...scaffold.env,
    OPENRIG_URL: baseUrl,
    // The guarded probe route (/api/transport/*) checks the TERMINAL token; the host-side `rig` reads
    // send it via OPENRIG_TERMINAL_BEARER_TOKEN (client.ts resolveTerminalToken). On a non-trusted
    // 0.0.0.0 bind the daemon uses the SAME token for both (index.ts:160), so this is that token.
    OPENRIG_TERMINAL_BEARER_TOKEN: bearerToken,
  };

  return {
    port: hostPort,
    baseUrl,
    readEnv,
    sigterm: killProc,
    restart: async () => {
      await killProc();
      await startProc();
    },
    stop: async () => {
      await docker(["rm", "-f", containerId]).catch(() => {});
      scaffold.cleanup();
    },
  };
}
