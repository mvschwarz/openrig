import { describe, it, expect, vi } from "vitest";
import {
  spawnContainerDaemon,
  ContainerDaemonError,
  type DockerResult,
} from "./helpers/scenario-container.js";
import { HermeticEnvError, type HermeticScaffold } from "./helpers/hermetic-env.js";

// 51-04 step-3 — the CONTAINER-mode daemon adapter. It is the ScenarioDaemon-shaped
// sibling of spawnScenarioDaemon: instead of spawning a scenario-local daemon on the
// host, it docker-runs the testbed image BY MANIFEST IDENTITY, starts the daemon
// INSIDE the container, and points the host-side `rig` reads at the published port.
// The docker invoker is INJECTED (mirrors runRig's `node <rigBin>` seam) so this unit
// runs with NO real docker — the real-docker leg is the host-side L6 runbook.
//
// The load-bearing property: the adapter self-sets readEnv.OPENRIG_URL to ITS OWN
// container's published URL (the injectClockNow precedent — never a foreign target),
// and the fail-closed guard still refuses an inherited foreign target BEFORE it runs
// any docker (the container is not an excuse to weaken the DAEMON_TARGET guard — L4).

const CONTAINER_ID = "c0ffeeb0bacafe0123456789abcdef0123456789abcdef0123456789abcdef01";

/** A recording fake for the injected `docker` invoker. */
function fakeDocker(program?: (args: string[]) => Partial<DockerResult>) {
  const calls: string[][] = [];
  const docker = vi.fn(async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    const verb = args[0];
    const base: DockerResult = { stdout: "", stderr: "", code: 0 };
    // `docker run -d …` prints the started container id on stdout.
    if (verb === "run") base.stdout = `${CONTAINER_ID}\n`;
    return { ...base, ...(program?.(args) ?? {}) };
  });
  return { docker, calls };
}

/** A minimal in-memory scaffold — a scrubbed env (no daemon target) + a cleanup spy. */
function fakeScaffold(env: Record<string, string | undefined> = {}): HermeticScaffold {
  return {
    root: "/scratch/root",
    home: "/scratch/root/home",
    openrigHome: "/scratch/root/openrig",
    stateDir: "/scratch/root/state",
    env: { HOME: "/scratch/root/home", PATH: "/usr/bin", ...env },
    cleanup: vi.fn(),
  };
}

const IMAGE = "openrig-testbed:deadbeef";

describe("spawnContainerDaemon — docker-run the testbed image by identity", () => {
  it("runs the named image, publishing the container port to a host port", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), {
      image: IMAGE,
      docker,
      hostPort: 34567,
      containerPort: 7433,
    });
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall).toBeDefined();
    // Detached, publishing 127.0.0.1:<hostPort>:<containerPort>, for the NAMED image.
    expect(runCall).toContain("-d");
    expect(runCall).toContain("127.0.0.1:34567:7433");
    expect(runCall).toContain(IMAGE);
    // The image ref must appear AFTER the flags (docker positional-arg order).
    expect(runCall!.indexOf(IMAGE)).toBeGreaterThan(runCall!.indexOf("-d"));
    expect(daemon.port).toBe(34567);
    expect(daemon.baseUrl).toBe("http://127.0.0.1:34567");
  });

  it("starts the daemon INSIDE the started container and waits for it before returning", async () => {
    const { docker, calls } = fakeDocker();
    await spawnContainerDaemon(fakeScaffold(), {
      image: IMAGE,
      docker,
      hostPort: 34567,
      containerPort: 7433,
    });
    // The daemon is started via `docker exec <id> rig daemon start …` against the id
    // captured from `docker run` — using the SAME shipped `rig daemon start` that
    // blocks on its own /healthz (readiness for free), same as host-mode.
    const startExec = calls.find((c) => c[0] === "exec" && c.includes("start"));
    expect(startExec).toBeDefined();
    expect(startExec).toContain(CONTAINER_ID);
    expect(startExec!.slice(startExec!.indexOf(CONTAINER_ID) + 1)).toEqual([
      "rig",
      "daemon",
      "start",
      "--port",
      "7433",
      "--no-kernel",
    ]);
    // run BEFORE the in-container start.
    const runIdx = calls.findIndex((c) => c[0] === "run");
    const startIdx = calls.findIndex((c) => c[0] === "exec" && c.includes("start"));
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(runIdx);
  });

  it("self-sets readEnv.OPENRIG_URL to its OWN published container URL (not foreign)", async () => {
    const { docker } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold({ RIG_SCRATCH: "keep-me" }), {
      image: IMAGE,
      docker,
      hostPort: 34567,
    });
    // readEnv = { ...scaffold.env, OPENRIG_URL: <its own published url> } — the exact
    // scenario-daemon.ts:148 shape, so the host-side `rig` reads hit THIS container.
    expect(daemon.readEnv.OPENRIG_URL).toBe("http://127.0.0.1:34567");
    expect(daemon.readEnv.RIG_SCRATCH).toBe("keep-me");
    expect(daemon.readEnv.HOME).toBe("/scratch/root/home");
  });

  it("defaults the container port to 7433 when unspecified", async () => {
    const { docker, calls } = fakeDocker();
    await spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 40000 });
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall).toContain("127.0.0.1:40000:7433");
  });
});

