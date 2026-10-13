import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatRuntimeSwitchService } from "../src/domain/seat-runtime-switch-service.js";
import { recoverRuntimeSwitch, type RuntimeSwitchIntent } from "../src/domain/runtime-switch-recovery.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";

const run = promisify(exec);
const runFile = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Real tmux/process/SQLite plumbing with record-only runtimes. This does not
// impersonate native Claude/Codex readiness, authentication or conversation IO.
describe.skipIf(process.platform === "win32")("runtime switch with private native tmux", () => {
  async function fixture(runtime: "codex" | "claude-code" = "codex") {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-switch-")));
    const socket = path.join(root, "tmux.sock");
    const env = { ...process.env, HOME: root };
    delete env.TMUX; delete env.TMUX_TMPDIR;
    const db = createDb(path.join(root, "state.sqlite")); migrate(db, ALL_MIGRATIONS);
    cleanups.push(async () => {
      if (db.open) db.close();
      await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    });
    await runFile("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "fixture", "sleep 120"], { env });
    await runFile("tmux", ["-S", socket, "set-option", "-g", "default-shell", "/bin/sh"], { env });
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("switch");
    const node = rigRepo.addNode(rig.id, "dev.owner", { runtime, cwd: root });
    const name = "dev-owner@switch";
    const old = sessionRegistry.registerSession(node.id, name); sessionRegistry.updateStatus(old.id, "running");
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    const newTmux = (sourceDb = db) => {
      const adapter = new TmuxAdapter(async command => (await run(command.startsWith("tmux ")
        ? `tmux -S ${shellQuote(socket)} ${command.slice(5)}` : command, { env })).stdout, undefined,
      async argv => {
        const out = (await runFile(argv[0]!, ["-S", socket, ...argv.slice(1)], { env })).stdout;
        if (argv.includes("#{session_id}")) expect(out, JSON.stringify(argv)).toMatch(/^\$\d+\s*$/);
        return out;
      });
      adapter.deliveryGuard = new SeatDeliveryGuard(sourceDb, target => resolveGuardTarget(sourceDb, target));
      return adapter;
    };
    const tmux = newTmux();
    const script = path.join(root, "record.cjs");
    fs.writeFileSync(script, `const fs = require('node:fs');
const record = process.argv[3];
fs.writeFileSync(record, JSON.stringify({runtime:process.argv[2], pid:process.pid, node:process.env.OPENRIG_NODE_ID,
  seat:process.env.OPENRIG_SESSION_NAME, generation:process.env.OPENRIG_OCCUPANT_GENERATION})+'\\n');
process.stdin.setEncoding('utf8'); process.stdin.on('data', text => fs.appendFileSync(record, JSON.stringify({text})+'\\n'));
process.stdout.write('FIXTURE_READY\\n');
`);
    const records = (provider: string) => fs.readFileSync(path.join(root, provider + ".jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const runtimes = (transport: TmuxAdapter): Record<string, RuntimeAdapter> => Object.fromEntries(["codex", "claude-code"].map(provider => [provider, {
      runtime: provider,
      listInstalled: async () => [], project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding: NodeBinding, options: { name: string; resumeToken?: string; forkSource?: unknown }) => {
        expect(options.resumeToken).toBeUndefined(); expect(options.forkSource).toBeUndefined(); expect(options.name).toBe(name);
        const command = `exec ${shellQuote(process.execPath)} ${shellQuote(script)} ${provider} ${shellQuote(path.join(root, provider + ".jsonl"))}`;
        const result = await transport.sendShellCommand(binding.tmuxSession!, command, undefined, { stageIfLong: true });
        return result.ok ? { ok: true, resumeToken: `${provider}-fresh-id` } : { ok: false, error: result.message };
      },
      checkReady: async (binding: NodeBinding) => ({ ready: fs.existsSync(path.join(root, provider + ".jsonl"))
        && records(provider)[0].pid === await transport.getPanePid(binding.tmuxSession!)
        && await transport.getPaneCommand(binding.tmuxSession!) === path.basename(process.execPath) }),
    } satisfies RuntimeAdapter]));
    const adapters = runtimes(tmux);
    await tmux.deliveryGuard!.lifecycle([node.id], async () => {
      expect(await tmux.createSession(name, root, { OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: name,
        OPENRIG_RUNTIME: runtime, OPENRIG_OCCUPANT_GENERATION: generation })).toMatchObject({ ok: true });
      const pane = (await tmux.listPanes(name))[0]!.id;
      sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane });
      tmux.deliveryGuard!.rebindLifecycle(node.id);
      expect(await adapters[runtime]!.launchHarness({ id: "", nodeId: node.id, cwd: root, tmuxSession: name, tmuxPane: pane,
        tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", launchGeneration: generation }, { name })).toMatchObject({ ok: true });
    });
    tmux.finishLaunchBinding(name);
    await vi.waitFor(() => expect(records(runtime)[0].generation).toBe(generation));
    const oldPane = sessionRegistry.getBindingForNode(node.id)!.tmuxPane!;
    const deps = { db, rigRepo, sessionRegistry, eventBus, discoveryRepo: new DiscoveryRepository(db), tmuxAdapter: tmux,
      runtimeAdapters: adapters, readinessTimeoutMs: 3000, sleep: async (ms: number) => { await new Promise(resolve => setTimeout(resolve, Math.min(ms, 25))); } };
    const service = new SeatRuntimeSwitchService(deps);
    const switchRuntime = () => service.setRuntime({ seatRef: name, runtime: runtime === "codex" ? "claude-code" : "codex", reason: "fixture cutover" });
    return { ...deps, root, socket, env, node, rig, name, generation, oldPane, records, newTmux, runtimes, switchRuntime };
  }

  it.each(["codex", "claude-code"] as const)("replaces %s only after staging and sends activation to the canonical successor", async runtime => {
    const f = await fixture(runtime);
    const target = runtime === "codex" ? "claude-code" : "codex";
    const switched = await f.switchRuntime();
    expect(switched, JSON.stringify(switched)).toMatchObject({ ok: true, changed: true, recoveryPending: false });
    const pane = (await f.tmuxAdapter.listPanes(f.name))[0]!.id;
    expect(pane).not.toBe(f.oldPane);
    expect(await f.tmuxAdapter.getSessionEnv(f.name, "OPENRIG_RUNTIME")).toBe(target);
    expect(f.records(target)[0]).toMatchObject({ seat: f.name, node: f.node.id,
      generation: f.sessionRegistry.currentOccupantTenure(f.node.id)!.generationUuid });
    await vi.waitFor(() => expect(f.records(target).map(row => row.text ?? "").join("")).toContain("is committed"));
    const handover = f.records(target).map(row => row.text ?? "").join("");
    expect(handover).toContain("wait for the OpenRig activation reminder");
    expect(f.records(runtime).map(row => row.text ?? "").join("")).not.toContain("is committed");
    expect((await f.tmuxAdapter.listSessions()).map(session => session.name).sort()).toEqual([f.name, "fixture"].sort());
  }, 20_000);

  it("swaps the original live process back if the DB commit fails", async () => {
    const f = await fixture();
    const oldPid = f.records("codex")[0].pid;
    const persist = f.eventBus.persistWithinTransaction.bind(f.eventBus);
    let attemptedCommit = false;
    vi.spyOn(f.eventBus, "persistWithinTransaction").mockImplementation(event => {
      if (event.type === "seat.runtime_changed") { attemptedCommit = true; throw new Error("fixture transaction failure"); }
      return persist(event);
    });
    expect(await f.switchRuntime()).toMatchObject({ ok: false, recoveryPending: false });
    expect(attemptedCommit).toBe(true);
    expect((await f.tmuxAdapter.listPanes(f.name))[0]!.id).toBe(f.oldPane);
    expect(await f.tmuxAdapter.getPanePid(f.name)).toBe(oldPid);
    expect(f.sessionRegistry.currentOccupantTenure(f.node.id)!.generationUuid).toBe(f.generation);
    expect(f.db.prepare("SELECT * FROM seat_runtime_switches").all()).toEqual([]);
  }, 20_000);

  it.each(["preparing", "committed"] as const)("recovers a persisted %s exchange with fresh transport custody", async phase => {
    const f = await fixture();
    let exchanged = false;
    if (phase === "preparing") {
      const swap = f.tmuxAdapter.swapRuntimeSwitchPanes.bind(f.tmuxAdapter);
      vi.spyOn(f.tmuxAdapter, "swapRuntimeSwitchPanes").mockImplementationOnce(async input => {
        const result = await swap(input);
        expect(result).toMatchObject({ ok: true });
        exchanged = true;
        throw new Error("fixture interrupted after physical swap");
      });
    }
    const custody = phase === "preparing" ? vi.spyOn(f.tmuxAdapter, "recoverRuntimeSwitchSession") : null;
    custody?.mockRejectedValueOnce(new Error("fixture daemon unavailable"));
    if (phase === "committed") vi.spyOn(f.tmuxAdapter, "signalPaneProcess").mockRejectedValueOnce(new Error("fixture daemon unavailable"));
    const switched = await f.switchRuntime();
    expect(switched, JSON.stringify(switched)).toMatchObject({ ok: phase === "committed", recoveryPending: true });
    if (phase === "preparing") expect(exchanged).toBe(true);
    f.db.close();
    const restartedDb = createDb(path.join(f.root, "state.sqlite"));
    cleanups.push(async () => { restartedDb.close(); });
    const intent = restartedDb.prepare("SELECT * FROM seat_runtime_switches").get() as RuntimeSwitchIntent;
    expect(intent.phase).toBe(phase);
    const restarted = f.newTmux(restartedDb);
    expect(await recoverRuntimeSwitch(restartedDb, restarted, intent, f.runtimes(restarted), f.sleep)).toEqual({ complete: true });
    expect((await restarted.listPanes(f.name))[0]!.id).toBe(phase === "preparing" ? f.oldPane : intent.successor_pane);
    expect(restartedDb.prepare("SELECT * FROM seat_runtime_switches").all()).toEqual([]);
    expect((await restarted.listSessions()).map(session => session.name).sort()).toEqual([f.name, "fixture"].sort());
  }, 20_000);
});
