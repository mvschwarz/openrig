import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provisionTui,
  probeTuiState,
  TuiProvisioningError,
  type TuiProcessLike,
} from "./helpers/scenario-tui.js";

// 51-02 delta D7 (guard binding) — the TUI readiness BOUNDARY.
//
// readTuiSocket rejects immediately on a connect error and the expect poller does
// not catch observation errors, so "spawn then proceed" makes #10 race-prone.
// Provisioning waits boundedly for a real `state` round-trip, detects early exit,
// and tears down on EVERY path.

const dirs: string[] = [];
const servers: net.Server[] = [];
const conns: net.Socket[] = [];
afterEach(async () => {
  // Destroy live connections FIRST: server.close() waits for them, and a probe
  // that deliberately never completes a clean handshake would hang the suite.
  for (const c of conns.splice(0)) c.destroy();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sockPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tui-"));
  dirs.push(d);
  return join(d, "t.sock");
};

/** A control socket that answers `state` like the shipped TUI does. */
function listenStateServer(path: string): Promise<net.Server> {
  const server = net.createServer((conn) => {
    conns.push(conn);
    conn.on("error", () => {});
    conn.on("data", () => {
      // reply then END: a half-open connection would hang server.close() in cleanup
      conn.end(JSON.stringify({ ok: true, screen: "rigs", drill: [] }) + "\n");
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

/** A fake TUI process whose lifetime the test controls. */
function fakeProc(): TuiProcessLike & { exit(code: number): void; killed: boolean } {
  let exited = false;
  let resolveExit!: (c: number | null) => void;
  const exitedPromise = new Promise<number | null>((r) => { resolveExit = r; });
  const p = {
    exited: exitedPromise,
    hasExited: () => exited,
    killed: false,
    kill() { p.killed = true; if (!exited) { exited = true; resolveExit(143); } },
    exit(code: number) { if (!exited) { exited = true; resolveExit(code); } },
  };
  return p;
}

describe("D7 — DELAYED readiness is tolerated within the bound", () => {
  it("proceeds once the socket starts answering `state` late", async () => {
    const path = sockPath();
    const proc = fakeProc();
    let ticks = 0;
    // starts listening only after the 3rd probe — the exact race that made #10 abort
    const provisioned = await provisionTui({
      socketPath: path,
      spawnTui: () => proc,
      readinessTimeoutMs: 10_000,
      probeIntervalMs: 1,
      now: () => ticks * 10,
      sleep: async () => { ticks++; if (ticks === 3) await listenStateServer(path); },
    });
    expect(provisioned.socketPath).toBe(path);
    expect(await probeTuiState(path)).toBe(true);
    await provisioned.stop();
    expect(proc.killed).toBe(true);
  });
});

describe("D7 — EARLY EXIT fails named, and tears down", () => {
  it("reports early_exit (not a timeout) and leaves no live process", async () => {
    const proc = fakeProc();
    proc.exit(1); // dead before the first probe
    let err: TuiProvisioningError | undefined;
    try {
      await provisionTui({
        socketPath: sockPath(),
        spawnTui: () => proc,
        readinessTimeoutMs: 10_000,
        probeIntervalMs: 1,
        now: () => 0,
        sleep: async () => {},
        probe: async () => false,
      });
    } catch (e) { err = e as TuiProvisioningError; }
    expect(err).toBeInstanceOf(TuiProvisioningError);
    expect(err!.reason).toBe("early_exit");
    expect(err!.message).toContain("exited");
    expect(proc.hasExited()).toBe(true);
  });
});

describe("D7 — a socket that NEVER listens times out named, and tears down", () => {
  it("reports readiness_timeout and kills the process", async () => {
    const proc = fakeProc();
    let ticks = 0;
    let err: TuiProvisioningError | undefined;
    try {
      await provisionTui({
        socketPath: sockPath(),
        spawnTui: () => proc,
        readinessTimeoutMs: 50,
        probeIntervalMs: 1,
        now: () => ticks * 20,
        sleep: async () => { ticks++; },
        probe: async () => false,
      });
    } catch (e) { err = e as TuiProvisioningError; }
    expect(err).toBeInstanceOf(TuiProvisioningError);
    expect(err!.reason).toBe("readiness_timeout");
    expect(proc.killed).toBe(true); // teardown ran on the failure path
  });
});

describe("D7 — probeTuiState answers the CONTRACT, not mere socket existence", () => {
  it("is false when nothing listens, true on a parseable state reply", async () => {
    const path = sockPath();
    expect(await probeTuiState(path, 200)).toBe(false);
    await listenStateServer(path);
    expect(await probeTuiState(path, 500)).toBe(true);
  });

  it("is false when the socket answers non-JSON (a listening socket is not a working TUI)", async () => {
    const path = sockPath();
    const server = net.createServer((conn) => { conns.push(conn); conn.on("error", () => {}); conn.end("not json\n"); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
    expect(await probeTuiState(path, 500)).toBe(false);
  });
});

describe("D7 — provisioning is wired THROUGH runScenarioFile (opt-in, torn down always)", () => {
  it("spawns only when env.tui is declared, threads the socket path, and tears down after the run", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = mkdtempSync(join(tmpdir(), "tui-pipe-"));
    dirs.push(d);
    writeFileSync(join(d, "topo.yaml"), [
      'version: "0.2"', "name: scn-tui", "pods:", "  - id: dev", "    label: Dev",
      "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
      "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
    ].join("\n"));
    const scenarioPath = join(d, "tui.yaml");
    writeFileSync(scenarioPath, [
      "scenario: tui-provisioned",
      "topology: ./topo.yaml",
      "env:",
      "  tui: true",
      "steps:",
      "  - up: {}",
      "  - expect:",
      "      surface: tui_socket",
      "      within: 2s",
      "      match: { ok: true }",
      "",
    ].join("\n"));

    let spawnedWith: Record<string, string | undefined> | undefined;
    const proc = fakeProc();
    const upEnv: Record<string, string | undefined> = { PATH: process.env.PATH };
    const fakeDaemon = async () => ({
      readEnv: upEnv, baseUrl: "http://127.0.0.1:1",
      sigterm: async () => {}, restart: async () => {}, stop: async () => {},
    });
    // a rig bin that succeeds for `up` so provisioning is reached
    const fakeRig = join(d, "rig.mjs");
    writeFileSync(fakeRig, 'process.stdout.write(JSON.stringify({rigId:"r1",rigName:"scn-tui"}));\n');

    const result = await runScenarioFile(scenarioPath, {
      rigBin: fakeRig,
      baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
      daemon: fakeDaemon as never,
      spawnTui: (env) => {
        spawnedWith = env;
        // start answering `state` immediately at the path the pipeline chose
        void listenStateServer(env.OPENRIG_TUI_SOCKET!);
        return proc;
      },
      deps: { defaults: { withinMs: 2000, pollIntervalMs: 20 } },
    });

    expect(spawnedWith?.OPENRIG_TUI_SOCKET).toMatch(/tui\.sock$/);
    expect(result.verdict).toBe("PASS"); // the tui_socket expect read a real state reply
    expect(proc.killed).toBe(true);      // torn down on the success path
  });

  it("does NOT spawn a TUI for a scenario that never declares env.tui", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = mkdtempSync(join(tmpdir(), "tui-none-"));
    dirs.push(d);
    writeFileSync(join(d, "topo.yaml"), [
      'version: "0.2"', "name: scn-notui", "pods:", "  - id: dev", "    label: Dev",
      "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
      "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
    ].join("\n"));
    const scenarioPath = join(d, "s.yaml");
    writeFileSync(scenarioPath, [
      "scenario: no-tui", "topology: ./topo.yaml", "steps:", "  - up: {}", "",
    ].join("\n"));
    const fakeRig = join(d, "rig.mjs");
    writeFileSync(fakeRig, 'process.stdout.write("{}");\n');
    let spawned = false;
    await runScenarioFile(scenarioPath, {
      rigBin: fakeRig,
      baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
      daemon: (async () => ({
        readEnv: { PATH: process.env.PATH }, baseUrl: "http://127.0.0.1:1",
        sigterm: async () => {}, restart: async () => {}, stop: async () => {},
      })) as never,
      spawnTui: () => { spawned = true; return fakeProc(); },
    });
    expect(spawned).toBe(false);
  });
});
