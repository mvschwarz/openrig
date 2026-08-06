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

import { assertNoForeignDaemon, type HermeticScaffold } from "./hermetic-env.js";
import { findFreePort, type ScenarioDaemon } from "./scenario-daemon.js";

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

/** The daemon port INSIDE the container (the shipped default). */
const DEFAULT_CONTAINER_PORT = 7433;

export interface SpawnContainerDaemonOptions {
  /** The testbed image identity to run (manifest.image, e.g. "openrig-testbed:<gitSha>"). */
  image: string;
  /** Injected docker invoker — the container analogue of runRig's `node <rigBin>` seam. */
  docker: (args: string[]) => Promise<DockerResult>;
  /** The daemon port INSIDE the container (default 7433). */
  containerPort?: number;
  /** Override the published host port (default: an ephemeral free port). */
  hostPort?: number;
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
  const containerPort = opts.containerPort ?? DEFAULT_CONTAINER_PORT;
  const hostPort = opts.hostPort ?? (await findFreePort());
  const publish = `127.0.0.1:${hostPort}:${containerPort}`;

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
  const readEnv: Record<string, string | undefined> = { ...scaffold.env, OPENRIG_URL: baseUrl };

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
