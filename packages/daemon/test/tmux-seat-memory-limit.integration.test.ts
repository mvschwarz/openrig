// Real MemoryMax readback beside the unchanged TasksMax control in tmux-seat-process-limits.integration.test.ts.
// Opt in on the same qualified Linux/systemd/cgroup-v2 lane with OPENRIG_TEST_SEAT_SCOPE=1, inside the outer
// TasksMax/MemoryMax scope documented there. Build the CLI first. No model, OOM induction or delegation changes.
// A separate existing lane without memory delegation can also set OPENRIG_TEST_SEAT_MEMORY_UNDELEGATED=1;
// otherwise that refusal leg is explicitly NOT RUN. Merely skipping either leg is not MemoryMax proof.
// The maintained private app/scaffold serves the production status route to the compiled `rig seat status` CLI.
// Only fresh fixture-owned sockets, panes, scope units, database and HTTP listener are created/cleaned up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
import { execArgvCommand, execTmuxCommand } from "../src/adapters/tmux-exec.js";
import { seatRuntimeDir } from "../src/domain/seat-runtime-dir.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { runRig } from "./helpers/scenario-daemon.js";

const run = promisify(execFile);
const enabled = process.platform === "linux" && process.env.OPENRIG_TEST_SEAT_SCOPE === "1";
const noMemoryLane = process.env.OPENRIG_TEST_SEAT_MEMORY_UNDELEGATED === "1";
// A page-aligned ceiling for an idle shell/sleep, not an allocation or a resource-policy floor.
const MEMORY_MAX = 256 * 1024 * 1024;
const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");
const missingMemory = (result: TmuxResult) => !result.ok && result.processLimits?.kind === "unsupported"
  && result.processLimits.limit === "memory_max" && /memory.*(?:not delegated|not enforced)/.test(result.processLimits.reason);

