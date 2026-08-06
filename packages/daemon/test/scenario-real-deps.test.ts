import { describe, it, expect, vi } from "vitest";
import { buildRealDeps, UnboundActionError } from "./helpers/scenario-real-deps.js";
import type { RigResult } from "./helpers/scenario-daemon.js";

// Slice 51-02 — the REAL-DEPS adapter: it binds the dumb runner core to a live
// ScenarioDaemon. runAction maps each action verb to the SHIPPED `rig` invocation
// (the product-is-truth transport); observe binds to readSurface; the daemon verb
// drives the scenario-local daemon lifecycle (never a rig subprocess). Unbound v1
// verbs FAIL LOUD (mirrors the FLAG-1 proof-surface floor — never fabricate).

function fakeDaemon(over: Record<string, unknown> = {}) {
  return {
    readEnv: { OPENRIG_URL: "http://127.0.0.1:9", HOME: "/x" } as Record<string, string | undefined>,
    baseUrl: "http://127.0.0.1:9",
    sigterm: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    ...over,
  };
}

const ok = (stdout = ""): RigResult => ({ code: 0, stdout, stderr: "" });

describe("buildRealDeps runAction verb->rig map", () => {
  it("maps up to `rig up <topology> --json --yes` and captures rigId/rigName", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ rigId: "r-1", rigName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    const r = await deps.runAction("up", {}, undefined);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes"]);
  });

  it("appends `--cwd <seatCwd>` to up so seat writes land in scratch (no launch-cwd pollution)", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ rigId: "r-1", rigName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", seatCwd: "/scratch/seat", runRig });
    await deps.runAction("up", {}, undefined);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes", "--cwd", "/scratch/seat"]);
  });

  it("maps send to `rig send <to> <text> --json` (recipient from payload.to or the seat)", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("send", { to: "a@r", text: "hello" }, undefined);
    expect(calls[0]).toEqual(["send", "a@r", "hello", "--json"]);
  });

  it("maps restart <seat> to `rig launch <rigId> <seat> --json` after up captured the rigId", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ rigId: "r-9", rigName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("restart", "seat-a", "seat-a");
    expect(calls[1]).toEqual(["launch", "r-9", "seat-a", "--json"]);
  });

  it("maps down to `rig down <rigName> --json --force` using the captured rig", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ rigId: "r-9", rigName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("down", {}, undefined);
    expect(calls[1]).toEqual(["down", "demo", "--json", "--force"]);
  });

  it("drives the scenario-local daemon lifecycle for the daemon verb, never a rig subprocess", async () => {
    const runRig = vi.fn(async () => ok());
    const daemon = fakeDaemon();
    const deps = buildRealDeps({ daemon, rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    expect((await deps.runAction("daemon", { op: "sigterm" }, undefined)).code).toBe(0);
    expect(daemon.sigterm).toHaveBeenCalledOnce();
    expect((await deps.runAction("daemon", { op: "restart" }, undefined)).code).toBe(0);
    expect(daemon.restart).toHaveBeenCalledOnce();
    expect(runRig).not.toHaveBeenCalled();
  });

  it("FAILs down when no rig was brought up — no fabricated target", async () => {
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    const r = await deps.runAction("down", {}, undefined);
    expect(r.code).not.toBe(0);
    expect(runRig).not.toHaveBeenCalled();
  });

  it("throws UnboundActionError for a v1-unbound verb (restore/emit/mutate/policy/seed_regression) — fail loud", async () => {
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await expect(deps.runAction("emit", { seat: "a@r", behavior: "restore" }, "a@r")).rejects.toBeInstanceOf(UnboundActionError);
    await expect(deps.runAction("seed_regression", { class: "x" }, undefined)).rejects.toBeInstanceOf(UnboundActionError);
    expect(runRig).not.toHaveBeenCalled();
  });

  it("exposes injectable clock/sleep and the default within/poll pair", async () => {
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", now: () => 42, sleep: async () => {} });
    expect(deps.now()).toBe(42);
    expect(deps.defaults.withinMs).toBeGreaterThan(0);
    expect(deps.defaults.pollIntervalMs).toBeGreaterThan(0);
  });
});
