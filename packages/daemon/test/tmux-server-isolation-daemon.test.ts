import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { stageTopologyRoot } from "./helpers/scenario-stage.js";
import type { TmuxServerSelection } from "../src/domain/tmux-server-selection.js";
import Database from "better-sqlite3";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";

// The scenario grammar has no config-write or socket-inventory surface. Use its
// normal scaffold, daemon lifecycle, topology staging and stub seat, with native
// observations around real CLI commands. No model or desktop provider is used.
const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");
const SEAT = "dev-worker@scn-baton";
const nativeAvailable = process.platform !== "win32" && (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

describe.skipIf(!nativeAvailable)("daemon tmux server selection with a real stub seat", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  let smokeDb: Database.Database | undefined;
  const sockets = new Set<string>();
  const native = (socket: string, args: string[]) => execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...scaffold!.env, PATH: process.env.PATH },
  }).trim();

  afterEach(async () => {
    await daemon?.sigterm();
    smokeDb?.close(); smokeDb = undefined;
    if (scaffold) {
      // Even a startup/assertion failure must clean up an owned dedicated socket.
      const record = join(scaffold.openrigHome, "tmux-server.json");
      if (existsSync(record)) sockets.add(JSON.parse(readFileSync(record, "utf8")).socketPath);
      const root = realpathSync(scaffold.root);
      for (const socket of sockets) {
        const within = relative(root, socket);
        if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
          throw new Error("Refusing to clean up a tmux socket outside this fixture");
        }
        try { native(socket, ["kill-server"]); } catch { /* Already stopped is normal. */ }
      }
      scaffold.cleanup();
    }
    sockets.clear();
    scaffold = undefined;
    daemon = undefined;
  });

  it.each(["pi", "dsh", "omp", "rpc"] as const)("a managed %s runner uses actual launch authority for its supported native operations", async kind => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/sh", MOTD_SHOWN: "update-motd" } });
    const inputOnly = kind === "omp" || kind === "rpc";
    const root = scaffold.root, log = join(root, "native.log"), backend = join(root, "bin", kind === "pi" || kind === "omp" ? kind : `offline-${kind}.cjs`);
    const common = `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('offline-${kind}');process.exit(0);}const fs=require('node:fs');const send=x=>console.log(JSON.stringify(x));const log=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');log({pid:process.pid,ppid:process.ppid,token:!!process.env.OPENRIG_ACTIVITY_HOOK_TOKEN,run:!!process.env.OPENRIG_RUN_ID});`;
    writeFileSync(backend, kind !== "dsh" ? `${common}
const session=${JSON.stringify(join(root, "native.jsonl"))};fs.writeFileSync(session,'');let busy=false;
${kind === "omp" ? "send({type:'ready'});" : ""}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.type==='get_state')return send({type:'response',id:c.id,success:true,data:{sessionId:'fixture',sessionFile:session,isStreaming:busy,pendingMessageCount:0}});if(c.type==='get_entries')return send({type:'response',id:c.id,success:true,data:{entries:[]}});if(c.type!=='prompt')return;log({prompt:c.message});send({type:'response',id:c.id,success:true,data:{disposition:busy?'queued':'started'}});if(busy)return;busy=true;send({type:'agent_start'});setTimeout(()=>{send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'answer '+c.message}],stopReason:'stop'}});busy=false;send({type:'agent_end',isTerminal:true});},c.message==='SMOKE:across'?4000:50);});`
      : `${common}
if(process.argv.includes('--version')){console.log('offline-dsh');process.exit(0);}require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);const reply=result=>send({jsonrpc:'2.0',id:c.id,result});if(c.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{},agentInfo:{name:'dsh',version:'fixture'}});if(c.method==='session/new')return reply({sessionId:'fixture'});if(c.method!=='session/prompt')return;const text=c.params.prompt.map(p=>p.text||'').join('');log({prompt:text});send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer '+text}}}});setTimeout(()=>reply({stopReason:'end_turn'}),text==='SMOKE:across'?4000:50);});`, { mode: 0o755 });
    if (kind === "dsh" || kind === "rpc") {
      const presets = join(scaffold.openrigHome, "community-harnesses"); mkdirSync(presets, { recursive: true });
      writeFileSync(join(presets, kind === "rpc" ? "smoke-rpc.yaml" : "smoke-dsh.yaml"), kind === "rpc"
        ? `format: 1\nname: smoke-rpc\ncommand: ${JSON.stringify(backend)}\nmaintainer: Offline fixture\nprotocol: pi-rpc\nlimits: [offline RPC fixture]\n`
        : `format: 1\nname: smoke-dsh\ncommand: ${JSON.stringify(`${process.execPath} ${resolve(HERE, "../../../docs/reference/community-harness-examples/dsh/openrig-dsh-runner.mjs")}`)}\nmaintainer: Offline fixture\nrunner: true\nlaunch_result: true\nfirst_input: true\nlimits: [offline ACP fixture]\n`);
    }
    const staged = stageTopologyRoot(resolve(HERE, "fixtures/scenarios/topo-stub-baton.yaml"), join(root, "topology"));
    writeFileSync(staged.topologyPath, readFileSync(staged.topologyPath, "utf8").replace("runtime: stub", kind === "pi" || kind === "omp" ? `runtime: ${kind}`
      : kind === "rpc" ? "runtime: smoke-rpc" : `runtime: smoke-dsh\n        env:\n          DSH_SEAT_BIN: ${JSON.stringify(backend)}`));
    const active = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN, timeoutMs: 60000 }); daemon = active;
    const up = await runRig(["up", staged.topologyPath, "--json", "--yes"], active.readEnv, RIG_BIN, 120000);
    expect(up.code, `${up.stderr}\n${up.stdout}`).toBe(0);
    const readLog = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid?: number; ppid?: number; prompt?: string; token?: boolean; run?: boolean }) : [];
    const wait = async <T,>(probe: () => T | false | undefined, timeout = 12000): Promise<T | undefined> => {
      const deadline = Date.now() + timeout;
      for (;;) { const value = probe(); if (value) return value; if (Date.now() > deadline) return undefined; await new Promise(done => setTimeout(done, 50)); }
    };
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${active.baseUrl}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { nativeInput?: { input?: boolean; wake?: boolean; cancel?: boolean }; receipt?: { stage?: string; result?: Record<string, unknown> } } };
    };
    let status = await request(`/api/seat/status/${encodeURIComponent(SEAT)}`);
    for (let attempt = 0; !(inputOnly ? status.body.nativeInput?.input : status.body.nativeInput?.wake) && attempt < 100; attempt++) { await new Promise(done => setTimeout(done, 100)); status = await request(`/api/seat/status/${encodeURIComponent(SEAT)}`); }
    expect(inputOnly ? status.body.nativeInput?.input : status.body.nativeInput?.wake, JSON.stringify(status.body)).toBe(true);
    const db = new Database(join(scaffold.stateDir, "scenario.db"), { readonly: true });
    smokeDb = db;
    const grant = () => db.prepare("SELECT grant_id,node_id,run_id,session_id,generation,binding_json,revoked_at FROM activity_grants WHERE run_id IS NOT NULL AND activated_at IS NOT NULL AND revoked_at IS NULL").get() as Record<string, unknown> | undefined;
    const origin = grant(); expect(origin?.run_id).toBeTruthy();
    expect(new ActivityGrantStore(db).standing(String(origin!.grant_id))).toBe("current");
    const registry = new SessionRegistry(db);
    expect(registry.findResumeContextByName(SEAT)?.sessionId).toBe(origin!.session_id);
    const selected = JSON.parse(readFileSync(join(scaffold.openrigHome, "tmux-server.json"), "utf8")) as { socketPath: string };
    sockets.add(selected.socketPath);
    const pane = () => native(selected.socketPath, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"]);
    const originalPane = pane();
    const panePid = Number(originalPane.split(":")[1]);
    expect(db.prepare("SELECT input_route FROM nodes WHERE id=?").get(origin!.node_id)).toEqual({ input_route: "typed" });
    expect(JSON.parse(String(origin!.binding_json))).toMatchObject({ pane: originalPane.split(":")[0], panePid });
    expect((await request(`/api/seat/set-input-route/${encodeURIComponent(SEAT)}`, { route: "native", reason: "owned native fixture" })).status).toBe(200);
    const ancestry = (pid: number) => {
      const parents: number[] = [];
      while (pid > 1 && parents.length < 32) {
        parents.push(pid);
        pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
          encoding: "utf8", timeout: 5000, env: scaffold!.env,
        }).trim());
      }
      return parents;
    };
    if (inputOnly) {
      expect(status.body.nativeInput).toMatchObject({ input: true, wake: false, cancel: false });
      expect(JSON.parse(String(origin!.binding_json))).toMatchObject({ runtime: kind === "omp" ? "omp" : "smoke-rpc", runner: kind === "omp" ? 0 : 2 });
      expect(db.prepare("SELECT agent_app,agent_runner,resume_type FROM sessions WHERE id=?").get(origin!.session_id))
        .toMatchObject({ agent_app: kind === "omp" ? null : "smoke-rpc", agent_runner: kind === "omp" ? null : 2,
          resume_type: kind === "omp" ? "omp_session_file" : "community:smoke-rpc" });
      const outbox = new OutboxHandler(db);
      const receipts = () => outbox.runnerReceipts(String(origin!.node_id), String(origin!.run_id))
        .filter(receipt => String(receipt.payload.text).startsWith("ADOPTION:"));
      for (const text of ["ADOPTION:first", "ADOPTION:second"]) {
        // --raw removes only the CLI's normal From/To envelope; the selected native route remains guarded.
        const sent = await runRig(["send", SEAT, text, "--raw", "--json"], active.readEnv, RIG_BIN, 30000);
        expect(sent.code, `${sent.stderr}\n${sent.stdout}`).toBe(0);
        expect(await wait(() => readLog().some(entry => entry.prompt === text)), sent.stdout).toBe(true);
        expect(await wait(() => receipts().some(receipt => receipt.payload.text === text && receipt.stage === "completed"))).toBe(true);
      }
      expect(readLog().filter(entry => entry.prompt?.startsWith("ADOPTION:")).map(entry => entry.prompt)).toEqual(["ADOPTION:first", "ADOPTION:second"]);
      expect(receipts().map(receipt => receipt.payload.text)).toEqual(["ADOPTION:first", "ADOPTION:second"]);
      expect(receipts().map(receipt => receipt.sequence)).toEqual([...receipts().map(receipt => receipt.sequence)].sort((a, b) => a - b));
      for (const receipt of receipts()) expect(receipt).toMatchObject({ kind: "input", inputRoute: "native", runId: origin!.run_id });
      const child = readLog().find(entry => entry.pid)!;
      expect(child).toMatchObject({ token: false, run: false });
      expect(ancestry(child.pid!).slice(0, 2)).toEqual([child.pid, child.ppid]);
      expect(ancestry(child.ppid!)).toContain(panePid);
      db.close(); smokeDb = undefined;
      return; // Input-only adoption proves the managed launch join, not a duplicate crash/wake matrix.
    }
    const wake = (id: string) => request(`/api/seat/command/${encodeURIComponent(SEAT)}`, { requestId: id, type: "wake", question: id });
    const lookup = (id: string) => request(`/api/seat/command/${encodeURIComponent(SEAT)}?requestId=${encodeURIComponent(id)}`);
    await wake("SMOKE:before");
    expect(await wait(() => readLog().some(entry => entry.prompt === "SMOKE:before"))).toBe(true);
    for (let attempt = 0; (await lookup("SMOKE:before")).body.receipt?.stage !== "completed" && attempt < 100; attempt++) await new Promise(done => setTimeout(done, 50));
    expect((await lookup("SMOKE:before")).body.receipt?.result).toMatchObject({ completion: "completed", answer: "answer SMOKE:before" });
    await wake("SMOKE:across");
    expect(await wait(() => readLog().some(entry => entry.prompt === "SMOKE:across"))).toBe(true);
    expect((await lookup("SMOKE:across")).body.receipt?.stage).not.toBe("completed");
    const nativeProcess = readLog().find(entry => entry.pid && !entry.token)!;
    const nativePid = nativeProcess.pid!, receiverPid = nativeProcess.ppid!;
    expect(ancestry(nativePid).slice(0, 2)).toEqual([nativePid, receiverPid]);
    expect(ancestry(receiverPid)).toContain(panePid);
    process.kill(nativePid, 0); process.kill(receiverPid, 0);
    const state = JSON.parse(readFileSync(join(scaffold.openrigHome, "daemon.json"), "utf8")) as { pid: number; port: number; db: string };
    expect(state.port).toBe(active.port); expect(state.db).toBe(join(scaffold.stateDir, "scenario.db")); expect(state.pid).not.toBe(process.pid);
    process.kill(state.pid, "SIGKILL");
    await new Promise(done => setTimeout(done, 300)); process.kill(nativePid, 0); process.kill(receiverPid, 0);
    await active.restart();
    const restarted = JSON.parse(readFileSync(join(scaffold.openrigHome, "daemon.json"), "utf8")) as { pid: number };
    expect(restarted.pid).not.toBe(state.pid);
    expect(grant()).toEqual(origin);
    expect(pane()).toBe(originalPane);
    const current = registry.findResumeContextByName(SEAT); expect(current).not.toBeNull();
    expect(current!.nodeId).toBe(origin!.node_id);
    if (current!.sessionId !== origin!.session_id) expect(registry.isOccupantContinuedByAdoption(String(origin!.node_id), String(origin!.generation))).toBe(true);
    process.kill(nativePid, 0); process.kill(receiverPid, 0);
    expect(ancestry(nativePid).slice(0, 2)).toEqual([nativePid, receiverPid]);
    expect(ancestry(receiverPid)).toContain(panePid);
    let across = await lookup("SMOKE:across");
    for (let attempt = 0; across.body.receipt?.stage !== "completed" && attempt < 150; attempt++) { await new Promise(done => setTimeout(done, 100)); across = await lookup("SMOKE:across"); }
    expect(across.body.receipt?.result, JSON.stringify(across.body)).toMatchObject({ completion: "completed", answer: "answer SMOKE:across" });
    expect((await wake("SMOKE:across")).body.receipt?.result ?? (await lookup("SMOKE:across")).body.receipt?.result).toMatchObject({ answer: "answer SMOKE:across" });
    await wake("SMOKE:after");
    for (let attempt = 0; (await lookup("SMOKE:after")).body.receipt?.stage !== "completed" && attempt < 100; attempt++) await new Promise(done => setTimeout(done, 50));
    expect((await lookup("SMOKE:after")).body.receipt?.result).toMatchObject({ completion: "completed", answer: "answer SMOKE:after" });
    expect(readLog().filter(entry => entry.prompt?.startsWith("SMOKE:")).map(entry => entry.prompt)).toEqual(["SMOKE:before", "SMOKE:across", "SMOKE:after"]);
    expect(readLog().filter(entry => entry.pid && !entry.token).map(entry => entry.pid)).toEqual([nativePid]);
    db.close(); smokeDb = undefined;
  }, 180000);

  it("retains live legacy seats, migrates after down, and routes later reads, attachments and destruction to the selected server", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: {
      HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/sh", MOTD_SHOWN: "update-motd",
    } });
    native(scaffold.tmuxSocketPath, ["-f", "/dev/null", "new-session", "-d", "-s", "personal", "sleep 600"]);
    const personal = realpathSync(scaffold.tmuxSocketPath);
    sockets.add(personal);
    writeFileSync(join(scaffold.home, ".tmux.conf"), "set-option -g @openrig-isolation-fixture loaded\n");
    const staged = stageTopologyRoot(resolve(HERE, "fixtures/scenarios/topo-stub-baton.yaml"), join(scaffold.root, "topology"));
    const active = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN, timeoutMs: 60_000 });
    daemon = active;
    const rig = async (args: string[], env = active.readEnv) => {
      const result = await runRig(args, env, RIG_BIN, 120_000);
      expect(result.code, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
      return result;
    };
    const status = async (): Promise<TmuxServerSelection> => {
      const data = JSON.parse((await rig(["terminal", "status", "--json"])).stdout);
      expect(data.tmux).toBeDefined();
      sockets.add(data.tmux.socketPath);
      return data.tmux;
    };
    const inventory = async () => {
      const rigs = JSON.parse((await rig(["ps", "--json"])).stdout) as Array<{ rigId: string; rigName: string }>;
      const id = rigs.find(row => row.rigName === "scn-baton")!.rigId;
      const response = await fetch(`${active.baseUrl}/api/rigs/${id}/nodes`);
      expect(response.ok).toBe(true);
      return { id, rows: await response.json() as Array<{ canonicalSessionName: string; tmuxServerArgs: string[]; tmuxServerMode: string; tmuxAttachCommand: string }> };
    };

    expect(await status()).toMatchObject({ mode: "inherit", socketPath: personal, executionArgs: [], migrationPending: false });
    await rig(["up", staged.topologyPath, "--json", "--yes"]);
    const oldPane = native(personal, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"]);
    expect(oldPane).toMatch(/^%\d+:\d+$/);
    const initialNodes = await inventory();
    expect(initialNodes.rows.map(row => row.canonicalSessionName)).toContain(SEAT);
    expect(initialNodes.rows.find(row => row.canonicalSessionName === SEAT)!.tmuxServerMode).toBe("inherit");
    expect(native(personal, ["show-environment", "-t", `=${SEAT}`, "OPENRIG_HOME"]))
      .toBe(`OPENRIG_HOME=${realpathSync(scaffold.openrigHome)}`);
    const configured = await rig(["config", "set", "terminal.tmux_server", "isolated"]);
    expect(configured.stderr).toContain("surviving sessions keep their previous server");
    await active.restart();
    expect(native(personal, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"])).toBe(oldPane);
    expect(await status()).toMatchObject({ mode: "inherit", requestedMode: "isolated", socketPath: personal,
      migrationPending: true, blockingSessions: [SEAT] });
    expect((await inventory()).rows.find(row => row.canonicalSessionName === SEAT)!.tmuxServerArgs).toEqual(["-S", personal]);
    expect((await rig(["capture", SEAT, "--history-plus-pane", "--lines", "200", "--json"])).stdout).toContain("READY");

    await rig(["down", "scn-baton", "--json", "--force"]);
    expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
    await active.restart();
    const selected = await status();
    expect(selected).toMatchObject({ mode: "isolated", executionArgs: selected.serverArgs, migrationPending: false, blockingSessions: [] });
    expect(selected.socketPath).not.toBe(personal);
    // Restore the deliberately stopped team. The stub has no provider resume
    // history, so explicitly request a fresh seat within the same generation.
    // Fresh launches truthfully report partial restoration (CLI exit 1).
    const restored = await runRig(["up", "scn-baton", "--existing", "--fresh", "dev.worker", "--json", "--yes"],
      active.readEnv, RIG_BIN, 120_000);
    expect(restored.code, `${restored.stderr}\n${restored.stdout}`).toBe(1);
    expect(JSON.parse(restored.stdout)).toMatchObject({ status: "restored", rigId: initialNodes.id,
      rigResult: "partially_restored", nodes: [{ logicalId: "dev.worker", status: "fresh-primed" }] });
    expect(native(selected.socketPath!, ["list-sessions", "-F", "#{session_name}"])).toBe(SEAT);
    expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
    expect(native(selected.socketPath!, ["show-options", "-gqv", "@openrig-isolation-fixture"])).toBe("loaded");
    expect(native(personal, ["show-options", "-gqv", "@openrig-isolation-fixture"])).toBe("");
    const nodes = await inventory();
    expect(nodes.id).toBe(initialNodes.id);
    expect(nodes.rows).toHaveLength(1);
    expect(nodes.rows[0]!.tmuxServerArgs).toEqual(selected.serverArgs);
    expect(nodes.rows[0]!.tmuxServerMode).toBe("isolated");
    expect(nodes.rows[0]!.tmuxAttachCommand).toContain(selected.socketPath!);
    const preview = await (await fetch(`${active.baseUrl}/api/terminal/preview?view=scn-baton&provider=herdr`)).json();
    expect(preview.tmux).toMatchObject({ mode: "isolated", socketPath: selected.socketPath });
    expect(preview.composed.localTmuxServer).toEqual(selected.serverArgs);
    expect(preview.composed.opened[0].paneCommand).toContain(selected.socketPath!);

    // A personal namesake must neither capture nor adopt as this instance's seat.
    native(personal, ["new-session", "-d", "-s", SEAT, "printf 'PERSONAL_NAMESAKE\\n'; sleep 600"]);
    const personalPane = native(personal, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}"]);
    expect(personalPane).toMatch(/^%\d+$/);
    const capture = await rig(["capture", SEAT, "--json"]);
    expect(capture.stdout).toContain("READY");
    expect(capture.stdout).not.toContain("PERSONAL_NAMESAKE");
    const attach = await runRig(["attach", "--self", "--rig", nodes.id, "--pod", "dev", "--member", "foreign", "--runtime", "stub", "--json"],
      { ...active.readEnv, TMUX: `${personal},1,0`, TMUX_PANE: personalPane }, RIG_BIN);
    expect(attach.code, `${attach.stderr}\n${attach.stdout}`).toBe(1);
    expect(JSON.parse(attach.stdout)).toMatchObject({ code: "tmux_server_mismatch" });
    expect((await inventory()).rows).toHaveLength(1);

    const isolatedPane = native(selected.socketPath!, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"]);
    expect(isolatedPane).toMatch(/^%\d+:\d+$/);
    scaffold.env.TMUX = `${personal},1,0`;
    scaffold.env.TMUX_TMPDIR = join(scaffold.root, "different-tmp");
    mkdirSync(scaffold.env.TMUX_TMPDIR);
    await active.restart();
    expect(await status()).toMatchObject({ mode: "isolated", socketPath: selected.socketPath, migrationPending: false });
    expect(native(selected.socketPath!, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"])).toBe(isolatedPane);

    const destroyEnv = {
      ...active.readEnv, OPENRIG_PORT: String(active.port), OPENRIG_DB: join(scaffold.stateDir, "scenario.db"),
    };
    const recordFile = join(scaffold.openrigHome, "tmux-server.json");
    const recorded = readFileSync(recordFile, "utf8");
    unlinkSync(recordFile);
    try {
      const refused = await runRig(["destroy", "--all", "--yes", "--confirm", "destroy-openrig-state"], destroyEnv, RIG_BIN);
      expect(refused.code, `${refused.stderr}\n${refused.stdout}`).toBe(1);
      expect(`${refused.stderr}\n${refused.stdout}`).toContain("Missing tmux server record");
      expect(existsSync(destroyEnv.OPENRIG_DB)).toBe(true);
      expect(await status()).toMatchObject({ mode: "isolated", socketPath: selected.socketPath });
      expect(native(selected.socketPath!, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"])).toBe(isolatedPane);
      expect(native(personal, ["capture-pane", "-p", "-t", `=${SEAT}:`])).toContain("PERSONAL_NAMESAKE");
    } finally {
      writeFileSync(recordFile, recorded, { mode: 0o600 });
    }
    await rig(["destroy", "--all", "--yes", "--confirm", "destroy-openrig-state"], destroyEnv);
    daemon = undefined;
    expect(() => native(selected.socketPath!, ["has-session", "-t", `=${SEAT}`])).toThrow();
    expect(native(personal, ["has-session", "-t", `=${SEAT}`])).toBe("");
    expect(native(personal, ["capture-pane", "-p", "-t", `=${SEAT}:`])).toContain("PERSONAL_NAMESAKE");
  // Several daemon restarts and shipped CLI processes share the suite's worker budget.
  }, 420_000);
});
