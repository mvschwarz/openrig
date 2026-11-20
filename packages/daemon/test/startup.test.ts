import { execFileSync, spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { communityHarnessesDir } from "../src/domain/community-harness-presets.js";
import type { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAllowlistedProviderAuthEnv, createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { StreamStore } from "../src/domain/stream-store.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { DEFAULT_SYSTEM_WORLD_MANIFEST } from "../src/domain/system-world.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { OPENRIG_HOME } from "../src/openrig-compat.js";

const startupDnsFixture = vi.hoisted(() => ({
  discoveredNames: [] as string[],
  resolverQueries: [] as string[],
}));

vi.mock("../src/middleware/browser-boundary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/middleware/browser-boundary.js")>();
  return {
    ...actual,
    discoverTailscaleSelfNames: async () => startupDnsFixture.discoveredNames,
  };
});

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  class InertResolver {
    constructor(_options?: { timeout?: number; tries?: number }) {}
    setServers(_servers: string[]): void {}
    reverse(address: string): Promise<string[]> {
      startupDnsFixture.resolverQueries.push(address);
      return Promise.reject(new Error("inert DNS tripwire: reverse lookup refused"));
    }
  }
  const promises = { ...actual.promises, Resolver: InertResolver };
  return { ...actual, promises, default: { ...actual.default, promises } };
});

function saveEnv(...names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// Observe the private config while the mock tmux client consumes it, before unlink.
// Keep raw calls separate so value delivery cannot hide an argv exposure.
function captureLaunchConfig() {
  const configs: string[] = [];
  const tmuxExec = vi.fn<ExecFn>(async command => {
    const file = /source-file (?:'([^']+)'|(\S+))$/.exec(command);
    if (file) configs.push(fs.readFileSync(file[1] ?? file[2]!, "utf8"));
    return "";
  });
  return {
    tmuxExec,
    launchConfig: () => {
      const config = configs.find(text => text.startsWith("new-session "));
      expect(config).toBeDefined();
      return config!;
    },
    argv: () => tmuxExec.mock.calls.map(([command]) => command).join("\n"),
  };
}

function seedDbWithStaleSessions(dbPath: string, rigs: { rigName: string; logicalId: string; sessionName: string }[]) {
  const db = createDb(dbPath);
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, nodeSpecFieldsSchema, checkpointsSchema, agentspecRebootSchema]);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);

  for (const r of rigs) {
    const rig = rigRepo.createRig(r.rigName);
    const node = rigRepo.addNode(rig.id, r.logicalId);
    const session = sessionRegistry.registerSession(node.id, r.sessionName);
    // Seed the old schema directly; createDaemon must apply newer migrations.
    db.prepare("UPDATE sessions SET status = 'running', last_seen_at = datetime('now') WHERE id = ?").run(session.id);
  }

  db.close();
}