describe.runIf(enabled)("real MemoryMax: physical pane scope and rig seat status", () => {
  const saved: Record<string, string | undefined> = {};
  let runtimeDir: string | undefined;
  let skipReason: string | undefined;
  let systemdVersion = "unknown";

  beforeAll(async () => {
    for (const key of ["TMUX", "TMUX_PANE", "MANAGERPID"]) { saved[key] = process.env[key]; delete process.env[key]; }
    const uid = process.getuid?.();
    runtimeDir = seatRuntimeDir(process.env) ?? (uid !== undefined && existsSync(`/run/user/${uid}`) ? `/run/user/${uid}` : undefined);
    if (!runtimeDir) { skipReason = "NOT RUN: no systemd user runtime directory"; return; }
    try {
      systemdVersion = (await run("/usr/bin/env", ["-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${runtimeDir}`,
        "systemctl", "--user", "show", "--property=Version", "--value"], { timeout: 10_000 })).stdout.trim();
      if (!/^0::\//m.test(readFileSync("/proc/self/cgroup", "utf8"))) { skipReason = "NOT RUN: not cgroup v2"; return; }
      await run("tmux", ["-V"], { timeout: 10_000 });
    } catch (error) { skipReason = `NOT RUN: lane prerequisites unavailable: ${(error as Error).message}`; }
  }, 35_000);
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  async function fixture() {
    const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    const db = createFullTestDb();
    const adapter = new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, ["-f", "/dev/null", "-S", scaffold.tmuxSocketPath]);
    const app = createTestApp(db, { tmux: adapter });
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { ...scaffold.env, DBUS_SESSION_BUS_ADDRESS: "disabled:" }, runtimeDir });
    adapter.seatProcessLimits = id => app.rigRepo.getNodeProcessLimits(id);
    const rig = app.rigRepo.createRig("memory-limit-fixture");
    const node = app.rigRepo.addNode(rig.id, "memory", { runtime: "codex", model: "fixture", processLimits: { memoryMax: MEMORY_MAX } });
    const sessionName = "memory@memory-limit-fixture";
    const tmux = (...args: string[]) => run("tmux", ["-f", "/dev/null", "-S", scaffold.tmuxSocketPath, ...args], { timeout: 10_000 })
      .then(r => r.stdout.trim());
    // This oracle deliberately reads /proc and memory.max itself, without readSeatProcessLimits/cgroupV2Path.
    const physical = async () => {
      const pane = await tmux("display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_id}");
      const pid = Number(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
      const cgroup = /^0::(.+)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8"))?.[1];
      if (!cgroup) throw new Error(`No cgroup-v2 path for fixture pane ${pane}, pid ${pid}`);
      return { pane, pid, cgroup, memoryMax: readFileSync(`/sys/fs/cgroup${cgroup}/memory.max`, "utf8").trim() };
    };
    let scope: string | undefined;
    let server: ReturnType<typeof serve> | undefined;
    return {
      async launch() {
        expect(await adapter.startServer()).toEqual({ ok: true });
        await tmux("set-option", "-g", "default-shell", "/bin/sh");
        await tmux("set-option", "-g", "default-command", "exec sleep 90");
        // Keep a test-owned pane for scaffold cleanup even when the limited launch is refused or stopped.
        // This is only a cleanup anchor; the TasksMax/unlimited control stays in the existing fixture.
        await tmux("new-session", "-d", "-s", "fixture-cleanup", "-c", scaffold.root, "sleep 90");
        const result = await adapter.createSession(sessionName, scaffold.root, { OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: sessionName });
        // Retain only this fresh seat's actual unit name, including when later assertions fail.
        if (await adapter.hasSession(sessionName)) {
          const pid = await tmux("display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_pid}");
          const group = /^0::(.+)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8"))?.[1];
          scope = group?.match(/\/(openrig-seat-memory_memory-limit-fixture-[0-9a-f]{8}\.scope)$/)?.[1];
        }
        return result;
      },
      physical,
      async status(pane: string) {
        const session = app.sessionRegistry.registerSession(node.id, sessionName);
        app.sessionRegistry.updateStatus(session.id, "running");
        app.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: pane });
        server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 });
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture listener has no owned port");
        const result = await runRig(["seat", "status", sessionName, "--json"],
          { ...scaffold.env, OPENRIG_URL: `http://127.0.0.1:${address.port}` }, rigBin);
        expect(result.code, JSON.stringify(result)).toBe(0);
        return JSON.parse(result.stdout);
      },
      hasSession: () => adapter.hasSession(sessionName),
      async close() {
        try {
          if (server) await new Promise<void>((resolve, reject) => (server as Server).close(error => error ? reject(error) : resolve()));
        } finally {
          db.close();
          try {
            if (scope) await run("/usr/bin/env", ["-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${runtimeDir}`,
              "systemctl", "--user", "stop", "--", scope], { timeout: 10_000 });
          } finally { scaffold.cleanup(); }
        }
      },
    };
  }

  it("a fresh memory_max seat's own memory.max equals configured bytes and rig seat status agrees", async ctx => {
    if (skipReason) ctx.skip(skipReason);
    if (!existsSync(rigBin)) ctx.skip("NOT RUN: compiled CLI absent; build the repository before the qualified lane run");
    const f = await fixture();
    try {
      const result = await f.launch();
      if (missingMemory(result)) ctx.skip(`NOT RUN: ${result.processLimits!.reason}`);
      expect(result).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty("processLimits");
      const physical = await f.physical();
      expect(physical.cgroup).toMatch(/\/openrigseats\.slice\/openrig-seat-memory_memory-limit-fixture-[0-9a-f]{8}\.scope$/);
      expect(physical.memoryMax).toBe(String(MEMORY_MAX));
      const status = await f.status(physical.pane);
      expect(status.processLimits).toMatchObject({ state: "applied", requested: { memoryMax: MEMORY_MAX },
        memoryMax: physical.memoryMax, readFrom: "the seat's pane", scope: physical.cgroup.split("/").at(-1) });
      expect(status.processLimits).not.toHaveProperty("pidsMax"); // no tasks_max requested on this fresh seat
      expect(await f.physical()).toEqual(physical);
      console.info("MemoryMax physical/CLI receipt", { systemdVersion, configuredBytes: MEMORY_MAX, ...physical, processLimits: status.processLimits });
    } finally { await f.close(); }
  }, 90_000);

  it("a fresh launch without delegated memory is refused by the memory_max name", async ctx => {
    if (skipReason) ctx.skip(skipReason);
    if (!noMemoryLane) ctx.skip("NOT RUN: no existing lane selected with OPENRIG_TEST_SEAT_MEMORY_UNDELEGATED=1; do not change host delegation for this test");
    const f = await fixture();
    try {
      const result = await f.launch();
      expect(result).toMatchObject({ ok: false, code: "process_limits_unsupported", processLimits: {
        kind: "unsupported", limit: "memory_max", requested: { memoryMax: MEMORY_MAX },
      } });
      expect(missingMemory(result)).toBe(true);
      expect(await f.hasSession()).toBe(false);
      console.info("MemoryMax no-delegation refusal receipt", { systemdVersion, result });
    } finally { await f.close(); }
  }, 60_000);
});