describe("spawnContainerDaemon — lifecycle maps to docker verbs", () => {
  it("sigterm stops the daemon in-place (container kept for restart)", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 });
    calls.length = 0;
    await daemon.sigterm();
    const stopExec = calls.find((c) => c[0] === "exec" && c.includes("stop"));
    expect(stopExec).toContain(CONTAINER_ID);
    expect(stopExec!.slice(stopExec!.indexOf(CONTAINER_ID) + 1)).toEqual(["rig", "daemon", "stop"]);
    // sigterm must NOT remove the container (a restart must be able to re-spawn).
    expect(calls.some((c) => c[0] === "rm")).toBe(false);
  });

  it("restart stops then re-starts the daemon on the same container/port", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), {
      image: IMAGE,
      docker,
      hostPort: 1,
      containerPort: 7433,
    });
    calls.length = 0;
    await daemon.restart();
    const stopIdx = calls.findIndex((c) => c[0] === "exec" && c.includes("stop"));
    const startIdx = calls.findIndex((c) => c[0] === "exec" && c.includes("start"));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
    // Re-start targets the same container id and the same port.
    const startExec = calls[startIdx];
    expect(startExec).toContain(CONTAINER_ID);
    expect(startExec).toContain("7433");
  });

  it("stop removes the container AND cleans up the scaffold", async () => {
    const { docker, calls } = fakeDocker();
    const scaffold = fakeScaffold();
    const daemon = await spawnContainerDaemon(scaffold, { image: IMAGE, docker, hostPort: 1 });
    calls.length = 0;
    await daemon.stop();
    const rm = calls.find((c) => c[0] === "rm");
    expect(rm).toContain("-f");
    expect(rm).toContain(CONTAINER_ID);
    expect(scaffold.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("spawnContainerDaemon — fail-closed + loud failures", () => {
  it("refuses an inherited FOREIGN daemon target before running any docker", async () => {
    const { docker, calls } = fakeDocker();
    await expect(
      spawnContainerDaemon(fakeScaffold({ OPENRIG_URL: "http://foreign-daemon.invalid:9999" }), {
        image: IMAGE,
        docker,
        hostPort: 1,
      }),
    ).rejects.toBeInstanceOf(HermeticEnvError);
    // ZERO docker traffic — the guard runs before any container is created.
    expect(calls).toHaveLength(0);
    expect(docker).not.toHaveBeenCalled();
  });

  it("fails LOUD when `docker run` exits non-zero", async () => {
    const { docker } = fakeDocker((args) =>
      args[0] === "run" ? { code: 125, stderr: "no such image" } : {},
    );
    await expect(
      spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 }),
    ).rejects.toBeInstanceOf(ContainerDaemonError);
  });

  it("fails LOUD when `docker run` yields no container id", async () => {
    const { docker } = fakeDocker((args) => (args[0] === "run" ? { stdout: "   \n" } : {}));
    await expect(
      spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 }),
    ).rejects.toBeInstanceOf(ContainerDaemonError);
  });

  it("tears down the created container when the in-container daemon start fails", async () => {
    const { docker, calls } = fakeDocker((args) =>
      args[0] === "exec" && args.includes("start") ? { code: 1, stderr: "healthz timeout" } : {},
    );
    await expect(
      spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 }),
    ).rejects.toBeInstanceOf(ContainerDaemonError);
    // No leaked container: the failed spawn removes the one it created.
    const rm = calls.find((c) => c[0] === "rm");
    expect(rm).toContain("-f");
    expect(rm).toContain(CONTAINER_ID);
  });
});