describe("createDaemon startup composition", () => {
  it.each([["omp", 0], ["adoption-rpc", 2]] as const)("the production %s/%i launch consumes private authority and native input through real SSE/RPC", async (runtime, runner) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-rpc-input-")), bin = path.join(root, "bin"), log = path.join(root, "native.log");
    fs.mkdirSync(bin);
    const seat = "worker@adoption-input", stateRoot = path.join(OPENRIG_HOME, "state", runtime === "omp" ? "omp" : "pi"), paths = piSeatPaths(stateRoot, seat);
    const preset = path.join(communityHarnessesDir(), "adoption-rpc.yaml");
    if (runner === 2) {
      fs.mkdirSync(path.dirname(preset), { recursive: true });
      fs.writeFileSync(preset, "format: 1\nname: adoption-rpc\ncommand: adoption-rpc\nmaintainer: fixture\nlimits: []\nprotocol: pi-rpc\n");
    }
    fs.writeFileSync(path.join(bin, "tmux"), `#!${process.execPath}
if(process.argv[2]==="show-environment")console.log(process.env.FIXTURE_KEY+"="+process.env.FIXTURE_GRANT);
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, runtime), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),send=x=>console.log(JSON.stringify(x)),log=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');
const dir=process.argv[process.argv.indexOf('--session-dir')+1],file=path.join(dir,'native.jsonl');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,'history');
log({childToken:!!process.env.OPENRIG_ACTIVITY_HOOK_TOKEN,childRun:!!process.env.OPENRIG_RUN_ID,childTransfer:!!process.env.FIXTURE_GRANT,provider:process.env.ANTHROPIC_API_KEY??process.env.OPENROUTER_API_KEY,providerCount:Number(!!process.env.ANTHROPIC_API_KEY)+Number(!!process.env.OPENROUTER_API_KEY),node:process.env.OPENRIG_NODE_ID,url:process.env.OPENRIG_URL,args:process.argv.slice(2)});
let busy=false;send({type:'ready'});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);log(c);
if(c.type==='get_state')return send({type:'response',id:c.id,success:true,data:{sessionFile:file,sessionId:'native-fixture',isStreaming:busy,pendingMessageCount:0}});
if(c.type==='get_entries')return send({type:'response',id:c.id,success:true,data:{entries:[]}});if(c.type!=='prompt')return;
if(c.message==='REFUSE')return send({type:'response',id:c.id,command:'prompt',success:false,error:'fixture refusal'});
send({type:'response',id:c.id,command:'prompt',success:true,data:c.message==='LOCAL'?{agentInvoked:false}:{}});if(c.message==='LOCAL'||busy)return;
busy=true;send({type:'agent_start'});setTimeout(()=>{busy=false;send({type:'agent_end',isTerminal:true});},500);
});
`, { mode: 0o755 });
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined, server: ReturnType<typeof serve> | undefined;
    const children: ReturnType<typeof spawn>[] = []; let output = "", lostAck = false, lostResult = false, hellos = 0;
    const savedUrl = process.env.OPENRIG_URL;
    try {
      // Production startup selects a compiled sibling runner; source-mode startup cannot launch that JS path.
      const { createDaemon: createBuiltDaemon } = await import("../dist/startup.js");
      const { seatAdapter: resolveAdapter } = await import("../dist/adapters/community-harness-runtime-adapter.js");
      server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
        const body = request.method === "POST" && new URL(request.url).pathname === "/api/activity/runner-channel" ? await request.clone().json() as { type: string } : null;
        if (body?.type === "hello") hellos += 1;
        const response = await daemon!.app.fetch(request);
        if (body?.type === "ack" && !lostAck) { lostAck = true; return new Response(null, { status: 503 }); }
        if (body?.type === "result" && !lostResult) { lostResult = true; return new Response(null, { status: 503 }); }
        return response;
      } });
      await new Promise<void>(resolve => server!.once("listening", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      process.env.OPENRIG_URL = url;
      daemon = await createBuiltDaemon({ tmuxExec: async () => "", cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
      const { db, deps } = daemon;
      const rig = deps.rigRepo.createRig("adoption-input"), node = deps.rigRepo.addNode(rig.id, "worker", { runtime, cwd: root });
      const row = deps.sessionRegistry.registerSession(node.id, seat);
      db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('input-binding',?,?,'%1')").run(node.id, seat);
      const privateEnv = new Map<string, string>(), issuedTokens: string[] = [];
      vi.spyOn(deps.tmuxAdapter, "getPanePid").mockResolvedValue(101);
      vi.spyOn(deps.tmuxAdapter, "getPaneCommand").mockResolvedValue("node");
      vi.spyOn(deps.tmuxAdapter, "getSessionEnv").mockImplementation(async (_seat, key) => ({ OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: seat, OPENRIG_RUNTIME: runtime, OPENRIG_URL: url }[key]));
      vi.spyOn(deps.tmuxAdapter, "setSessionEnv").mockImplementation(async (_seat, key, value) => { privateEnv.set(key, value); if (key.startsWith("OPENRIG_RUN_GRANT_")) issuedTokens.push(value); });
      vi.spyOn(deps.tmuxAdapter, "unsetSessionEnv").mockImplementation(async (_seat, key) => { privateEnv.delete(key); });
      vi.spyOn(deps.tmuxAdapter, "sendShellCommand").mockImplementation(async (_seat, command) => {
        const [key, token] = [...privateEnv][0]!;
        expect(command).not.toContain(token);
        const child = spawn("/bin/sh", ["-c", command], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: {
          PATH: `${bin}:${process.env.PATH}`, HOME: root, OPENRIG_HOME, OPENRIG_URL: url, OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: seat,
          OPENRIG_RUNTIME: runtime, ANTHROPIC_API_KEY: "fixture-omp-provider", OPENROUTER_API_KEY: "fixture-rpc-provider", FIXTURE_KEY: key, FIXTURE_GRANT: token } });
        child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); }); children.push(child);
        return { ok: true };
      });
      const binding = { ...deps.sessionRegistry.getBindingForNode(node.id)!, cwd: root, model: runtime === "omp" ? "anthropic/fixture" : "openrouter/fixture" };
      expect(await resolveAdapter(deps.runtimeAdapters, runtime, runner === 2 ? runtime : null)!.launchHarness(binding, { name: seat }), output).toMatchObject({ ok: true });
      const channel = deps.runnerChannel!, outbox = deps.outboxHandler!, transport = deps.sessionTransport!;
      await vi.waitFor(() => expect(channel.capable(node.id, "input"), output).toBe(true), { timeout: 7000 });
      expect(channel.capable(node.id, "wake")).toBe(false); expect(channel.capable(node.id, "cancel")).toBe(false);
      expect(db.prepare("SELECT agent_app,agent_runner,resume_type FROM sessions WHERE id=?").get(row.id))
        .toMatchObject({ agent_app: runner === 0 ? null : runtime, agent_runner: runner === 0 ? null : 2 });
      await vi.waitFor(() => expect(db.prepare("SELECT resume_type FROM sessions WHERE id=?").get(row.id))
        .toEqual({ resume_type: runner === 0 ? "omp_session_file" : "community:adoption-rpc" }));
      db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(node.id);
      const prompts = () => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "prompt").map(entry => entry.message);
      for (const text of ["LOCAL", "SLOW", "BUSY", "REFUSE"]) {
        await transport.send(seat, text, { deliveryId: text, actorSession: "sender" });
        await vi.waitFor(() => expect(outbox.runnerReceipt(text)?.stage, output).toBe(text === "REFUSE" ? "rejected" : "completed"), { timeout: 7000 });
      }
      await transport.send(seat, "BUSY", { deliveryId: "BUSY", actorSession: "sender" });
      expect(prompts()).toEqual(["LOCAL", "SLOW", "BUSY", "REFUSE"]);
      expect(lostAck && lostResult).toBe(true);
      const beforeReconnect = hellos;
      server.closeAllConnections();
      await vi.waitFor(() => { expect(hellos).toBeGreaterThan(beforeReconnect); expect(channel.capable(node.id, "input"), output).toBe(true); }, { timeout: 7000 });
      await transport.send(seat, "BUSY", { deliveryId: "BUSY", actorSession: "sender" });
      expect(prompts()).toEqual(["LOCAL", "SLOW", "BUSY", "REFUSE"]);
      const native = JSON.parse(fs.readFileSync(log, "utf8").split("\n")[0]!);
      expect(native).toMatchObject({ childToken: false, childRun: false, childTransfer: false, provider: runtime === "omp" ? "fixture-omp-provider" : "fixture-rpc-provider", providerCount: 1, node: node.id, url });
      if (runtime === "omp") expect(native.args).toContain("--approval-mode");
      expect(issuedTokens.length).toBeGreaterThan(0);
      const observedOutput = output + fs.readFileSync(log, "utf8");
      for (const token of issuedTokens) expect(observedOutput.includes(token)).toBe(false);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => { child.once("exit", resolve); child.kill("SIGKILL"); });
      }
      server?.closeAllConnections(); server?.close(); daemon?.eventLoopMonitor.stop(); daemon?.contextMonitor.stop(); daemon?.deps.seatActivityService?.stop(); daemon?.db.close();
      if (savedUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = savedUrl;
      if (runner === 2) fs.rmSync(preset, { force: true }); fs.rmSync(paths.seatRoot, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
  it("the assembled OMP launch and direct resume issue distinct private builtin0 run grants", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-omp-authority-"));
    const seat = "worker@omp-authority";
    const paths = piSeatPaths(path.join(OPENRIG_HOME, "state", "omp"), seat);
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({ tmuxExec: async () => "", cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
      const { db, deps } = daemon, grants = new ActivityGrantStore(db);
      const rig = deps.rigRepo.createRig("omp-authority"), node = deps.rigRepo.addNode(rig.id, "worker", { runtime: "omp", cwd: root });
      const row = deps.sessionRegistry.registerSession(node.id, seat);
      db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('omp-binding',?,?,'%1')").run(node.id, seat);
      const token = path.join(paths.sessionsDir, "history.jsonl");
      const privateEnv = new Map<string, string>();
      vi.spyOn(deps.tmuxAdapter, "getPanePid").mockResolvedValue(101);
      vi.spyOn(deps.tmuxAdapter, "setSessionEnv").mockImplementation(async (_seat, key, value) => { privateEnv.set(key, value); });
      vi.spyOn(deps.tmuxAdapter, "unsetSessionEnv").mockImplementation(async (_seat, key) => { privateEnv.delete(key); });
      const send = vi.spyOn(deps.tmuxAdapter, "sendShellCommand").mockImplementation(async (_seat, command) => {
        const issued = db.prepare("SELECT run_id FROM activity_grants WHERE node_id=? AND revoked_at IS NULL AND activated_at IS NULL ORDER BY grant_id DESC LIMIT 1").get(node.id) as { run_id: string } | undefined;
        expect(issued).toBeDefined();
        expect(privateEnv.size).toBeGreaterThan(0);
        for (const secret of privateEnv.values()) expect(command).not.toContain(secret);
        fs.mkdirSync(paths.sessionsDir, { recursive: true }); fs.writeFileSync(token, "history");
        fs.writeFileSync(paths.runnerStatePath, JSON.stringify({ ready: true, launchId: issued!.run_id, sessionFile: token, updatedAt: "t" }));
        return { ok: true };
      });
      const binding = { ...deps.sessionRegistry.getBindingForNode(node.id)!, cwd: root };
      expect(await deps.runtimeAdapters!.omp!.launchHarness(binding, { name: seat })).toMatchObject({ ok: true, resumeType: "omp_session_file" });
      const first = grants.activeForNode(node.id)!;
      expect(first).toMatchObject({ sessionId: row.id, binding: { runtime: "omp", runner: 0, pane: "%1", panePid: 101 } });
      expect(grants.standing(first.grantId)).toBe("current");
      const resume = (deps.restoreOrchestrator as unknown as { ompResume: OmpResumeAdapter }).ompResume;
      expect(await resume.resume(seat, "omp_session_file", token, root)).toMatchObject({ ok: true });
      const second = grants.activeForNode(node.id)!;
      expect(second.runId).not.toBe(first.runId);
      expect(grants.standing(first.grantId)).toBe("revoked");
      expect(grants.standing(second.grantId)).toBe("current");
      expect(db.prepare("SELECT agent_app,agent_runner FROM sessions WHERE id=?").get(row.id)).toEqual({ agent_app: null, agent_runner: null });
      expect(send).toHaveBeenCalledTimes(2);
      expect(db.prepare("SELECT COUNT(*) AS n FROM activity_grants WHERE node_id=?").get(node.id)).toEqual({ n: 2 });
    } finally {
      daemon?.eventLoopMonitor.stop(); daemon?.contextMonitor.stop(); daemon?.deps.seatActivityService?.stop(); daemon?.db.close();
      fs.rmSync(paths.seatRoot, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  // V0.3.1 slice 05 kernel-rig-as-default — startup tests construct
  // the daemon without booting the kernel rig. The kernel-boot path
  // is exercised separately in kernel-boot.test.ts (unit) +
  // kernel-rig-spec-validate.test.ts (variant gate); these tests
  // assert the surrounding daemon-composition contract, so the
  // OPENRIG_NO_KERNEL=1 escape hatch keeps them fast + deterministic
  // regardless of the host's runtime-auth state.
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
  });

  it("does not consult host Tailscale DNS while applying discovered startup names", async () => {
    const previousDiscoveredNames = startupDnsFixture.discoveredNames;
    const previousAllowedHosts = saveEnv("OPENRIG_ALLOWED_HOSTS");
    process.env.OPENRIG_ALLOWED_HOSTS = "";
    startupDnsFixture.discoveredNames = ["startup-fixture.tailnet.test"];
    startupDnsFixture.resolverQueries.length = 0;
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({
        tmuxExec: async () => "",
        cmuxFactory: async () => { throw Object.assign(new Error("fixture: no cmux"), { code: "ENOENT" }); },
      });
      const response = await daemon.app.request("/api/adapters/cmux/status", {
        headers: { Host: "startup-fixture.tailnet.test" },
      });
      const undiscoveredResponse = await daemon.app.request("/api/adapters/cmux/status", {
        headers: { Host: "other.tailnet.test" },
      });
      expect(startupDnsFixture.resolverQueries).toEqual([]);
      expect(response.status).toBe(200);
      expect(undiscoveredResponse.status).toBe(403);
      expect(await undiscoveredResponse.json()).toMatchObject({ code: "untrusted_host" });
    } finally {
      daemon?.eventLoopMonitor.stop();
      daemon?.db.close();
      startupDnsFixture.discoveredNames = previousDiscoveredNames;
      startupDnsFixture.resolverQueries.length = 0;
      restoreEnv(previousAllowedHosts);
    }
  });

  it.each(["configured", "native", "empty", "relative"])("the assembled classic clear uses the daemon's %s Claude baseline", async baseline => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "startup-clear-")));
    const home = path.join(root, "home"), cwd = path.join(root, "work"), bin = path.join(root, "bin");
    const configured = baseline === "configured" ? path.join(root, "configured-claude") : baseline === "empty" ? "" : baseline === "relative" ? "./relative-claude" : undefined;
    for (const dir of [home, cwd, bin]) fs.mkdirSync(dir);
    const saved = saveEnv("HOME", "PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME");
    process.env.HOME = home; process.env.PATH = `${bin}:/usr/bin:/bin`; delete process.env.CODEX_HOME;
    if (configured !== undefined) process.env.CLAUDE_CONFIG_DIR = configured; else delete process.env.CLAUDE_CONFIG_DIR;
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
    fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
console.log(JSON.stringify({home:process.env.CLAUDE_CONFIG_DIR??null}));
`, { mode: 0o700 });
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({ tmuxExec: async () => "", cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
      const { db, deps } = daemon;
      const rig = deps.rigRepo.createRig("clear-baseline");
      const node = deps.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", cwd });
      db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(path.join(root, "old-account"), node.id);
      const session = "worker@clear-baseline";
      const identity: Record<string, string> = { OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: session };
      vi.spyOn(deps.tmuxAdapter, "getPaneCommand").mockResolvedValue("sh");
      vi.spyOn(deps.tmuxAdapter, "getSessionEnv").mockImplementation(async (_session, key) => identity[key]);
      let observed: { home: string | null } | undefined;
      vi.spyOn(deps.tmuxAdapter, "sendShellCommand").mockImplementation(async (_session, command) => {
        observed = JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", cwd,
          env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(root, "old-account") } }));
        return { ok: true };
      });
      const adapter = deps.runtimeAdapters!["claude-code"] as ClaudeCodeAdapter;
      const binding = { nodeId: node.id, cwd, tmuxSession: session, tmuxPane: "%1", accountHome: null, accountToken: null };
      adapter.ensureManagedBootstrap(binding);
      const result = await adapter.launchHarness(binding as never, { name: "worker" });
      expect(result.ok).toBe(true);
      expect(observed?.home).toBe(configured ?? null);
      expect(fs.existsSync(path.join(configured === undefined ? home : path.resolve(cwd, configured), ".claude.json"))).toBe(true);
    } finally { daemon?.db.close(); homedir.mockRestore(); restoreEnv(saved); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("calls cmuxAdapter.connect() during startup", async () => {
    const connectCalled = vi.fn();
    const cmuxFactory: CmuxTransportFactory = async () => {
      connectCalled();
      const err = new Error("no socket") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    };
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxFactory, tmuxExec });

    // Factory was called during startup (connect() invoked)
    expect(connectCalled).toHaveBeenCalled();

    db.close();
  });

  it("a real hook clearing attention retries the refused handoff through the assembled queue", async () => {
    const { db, deps } = await createDaemon({ tmuxExec: async () => "",
      cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    try {
      const rig = deps.rigRepo.createRig("hook-retry");
      const node = deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
      const sessionName = "worker@hook-retry";
      deps.sessionRegistry.registerSession(node.id, sessionName);
      deps.sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%1" });
      const hook = (hookEvent: string) => deps.agentActivityStore!.recordHookEvent({ sessionName, runtime: "codex", hookEvent,
        generation: deps.sessionRegistry.currentOccupantGenerationForSession(sessionName) });
      const send = vi.spyOn(deps.sessionTransport!, "send")
        .mockResolvedValueOnce({ ok: false, sessionName, sent: false, reason: "target_needs_input",
          error: `Refused: '${sessionName}' is at an interactive prompt (selection_prompt). No text was sent.` })
        .mockResolvedValue({ ok: true, sessionName, sent: true, verified: true });
      hook("PermissionPromptConfirmed");
      const source = await deps.queueRepo!.create({ sourceSession: "planner@hook-retry", destinationSession: "builder@hook-retry", body: "build", nudge: false });
      const { created } = await deps.queueRepo!.handoff({ qitemId: source.qitemId, fromSession: "builder@hook-retry", toSession: sessionName, body: "review" });
      await vi.waitFor(() => expect(deps.queueRepo!.getById(created.qitemId)?.lastNudgeResult).toContain("failed:Refused:"));
      hook("PreToolUse");
      await vi.waitFor(() => expect(deps.queueRepo!.getById(created.qitemId)?.lastNudgeResult).toBe("verified"));
      expect(send).toHaveBeenCalledTimes(2);
    } finally { db.close(); }
  });

  // Slice 51-01 stub-runtime — STEP 2 (Registry-B composition, RED-first): the PRODUCTION runtime-adapter
  // registry assembled by createDaemon must register the "stub" adapter, so a runtime:stub seat resolves at
  // the exposed AppDeps.runtimeAdapters map (NOT only via a test-injected instantiator map). RED now:
  // startup.ts:898 runtimeAdapters = {claude-code, codex, pi, terminal} — no stub; goes green when the stub
  // adapter is constructed + registered (step 4). Drives the REAL createDaemon composition, not a mock.
  it("STEP2: createDaemon registers the stub adapter in the production runtimeAdapters registry [RED until startup.ts:898 adds stub]", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.runtimeAdapters, "AppDeps.runtimeAdapters exposed").toBeDefined();
      expect(deps.runtimeAdapters!["stub"], "production runtimeAdapters registry must register the stub adapter").toBeDefined();
    } finally {
      db.close();
    }
  }, 30000); // createDaemon full composition can exceed the 5s default on a cold start

  it("wires staged replacement into the production Claude collector adapter", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec: async () => "" });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "startup-collector-wiring-"));
    const copy = vi.spyOn(fs, "copyFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    try {
      const adapter = deps.runtimeAdapters!["claude-code"] as ClaudeCodeAdapter;
      adapter.ensureContextCollector({ cwd });
      adapter.ensureContextCollector({ cwd });
      const dest = path.join(cwd, ".openrig/context-collector.cjs");
      expect(rename).toHaveBeenCalledTimes(2);
      expect(rename).toHaveBeenCalledWith(expect.any(String), dest);
      expect(copy).toHaveBeenCalledTimes(2);
      expect(copy.mock.calls.every(call => call[1] !== dest && call[2] === fs.constants.COPYFILE_EXCL)).toBe(true);
      expect(fs.readFileSync(dest, "utf8")).toBe(fs.readFileSync(copy.mock.calls[0]![0], "utf8"));
    } finally {
      copy.mockRestore(); rename.mockRestore(); db.close(); fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  it("does not route the reduced model census through native process lineage checks", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec: async () => "" });
    try {
      // The model census deliberately omits foreground-group fields. Native
      // lineage readers must retain their full process-table default instead.
      expect(deps.listProcesses).toBeUndefined();
    } finally {
      db.close();
    }
  }, 30000);

  // GHOST-STAGE (e/Class-B) seam-coexist pin: dev-driver's fold added the invalidateRetiringOccupant
  // CALL at SeatHandoverService.commit() but no concrete invalidator was ever wired, so in production
  // the call was a silent no-op. This asserts createDaemon now constructs + injects a real
  // OccupantInvalidator — so the re-key invalidation actually FIRES (the service-level call-fires is
  // pinned separately in seat-handover-service.test.ts). Never lose a live call while deduping.
  it("wires a concrete OccupantInvalidator so the seat-handover re-key invalidation FIRES in production", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.occupantInvalidator, "AppDeps.occupantInvalidator must be constructed + injected").toBeDefined();
      expect(typeof deps.occupantInvalidator!.invalidateRetiringOccupant).toBe("function");
    } finally {
      db.close();
    }
  }, 30000);

  // Slice 51-01 stub-runtime — STEP 3 (first PRODUCTION dispatch proof, RED-first): the assembled
  // PodRigInstantiator's PRIVATE adapters map (startup.ts:710 — a SEPARATE literal from the :898
  // runtimeAdapters map STEP2 checks) must DISPATCH a runtime:stub seat to the stub adapter so its
  // project() lifecycle method is REACHED. Drives the REAL createDaemon composition + the production
  // instantiate() entry (NOT a test-injected adapters map; NOT error-string absence). RED now:
  // adapters[:710] = {claude-code,codex,pi,terminal}, no stub → instantiate hits "No adapter for
  // runtime stub" (rigspec-instantiator.ts:1669) and startNode/project (:130) are never reached.
  // GREEN when step 4 registers the stub adapter at :710. The 30s timeout is HARNESS BUDGET (cold
  // createDaemon compose), not product readiness.
  it("STEP3: the assembled instantiator dispatches runtime:stub → the stub adapter's project() is REACHED [RED until startup.ts:710 adds stub]", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    // REAL fs: the assembled instantiator uses fs.readFileSync (startup.ts:709), so agent_ref must
    // resolve to a real file at <rigRoot>/agents/impl/agent.yaml.
    const rigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-stub-dispatch-"));
    fs.mkdirSync(path.join(rigRoot, "agents", "impl"), { recursive: true });
    fs.writeFileSync(
      path.join(rigRoot, "agents", "impl", "agent.yaml"),
      `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`,
    );

    // A real selected World is required before dispatch. Supply the shipped
    // selector privately instead of relying on the operator's installation.
    const worldPath = path.join(rigRoot, "world.yaml");
    fs.writeFileSync(worldPath, DEFAULT_SYSTEM_WORLD_MANIFEST);
    const saved = saveEnv("OPENRIG_CONTEXT_SYSTEM_WORLD");
    process.env.OPENRIG_CONTEXT_SYSTEM_WORLD = worldPath;
    let db: ReturnType<typeof createDb> | undefined;
    try {
      const daemon = await createDaemon({ cmuxFactory, tmuxExec });
      db = daemon.db;
      const { deps } = daemon;
      // Reach the PRODUCTION instantiator's private adapters map (startup.ts:710).
      const adapters = (deps.podInstantiator as unknown as {
        deps: { adapters: Record<string, RuntimeAdapter> };
      }).deps.adapters;

      const stub = adapters["stub"];
      // RED-now guard: pre-step-4 the production instantiator adapters map has no stub adapter.
      expect(stub, "production instantiator adapters map (startup.ts:710) must register the stub adapter").toBeDefined();

      // Observe the NAMED lifecycle method on the REAL production adapter (spy calls through).
      const projectSpy = vi.spyOn(stub!, "project");

      const specYaml = RigSpecCodec.serialize({
        version: "0.2",
        name: "stub-dispatch-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: "." }],
          edges: [],
        }],
        edges: [],
      });

      const result = await deps.podInstantiator.instantiate(specYaml, rigRoot);

      // Load-bearing assertion: dispatch reached the stub adapter's project() (startup-orchestrator.ts:130).
      expect(projectSpy, `instantiate must dispatch project() to the production stub adapter: ${JSON.stringify(result)}`).toHaveBeenCalled();
    } finally {
      restoreEnv(saved);
      db?.close();
      fs.rmSync(rigRoot, { recursive: true, force: true });
    }
  }, 30000); // harness budget (cold createDaemon compose), not product readiness

  it("defaults terminal auth to local-trusted mode without minting a token file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-terminal-auth-"));
    const priorHome = process.env.OPENRIG_HOME;
    const priorToken = process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
    process.env.OPENRIG_HOME = tmpDir;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

      expect(deps.terminalBearerToken).toBeNull();
      expect(fs.existsSync(path.join(tmpDir, "terminal-token"))).toBe(false);

      db.close();
    } finally {
      if (priorHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = priorHome;
      if (priorToken === undefined) delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
      else process.env.OPENRIG_TERMINAL_BEARER_TOKEN = priorToken;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createDaemon app: GET /api/rigs/:rigId/sessions returns 200 (session routes mounted)", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

    // Seed a rig so the sessions endpoint has something to query
    const rig = deps.rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    db.close();
  });

  it("createDaemon queue validation accepts first-class human seats without a materialized kernel rig", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

    const canonical = await deps.queueRepo.create({
      sourceSession: "dev-qa@implementation-pair",
      destinationSession: "human-operator@kernel",
      body: "human gate smoke",
      tier: "human-gate",
      summary: "test summary (FR-4 human-routed fixture)",
      evidenceRef: "proof/test-evidence.md",
      nudge: false,
    });
    const generic = await deps.queueRepo.create({
      sourceSession: "dev-qa@implementation-pair",
      destinationSession: "human@host",
      body: "human host smoke",
      tier: "human-gate",
      summary: "test summary (FR-4 human-routed fixture)",
      evidenceRef: "proof/test-evidence.md",
      nudge: false,
    });

    expect(canonical.destinationSession).toBe("human-operator@kernel");
    expect(generic.destinationSession).toBe("human@host");
    const missing = await deps.queueRepo.create({
      sourceSession: "dev-qa@implementation-pair",
      destinationSession: "driver@phantom-rig",
      body: "keep work addressed to a missing rig",
      nudge: false,
    });
    expect(deps.queueRepo.getById(missing.qitemId)?.destinationSession).toBe("driver@phantom-rig");
    expect(deps.queueRepo.destinationAdvisory(missing.destinationSession)?.status).toBe("missing");

    db.close();
  });

  it("queue status checks pinned recorded/current addresses before absent or archived suffix rigs without registry reads", async () => {
    const daemon = await createDaemon({ cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); }, tmuxExec: async () => "" });
    const { db, deps } = daemon;
    try {
      const owner = deps.rigRepo.createRig("pinned-owner");
      const archived = deps.rigRepo.createRig("archived-suffix");
      db.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run("2026-01-01T00:00:00Z", archived.id);
      const node = deps.rigRepo.addNode(owner.id, "worker.pinned", { runtime: null });
      deps.sessionRegistry.registerSession(node.id, "pinned@missing-suffix");
      deps.sessionRegistry.updateBinding(node.id, { tmuxSession: "pinned@archived-suffix" });
      const hosted = vi.spyOn(deps.queueRepo, "isHostedMember");
      const fileReads = vi.spyOn(fs, "readFileSync");
      for (const destination of ["pinned@missing-suffix", "pinned@archived-suffix", "worker-pinned@pinned-owner"]) {
        expect(deps.queueRepo.destinationAdvisory(destination), destination).toBeNull();
      }
      expect(hosted).not.toHaveBeenCalled();
      expect(fileReads).not.toHaveBeenCalled();
      fileReads.mockRestore(); hosted.mockRestore();
      expect(deps.queueRepo.destinationAdvisory("absent@missing-suffix")?.status).toBe("missing");
      expect(deps.queueRepo.destinationAdvisory("absent@archived-suffix")?.status).toBe("archived");
      const other = deps.rigRepo.addNode(owner.id, "worker.other", { runtime: null });
      deps.sessionRegistry.registerSession(other.id, "pinned@missing-suffix");
      expect(deps.queueRepo.destinationAdvisory("pinned@missing-suffix")?.status).toBe("unknown");
    } finally {
      vi.restoreAllMocks(); daemon.eventLoopMonitor.stop(); daemon.contextMonitor.stop();
      deps.seatActivityService?.stop(); db.close();
    }
  });

  it("queue admission advises on missing local seats while preserving destinations", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const daemon = await createDaemon({ cmuxFactory, tmuxExec: async () => "" });
    const { app, db, deps } = daemon;
    try {
      const source = deps.rigRepo.createRig("membership-source");
      deps.rigRepo.addNode(source.id, "sender.ba", { runtime: null });
      const target = deps.rigRepo.createRig("membership-target");
      deps.rigRepo.addNode(target.id, "product.ba", { runtime: null });
      const stopped = deps.rigRepo.addNode(target.id, "product.stopped", { runtime: null });
      const session = deps.sessionRegistry.registerSession(stopped.id, "product-stopped@membership-target");
      deps.sessionRegistry.updateStatus(session.id, "exited");
      deps.rigRepo.addNode(target.id, "product.member.dot", { runtime: null });
      deps.rigRepo.addNode(target.id, "flat", { runtime: null });
      const adopted = deps.rigRepo.addNode(target.id, "product.adopted", { runtime: null });
      deps.sessionRegistry.registerSession(adopted.id, "adopted-alias@membership-target");
      const sender = "sender-ba@membership-source";
      const post = (url: string, body: Record<string, unknown>) => app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": sender },
        body: JSON.stringify({ nudge: false, ...body }),
      });
      const create = (destinationSession: string) => post("/api/queue/create", {
        destinationSession, body: "queue membership fixture",
      });
      const counts = () => ({
        items: (db.prepare("SELECT COUNT(*) count FROM queue_items").get() as { count: number }).count,
        transitions: (db.prepare("SELECT COUNT(*) count FROM queue_transitions").get() as { count: number }).count,
      });

      for (const destination of ["bare-seat"]) {
        const before = counts();
        const response = await create(destination);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("unknown_destination_rig");
        expect(counts()).toEqual(before);
      }
      for (const destination of ["product-ba@membership-target", "product-stopped@membership-target",
        "product-member.dot@membership-target", "flat@membership-target", "adopted-alias@membership-target"]) {
        const response = await create(destination);
        expect(response.status, destination).toBe(201);
        expect((await response.json()).advisories, destination).toBeUndefined();
      }
      const membershipReads = vi.spyOn(db, "prepare");
      for (const destination of ["product-ba@membership-target", "product-stopped@membership-target",
        "product-member.dot@membership-target", "flat@membership-target", "adopted-alias@membership-target"]) {
        expect(deps.queueRepo.destinationAdvisory(destination)).toBeNull();
      }
      const membershipSql = membershipReads.mock.calls.map(([query]) => query).join("\n");
      membershipReads.mockRestore();
      expect(membershipSql).not.toMatch(/\b(?:snapshots|events|node_startup_context)\b/);
      expect(membershipSql).not.toContain("SELECT n.logical_id, s.session_name");
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data) VALUES (?, ?, ?, ?, ?)")
        .run("advisory-unrelated-snapshot", target.id, "manual", "complete", JSON.stringify({ sessions: { unexpected: true } }));
      const withSnapshot = await create("product-ba@membership-target");
      expect(withSnapshot.status).toBe(201);
      expect((await withSnapshot.json()).advisories).toBeUndefined();
      const dotted = "product.ba@membership-target";
      expect(resolveGuardTarget(db, dotted)).toBeNull();
      expect(resolveGuardTarget(db, "product-ba@membership-target")).not.toBeNull();
      const dottedResponse = await create(dotted);
      expect(dottedResponse.status).toBe(201);
      const dottedResult = await dottedResponse.json();
      expect(dottedResult.destinationSession).toBe(dotted);
      expect(dottedResult.advisories[0].availableDestinations).toContain("product-ba@membership-target");
      expect(dottedResult.advisories[0].message).toContain("matches no session address");
      expect(deps.queueRepo.getById(dottedResult.qitemId)?.destinationSession).toBe(dotted);
      const dottedAlias = deps.rigRepo.addNode(target.id, "pod.adopted-dot", { runtime: null });
      deps.sessionRegistry.registerSession(dottedAlias.id, "adopted.dot@membership-target");
      const aliasResponse = await create("adopted.dot@membership-target");
      expect(aliasResponse.status).toBe(201);
      expect((await aliasResponse.json()).advisories).toBeUndefined();
      const typo = "prodcut-ba@membership-target";
      const response = await create(typo);
      expect(response.status).toBe(201);
      const accepted = await response.json();
      expect(accepted.destinationSession).toBe(typo);
      expect(accepted.advisories[0]).toMatchObject({ code: "unmatched_destination_seat", destinationSession: typo });
      expect(accepted.advisories[0].availableDestinations).toContain("product-ba@membership-target");
      expect(accepted.advisories[0].message).toContain("does not guarantee pickup or delivery");
      expect(deps.queueRepo.getById(accepted.qitemId)?.destinationSession).toBe(typo);
      const transactional = db.transaction(() => deps.queueRepo.createWithinTransaction({
        sourceSession: sender, destinationSession: typo,
        body: "transaction membership fixture", nudge: false,
      }))();
      expect(transactional.destinationSession).toBe(typo);

      for (const verb of ["handoff", "handoff-and-complete"]) {
        const original = await create(sender);
        expect(original.status).toBe(201);
        const { qitemId } = await original.json() as { qitemId: string };
        const row = () => db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId);
        const accepted = await post(`/api/queue/${qitemId}/${verb}`, { toSession: typo });
        expect(accepted.status).toBe(201);
        const result = await accepted.json();
        expect(result.created.destinationSession).toBe(typo);
        expect(result.advisories[0].code).toBe("unmatched_destination_seat");
        expect(deps.queueRepo.getById(result.created.qitemId)?.destinationSession).toBe(typo);
        expect((row() as { state: string }).state).toBe(verb === "handoff" ? "handed-off" : "done");
      }
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.contextMonitor.stop();
      deps.seatActivityService?.stop();
      db.close();
    }
  }, 30000);

  it("createDaemon app: GET /api/adapters/cmux/status returns 200 (adapter routes mounted)", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db } = await createDaemon({ cmuxFactory, tmuxExec });

    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("available");

    db.close();
  });

  it("passes daemon CLI reachability env and PATH into launched tmux sessions", async () => {
    const launchPath = `/proof/openrig/bin${path.delimiter}${process.env.PATH}`;
    vi.stubEnv("PATH", launchPath);
    vi.stubEnv("OPENRIG_PORT", "17433");
    vi.stubEnv("OPENRIG_HOST", "127.0.0.1");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const { tmuxExec, launchConfig, argv } = captureLaunchConfig();

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("path-env-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });

      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");

      expect(result.ok).toBe(true);
      const newSessionCmd = launchConfig();
      expect(newSessionCmd).toContain(`-e 'PATH=${launchPath}'`);
      expect(newSessionCmd).toContain("-e 'OPENRIG_PORT=17433'");
      expect(newSessionCmd).toContain("-e 'OPENRIG_HOST=127.0.0.1'");
      for (const key of ["PATH", "OPENRIG_PORT", "OPENRIG_HOST"]) expect(argv()).not.toContain(`${key}=`);

      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("GAP-7 projects the daemon HOME and default absolute CODEX_HOME into the production launch env", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-gap7-default-"));
    const daemonHome = path.join(root, "daemon-home");
    fs.mkdirSync(daemonHome, { recursive: true });
    const saved = saveEnv("HOME", "CODEX_HOME", "PATH", "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST", "OPENAI_API_KEY");
    process.env.HOME = daemonHome;
    delete process.env.CODEX_HOME;
    const launchPath = `/proof/openrig/bin${path.delimiter}${process.env.PATH}`;
    process.env.PATH = launchPath;
    process.env.OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST = "OPENAI_API_KEY";
    process.env.OPENAI_API_KEY = "gap7-openai-key";
    const { tmuxExec, launchConfig, argv } = captureLaunchConfig();
    let result: Awaited<ReturnType<typeof createDaemon>> | undefined;

    try {
      result = await createDaemon({
        cmuxFactory: async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); },
        tmuxExec,
      });
      expect(result.deps.sessionEnv).toMatchObject({
        HOME: daemonHome,
        CODEX_HOME: path.join(daemonHome, ".codex"),
        PATH: launchPath,
        OPENAI_API_KEY: "gap7-openai-key",
      });

      const rig = result.deps.rigRepo.createRig("gap7-default");
      result.deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
      expect((await result.deps.nodeLauncher.launchNode(rig.id, "worker")).ok).toBe(true);
      const command = launchConfig();
      expect(command).toContain(`-e 'HOME=${daemonHome}'`);
      expect(command).toContain(`-e 'CODEX_HOME=${path.join(daemonHome, ".codex")}'`);
      expect(command).toContain(`-e 'PATH=${launchPath}'`);
      expect(command).toContain("-e 'OPENAI_API_KEY=gap7-openai-key'");
      for (const key of ["HOME", "CODEX_HOME", "PATH", "OPENAI_API_KEY"]) expect(argv()).not.toContain(`${key}=`);
      expect(argv()).not.toContain("gap7-openai-key");
    } finally {
      result?.db.close();
      restoreEnv(saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP-7 shares one custom absolute CODEX_HOME between production session env and adapter config writes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-gap7-custom-"));
    const daemonHome = path.join(root, "daemon-home");
    const codexHome = path.join(root, "daemon-codex");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const saved = saveEnv("HOME", "CODEX_HOME");
    process.env.HOME = daemonHome;
    process.env.CODEX_HOME = codexHome;
    let result: Awaited<ReturnType<typeof createDaemon>> | undefined;

    try {
      result = await createDaemon({
        cmuxFactory: async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); },
        tmuxExec: async () => "",
      });
      expect(result.deps.sessionEnv).toMatchObject({ HOME: daemonHome, CODEX_HOME: codexHome });
      const adapter = result.deps.runtimeAdapters?.codex;
      expect(adapter).toBeDefined();
      await adapter!.deliverStartup([], {
        id: "gap7-binding", nodeId: "gap7-node", tmuxSession: "gap7-session",
        tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
        updatedAt: "", cwd: workspace,
      });
      const configPath = path.join(codexHome, "config.toml");
      expect(fs.readFileSync(configPath, "utf8")).toContain(`[projects."${workspace}"]`);
      expect(fs.existsSync(path.join(daemonHome, ".codex", "config.toml"))).toBe(false);
      const { CodexRuntimeAdapter } = await import("../src/adapters/codex-runtime-adapter.js");
      if (!(adapter instanceof CodexRuntimeAdapter)) throw new Error("expected the production Codex adapter");
      adapter.ensureCodexActivityHooks();
      const relay = path.join(OPENRIG_HOME, "runtime/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
      expect(fs.readFileSync(configPath, "utf8")).toContain(`node "${relay}"`);
      expect(fs.readFileSync(relay)).toEqual(fs.readFileSync(path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")));
    } finally {
      result?.db.close();
      restoreEnv(saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP-7 rejects relative CODEX_HOME during composition before any tmux session launch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-gap7-relative-"));
    const saved = saveEnv("HOME", "CODEX_HOME");
    process.env.HOME = path.join(root, "daemon-home");
    process.env.CODEX_HOME = "relative-codex-home";
    const tmuxExec = vi.fn<ExecFn>(async () => "");
    let result: Awaited<ReturnType<typeof createDaemon>> | undefined;
    let thrown: unknown;

    try {
      try {
        result = await createDaemon({
          cmuxFactory: async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); },
          tmuxExec,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/CODEX_HOME.*absolute/i);
      expect(tmuxExec.mock.calls.some((call) => call[0].includes("tmux new-session"))).toBe(false);
    } finally {
      result?.db.close();
      restoreEnv(saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // OPR.0.4.3.28 Blocker 2 — the self-provisioned OPENRIG_URL must honor an
  // explicit daemon bind host (the daemon binds only that host), not a hardcoded
  // loopback that a tailnet/hostname-bound daemon is not listening on.
  it("self-provisions OPENRIG_URL from an explicit bind host into launched tmux sessions", async () => {
    vi.stubEnv("OPENRIG_PORT", "17433");
    vi.stubEnv("OPENRIG_HOST", "100.64.0.5");
    vi.stubEnv("OPENRIG_URL", ""); // NOT operator-supplied → daemon derives it
    vi.stubEnv("OPENRIG_ACTIVITY_HOOK_TOKEN", "");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const { tmuxExec, launchConfig, argv } = captureLaunchConfig();
    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("url-derive-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");
      expect(result.ok).toBe(true);
      const newSessionCmd = launchConfig();
      expect(newSessionCmd).toContain("-e 'OPENRIG_URL=http://100.64.0.5:17433'");
      expect(argv()).not.toContain("OPENRIG_URL=");
      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes only explicitly allowlisted provider auth env into launched tmux sessions", async () => {
    vi.stubEnv("OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST", "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENAI_API_KEY,BOGUS_TOKEN");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-test-token");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubEnv("BOGUS_TOKEN", "must-not-leak");
    vi.stubEnv("OPENRIG_ACTIVITY_HOOK_TOKEN", "synthetic-startup-hook-token");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const { tmuxExec, launchConfig, argv } = captureLaunchConfig();

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("provider-auth-env-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");

      expect(result.ok).toBe(true);
      const newSessionCmd = launchConfig();
      expect(newSessionCmd).toContain("-e 'ANTHROPIC_API_KEY=anthropic-test-key'");
      expect(newSessionCmd).toContain("-e 'CLAUDE_CODE_OAUTH_TOKEN=claude-oauth-test-token'");
      expect(newSessionCmd).toContain("-e 'OPENAI_API_KEY=openai-test-key'");
      expect(newSessionCmd).not.toContain("BOGUS_TOKEN");
      expect(newSessionCmd).not.toContain("must-not-leak");
      expect(newSessionCmd).toContain("-e 'OPENRIG_ACTIVITY_HOOK_TOKEN=synthetic-startup-hook-token'");
      for (const value of ["anthropic-test-key", "claude-oauth-test-token", "openai-test-key", "synthetic-startup-hook-token", "must-not-leak"]) {
        expect(argv()).not.toContain(value);
      }

      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forwards the Codex Bedrock bearer token into a launched session only when the operator names it (#194)", async () => {
    const launchCommand = async (allowlist: string) => {
      vi.stubEnv("OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST", allowlist);
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-bedrock-token");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-unrelated-secret");
      const cmuxFactory: CmuxTransportFactory = async () => {
        throw Object.assign(new Error(""), { code: "ENOENT" });
      };
      const { tmuxExec, launchConfig, argv } = captureLaunchConfig();
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      try {
        const rig = deps.rigRepo.createRig("bedrock-forwarding-rig");
        deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
        expect((await deps.nodeLauncher.launchNode(rig.id, "worker")).ok).toBe(true);
        expect(argv()).not.toContain("synthetic-bedrock-token");
        expect(argv()).not.toContain("synthetic-unrelated-secret");
        return launchConfig();
      } finally {
        db.close();
      }
    };

    try {
      const optedIn = await launchCommand("AWS_BEARER_TOKEN_BEDROCK,AWS_SECRET_ACCESS_KEY");
      expect(optedIn).toContain("-e 'AWS_BEARER_TOKEN_BEDROCK=synthetic-bedrock-token'");
      expect(optedIn).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(optedIn).not.toContain("synthetic-unrelated-secret");

      const notNamed = await launchCommand("OPENAI_API_KEY");
      expect(notNamed).toContain("new-session ");
      expect(notNamed).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("collectAllowlistedProviderAuthEnv ignores empty, invalid, and unknown names", () => {
    expect(collectAllowlistedProviderAuthEnv(
      "ANTHROPIC_API_KEY, nope, ../BAD, OPENAI_API_KEY, BOGUS_TOKEN, CLAUDE_CODE_OAUTH_TOKEN",
      {
        ANTHROPIC_API_KEY: "anthropic-test-key",
        OPENAI_API_KEY: "",
        BOGUS_TOKEN: "must-not-leak",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-test-token",
      },
    )).toEqual({
      ANTHROPIC_API_KEY: "anthropic-test-key",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-test-token",
    });
  });

  it("collectAllowlistedProviderAuthEnv forwards ANTHROPIC_BASE_URL only when named", () => {
    const env = {
      ANTHROPIC_API_KEY: "gateway-test-key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
    };
    expect(collectAllowlistedProviderAuthEnv("ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL", env)).toEqual({
      ANTHROPIC_API_KEY: "gateway-test-key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
    });
    expect(collectAllowlistedProviderAuthEnv("ANTHROPIC_API_KEY", env)).toEqual({
      ANTHROPIC_API_KEY: "gateway-test-key",
    });
  });

  it("createDaemon wires node cmux service for POST /api/rigs/:rigId/nodes/:logicalId/open-cmux", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") return { capabilities: ["workspace.current", "surface.create", "surface.focus"] };
        if (method === "workspace.current") return { workspace_id: "workspace:1" };
        if (method === "surface.create") return { created_surface_ref: "surface:99" };
        return {};
      },
      close: () => {},
    });
    const tmuxExec: ExecFn = async () => "";

    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    const rig = deps.rigRepo.createRig("r01");
    const node = deps.rigRepo.addNode(rig.id, "dev1-impl");
    deps.sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    deps.sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "r01-dev1-impl",
    });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    const binding = deps.sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");

    db.close();
  });

  it("createDaemon accepts cmuxExec, connect() probes the live cmux surface through it", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" })
    );
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxExec, tmuxExec });

    // The injected cmuxExec was called during startup connect().
    // The transport now probes the live command surface via `cmux --help`
    // before issuing version-adaptive requests.
    expect(cmuxExec).toHaveBeenCalled();
    const helpCall = cmuxExec.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("cmux --help")
    );
    expect(helpCall).toBeDefined();

    db.close();
  });

  it("createDaemon with cmuxExec that throws -> still degrades cleanly", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" })
    );
    const tmuxExec: ExecFn = async () => "";

    const { app, db } = await createDaemon({ cmuxExec, tmuxExec });

    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);

    db.close();
  });

  it("startup reconciles stale session: status=detached + event row in DB", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
    ]);

    // tmux reports no sessions (session is gone):
    // list-sessions returns empty; has-session throws (session not found)
    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

    // After createDaemon returns, session should be detached
    const sessions = db.prepare("SELECT status FROM sessions").all() as { status: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("detached");

    // Event row should exist
    const events = db.prepare("SELECT type FROM events WHERE type = 'session.detached'").all();
    expect(events).toHaveLength(1);

    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("startup reconciles multiple rigs: all stale sessions detached", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
      { rigName: "r02", logicalId: "dev2-impl", sessionName: "r02-dev2-impl" },
    ]);

    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

    // Both sessions should be detached
    const sessions = db.prepare("SELECT status FROM sessions ORDER BY session_name").all() as { status: string }[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.status).toBe("detached");
    expect(sessions[1]!.status).toBe("detached");

    // Both events should exist
    const events = db.prepare("SELECT type FROM events WHERE type = 'session.detached'").all();
    expect(events).toHaveLength(2);

    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("startup reconcile with empty DB runs without error", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ tmuxExec, cmuxExec });

    // No sessions, no events, no errors
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(0);

    db.close();
  });

  // L1 cold-start tmux truth repair: startup must surface a compact reconcile
  // summary so silent reconciliation drift is visible in daemon output.
  it("startup logs compact reconcile summary line", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
    ]);

    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const summary = calls.find((line) => line.startsWith("startup reconcile:"));
      expect(summary).toBeDefined();
      expect(summary).toMatch(/rigs=1\b/);
      expect(summary).toMatch(/checked=1\b/);
      expect(summary).toMatch(/detached=1\b/);
      expect(summary).toMatch(/errors=0\b/);

      db.close();
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("does not let a throwing setDegradedHandler registration abort createDaemon", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const recorder = {
      setDegradedHandler() {
        throw new Error("registration boom");
      },
      snapshot: () => ({ healthy: true }),
    };
    const { db, eventLoopMonitor } = await createDaemon({
      cmuxFactory,
      tmuxExec,
      slowOpRecorder: recorder,
    } as never);
    eventLoopMonitor.stop();
    db.close();
  });

  it("isolates a throwing degradation callback body (streamStore.emit) from later work", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const originalEmit = StreamStore.prototype.emit;
    const spy = vi
      .spyOn(StreamStore.prototype, "emit")
      .mockImplementation(function (this: StreamStore, item: Parameters<StreamStore["emit"]>[0]) {
        if (typeof item?.body === "string" && item.body.includes("slow-operation instrumentation degraded")) {
          throw new Error("emit boom");
        }
        return originalEmit.call(this, item);
      });
    let captured: ((snapshot: { reason: string; site: string }) => void) | undefined;
    const recorder = {
      setDegradedHandler(handler: (snapshot: { reason: string; site: string }) => void) {
        captured = handler;
      },
      snapshot: () => ({ healthy: true }),
    };
    try {
      const { db, eventLoopMonitor } = await createDaemon({
        cmuxFactory,
        tmuxExec,
        slowOpRecorder: recorder,
      } as never);
      expect(captured).toBeTypeOf("function");
      // A later degradation fires the supplied callback; a throwing emit inside
      // its body must be swallowed, never escaping into wrapped work.
      expect(() => captured!({ reason: "recorder_worker_failed", site: "recorder.worker" })).not.toThrow();
      eventLoopMonitor.stop();
      db.close();
    } finally {
      spy.mockRestore();
    }
  });
});
