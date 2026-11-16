// The runner conformance check's test double and fake agent against OpenRig's real activity and answered permission
// routes, served over HTTP, instead of the check's stand-in: so the wire the check accepts is the wire OpenRig speaks.
// A person's click reaches the agent, OpenRig's permit is delivered, the seat's opt-in refusal is held, and an earlier
// occupant's request is cancelled, never asked. No model, tmux or Slack is involved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { AgentActivityStore, latestHookWaitsOnPerson } from "../src/domain/agent-activity-store.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { activityRoutes } from "../src/routes/activity.js";

const RUNNER = resolve(__dirname, "fixtures/runner-conformance/minimal-acp-runner.mjs");
const AGENT = resolve(__dirname, "../../../docs/reference/runner-conformance/fake-acp-agent.mjs");
const PERSON = "mike@external", SEAT = "dev-runner@perm-rig", INSTALL = "install-token";
const person = (id: string) => ({ entityId: id, class: "human" as const, displayName: id, address: `${id}@external`,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: `U${id.toUpperCase()}` }],
  prefs: { deliveryClass: "A" as const } });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function waitFor<T>(read: () => T | undefined | null | false, ms = 8000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(50);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type LogEntry = { at: number; dir: string; msg: { id?: number; method?: string; result?: { outcome?: { outcome: string; optionId?: string } } } };

// The daemon's own routes and stores on a fresh database, listening on a local port. `owner` is the seat's answer
// override ("deny" opts in to refusal); with none, the default person answers.
async function daemon(options: { people: string[]; owner?: string }) {
  const people = { ok: true as const, entities: options.people.map(person) };
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("perm-rig");
  const runner = rigs.addNode(rig.id, "dev.runner", { runtime: "synth" });
  const sessions = new SessionRegistry(db);
  const occupy = (kind?: "handover") => {
    const session = sessions.registerSession(runner.id, SEAT, kind);
    sessions.updateStatus(session.id, "running");
    sessions.recordCommunityHarnessSelection(session.id, "synth", true);
  };
  occupy();
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => people,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog: new MissionControlActionLog(db) });
  const store = new AgentActivityStore({ db, eventBus: bus,
    resolveOccupantGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  if (options.owner) db.prepare("UPDATE nodes SET permissions_to = ? WHERE id = ?").run(options.owner, runner.id);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, INSTALL as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("eventBus" as never, bus as never);
    c.set("queueRepo" as never, queueRepo as never);
    c.set("rigRepo" as never, rigs as never);
    c.set("missionControlWriteContract" as never, contract as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  app.route("/api/mission-control", missionControlRoutes());
  let server!: ReturnType<typeof serve>;
  const port = await new Promise<number>((ready) => { server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => ready(info.port)); });
  cleanups.push(async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
  });
  const asks = () => queueRepo.list({ limit: 100 }).filter((row) => row.tags?.includes("runner-permission"));
  return {
    base: `http://127.0.0.1:${port}`,
    nodeId: runner.id,
    generation: () => sessions.currentOccupantTenure(runner.id)!.generationUuid,
    relaunch: () => occupy("handover"),
    asks,
    /** A person answers in Steering: one offered option, as the Feed's click does, or typed words. */
    answer: async (askId: string, choice: { optionId: string } | { decision: string }) => (await app.request("/api/mission-control/action", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": PERSON },
      body: JSON.stringify({ verb: "answer", qitemId: askId, actorSession: PERSON,
        ...("optionId" in choice ? { questionId: "permission", optionId: choice.optionId } : { decision: choice.decision }) }) })).status,
    latest: () => store.getLatestForNode({ nodeId: runner.id, sessionName: SEAT }),
    waitsOnPerson: () => latestHookWaitsOnPerson(store.getLatestForNode({ nodeId: runner.id, sessionName: SEAT }), "synth"),
  };
}

// The test double with the fake agent, given the environment a runner-preset launch gives it, on plain pipes. Input
// arrives as `rig send` delivers it: one bracketed paste, then Enter.
/** Start a scripted runner and wait for its native reference before testing permission routes. */
async function launchRunner(d: Awaited<ReturnType<typeof daemon>>, scenario: object = { turns: [{ permission: true }, {}] }) {
  const dir = mkdtempSync(join(tmpdir(), "runner-real-routes-"));
  const log = join(dir, "agent.jsonl"), record = join(dir, "record.json");
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const agent = join(dir, "agent");
  writeFileSync(agent, `#!/bin/sh\nexec '${process.execPath}' '${AGENT}' --scenario '${join(dir, "scenario.json")}' --log '${log}' "$@"\n`);
  chmodSync(agent, 0o755);
  const child = spawn(process.execPath, [RUNNER, "--agent", agent], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: process.env.HOME, OPENRIG_URL: d.base, OPENRIG_ACTIVITY_HOOK_TOKEN: INSTALL, OPENRIG_SESSION_NAME: SEAT,
    OPENRIG_NODE_ID: d.nodeId, OPENRIG_RUNTIME: "synth", OPENRIG_OCCUPANT_GENERATION: d.generation(),
    OPENRIG_LAUNCH_RESULT: record, OPENRIG_LAUNCH_ATTEMPT: "attempt-1" } });
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
    // The agent can still be writing its last log line as it ends.
    await sleep(100);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const entries = (): LogEntry[] => !existsSync(log) ? [] : readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // Shell, runner and agent startup can be slower than the route checks under suite load.
  const opened = await waitFor(() => {
    if (!existsSync(record)) return undefined;
    try { return JSON.parse(readFileSync(record, "utf8")).nativeRef; }
    catch { return undefined; } // The runner may still be writing the record.
  }, 15000);
  expect(opened, "the runner opens its conversation and writes the launch record").toBeTruthy();
  return {
    send: (text: string) => child.stdin.write(`\x1b[200~${text}\x1b[201~\r`),
    asked: () => entries().find((e) => e.dir === "out" && e.msg.method === "session/request_permission"),
    /** Every answer the agent got to its permission request. */
    answers: () => { const asked = entries().find((e) => e.dir === "out" && e.msg.method === "session/request_permission");
      return asked ? entries().filter((e) => e.dir === "in" && e.msg.id === asked.msg.id && !e.msg.method) : []; },
    turnEnded: () => entries().some((e) => e.dir === "out" && (e.msg.result as { stopReason?: string } | undefined)?.stopReason),
  };
}

describe("the conformance check's test double against OpenRig's real permission routes", () => {
  it.each([["allow", "allow-once"], ["deny", "reject-once"]])("a person's click (%s) reaches the agent once, and the runner's posts count for the live occupant", async (_label, optionId) => {
    const d = await daemon({ people: ["mike"] });
    const r = await launchRunner(d);
    r.send("edit the notes");
    const ask = await waitFor(() => d.asks()[0]);
    expect(ask, "the request opens an ask").toBeTruthy();
    expect(ask).toMatchObject({ destinationSession: PERSON, sourceSession: SEAT, state: "pending" });
    // OpenRig records the seat's prompt for a created ask; the runner doesn't post it.
    expect(d.waitsOnPerson()).toBe(true);
    expect(r.answers()).toEqual([]);
    expect(await d.answer(ask!.qitemId, { optionId })).toBe(200);
    const got = await waitFor(() => r.answers()[0]);
    expect(got?.msg.result?.outcome).toEqual({ outcome: "selected", optionId });
    expect(await waitFor(() => r.turnEnded())).toBe(true);
    // The turn's end is the newest post, recorded for this occupant's generation.
    const idle = await waitFor(() => { const latest = d.latest(); return latest?.state === "idle" && latest; });
    expect(idle).toMatchObject({ generationProvenance: "resolved", stale: false });
    expect(r.answers()).toHaveLength(1);
  }, 60_000);

  it("OpenRig's permit, with no one to ask, is delivered at once and opens no ask", async () => {
    const d = await daemon({ people: [] });
    const r = await launchRunner(d);
    r.send("edit the notes");
    const got = await waitFor(() => r.answers()[0]);
    expect(got?.msg.result?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(d.asks()).toEqual([]);
    expect(await waitFor(() => r.turnEnded())).toBe(true);
    expect(d.waitsOnPerson()).toBe(false);
  }, 60_000);

  it("the seat's opt-in refusal (denied_by_seat) is refused at once and held as needs input", async () => {
    const d = await daemon({ people: ["mike"], owner: "deny" });
    const r = await launchRunner(d);
    r.send("edit the notes");
    const got = await waitFor(() => r.answers()[0]);
    expect(got?.msg.result?.outcome).toEqual({ outcome: "cancelled" });
    expect(d.asks()).toEqual([]);
    expect(await waitFor(() => d.waitsOnPerson())).toBe(true);
    expect(await waitFor(() => r.turnEnded())).toBe(true);
    await sleep(300);
    expect(d.waitsOnPerson(), "no idle post replaces the held attention").toBe(true);
  }, 60_000);

  it("a person's no, when the agent offered no reject option, reaches the agent as cancelled, never a grant, holding nothing", async () => {
    const d = await daemon({ people: ["mike"] });
    const options = [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "allow-always", name: "Always", kind: "allow_always" }];
    const r = await launchRunner(d, { turns: [{ permission: { options } }, {}] });
    r.send("edit the notes");
    const ask = await waitFor(() => d.asks()[0]);
    expect(ask, "the request opens an ask").toBeTruthy();
    expect(await d.answer(ask!.qitemId, { decision: "no" })).toBe(200);
    const got = await waitFor(() => r.answers()[0]);
    expect(got?.msg.result?.outcome).toEqual({ outcome: "cancelled" });
    expect(await waitFor(() => r.turnEnded())).toBe(true);
    // No person is still waiting, so the turn's end is reported and the seat doesn't read as needing one.
    expect(await waitFor(() => d.latest()?.state === "idle")).toBe(true);
    expect(d.waitsOnPerson()).toBe(false);
  }, 60_000);

  it("an earlier occupant's request is refused at submit (stale_generation), so the runner answers cancelled, opens no ask, and its posts don't count", async () => {
    const d = await daemon({ people: ["mike"] });
    const r = await launchRunner(d);
    const earlier = d.generation();
    d.relaunch();
    expect(d.generation()).not.toBe(earlier);
    r.send("edit the notes");
    const got = await waitFor(() => r.answers()[0]);
    expect(got?.msg.result?.outcome).toEqual({ outcome: "cancelled" });
    expect(d.asks()).toEqual([]);
    expect(await waitFor(() => r.turnEnded())).toBe(true);
    expect(await waitFor(() => d.latest()?.reason === "generation_mismatch" && d.latest())).toMatchObject({ state: "unknown" });
  }, 60_000);
});


describe("run-bound native channel custody", () => {
  async function fixture(enabled = true, runtime = "pi", runner = 2, file?: string,
    retained?: { node: { id: string }; grant: import("../src/domain/activity-grants.js").ActivityGrant & { token: string } }) {
    const { RunnerChannel } = await import("../src/domain/runner-channel.js");
    const { ActivityGrantStore } = await import("../src/domain/activity-grants.js");
    const db = createDb(file); migrate(db, ALL_MIGRATIONS); cleanups.push(() => { if (db.open) db.close(); });
    const rigs = new RigRepository(db);
    const node = retained?.node ?? rigs.addNode(rigs.createRig("channel").id, "dev", { runtime });
    const registry = new SessionRegistry(db);
    if (!retained) {
      registry.registerSession(node.id, "dev@channel");
      db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('binding',?,'dev@channel','%1')").run(node.id);
    }
    const grants = new ActivityGrantStore(db);
    const grant = retained?.grant ?? grants.issue({ nodeId: node.id, generation: registry.currentOccupantTenure(node.id)!.generationUuid, issuedBy: "launch",
      run: { runId: "run-one", binding: { runtime, runner, pane: "%1", panePid: 101 } } });
    if (!retained) expect(grants.activate(grant.grantId)).toBe(true);
    const { OutboxHandler } = await import("../src/domain/outbox-handler.js");
    const outbox = new OutboxHandler(db), channel = new RunnerChannel(grants, outbox, enabled ? new Set([runner === 0 ? "managed-pi" : runner === 1 ? "preset" : "hosted-pi-rpc"]) : new Set());
    const { SeatDeliveryGuard, resolveGuardTarget } = await import("../src/domain/seat-delivery-guard.js");
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const { seatRoutes } = await import("../src/routes/seat.js");
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    const tmux = { deliveryGuard: guard };
    const transport = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: registry, tmuxAdapter: tmux as never, runnerChannel: channel });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("runnerChannel" as never, channel); c.set("rigRepo" as never, rigs);
      c.set("tmuxAdapter" as never, tmux); c.set("sessionTransport" as never, transport); await next();
    });
    app.route("/api/activity", activityRoutes); app.route("/api/seat", seatRoutes);
    const hello = { type: "hello", version: 1, runId: "run-one", retained: true, capabilities: { input: true, wake: true, cancel: true } };
    const admit = (id: string) => channel.admit(grant.nodeId, { outboxId: id, senderSession: "sender", destinationSession: "dev@channel", body: id,
      kind: "input", inputRoute: "native", payload: { text: id } });
    return { db, node, grant, grants, outbox, channel, hello, admit, app, guard, transport };
  }
  async function nativeProcess(kind: "pi" | "dsh", program?: { bin: string; providerUrl: string }) {
    const dir = mkdtempSync(join(tmpdir(), `native-recovery-${kind}-`)), file = join(dir, "core.sqlite"), log = join(dir, "native.log");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { mkdirSync, unlinkSync, symlinkSync } = await import("node:fs"); const bin = join(dir, "bin"); mkdirSync(bin);
    const backend = join(bin, kind);
    const common = `#!${process.execPath}\nconst fs=require('node:fs');const send=x=>console.log(JSON.stringify(x));const log=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');log({childToken:!!process.env.OPENRIG_ACTIVITY_HOOK_TOKEN});`;
    // Distinct offline RPC and ACP backends. Each is exercised through its own production consumer.
    writeFileSync(backend, kind === "pi" ? `${common}
let busy=false;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);log(c);
if(c.type==='get_state')return send({type:'response',id:c.id,success:true,data:{isStreaming:busy,pendingMessageCount:0,sessionId:'fixture'}});
if(c.type==='get_entries')return send({type:'response',id:c.id,success:true,data:{entries:[]}});if(c.type!=='prompt')return;
if(c.message==='REFUSE')return send({type:'response',id:c.id,success:false,error:'fixture refusal'});
send({type:'response',id:c.id,command:'prompt',success:true,data:{disposition:busy?'queued':'started'}});if(busy)return;
busy=true;send({type:'agent_start'});setTimeout(()=>{send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'answer '+c.message}],stopReason:c.message==='INTERRUPT'?'aborted':'stop'}});busy=false;send({type:'agent_end'});},c.message.startsWith('SLOW')?900:80);
});` : `${common}
if(process.argv.includes('--version')){console.log('fixture dsh');process.exit(0);}const session='native-fixture';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);log(c);const reply=result=>send({jsonrpc:'2.0',id:c.id,result});
if(c.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{},agentInfo:{name:'dsh',version:'fixture'}});
if(c.method==='session/new')return reply({sessionId:session});if(c.method!=='session/prompt')return;
const text=c.params.prompt.map(p=>p.text||'').join('');if(text==='REFUSE')return send({jsonrpc:'2.0',id:c.id,error:{code:-32602,message:'fixture refusal'}});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer '+text}}}});
setTimeout(()=>reply({stopReason:text==='INTERRUPT'?'cancelled':'end_turn'}),text.startsWith('SLOW')?900:80);
});`, { mode: 0o755 });
    if (program && kind === "pi") {
      unlinkSync(backend); symlinkSync(program.bin, backend);
      const agent = join(dir, "state", "dev@channel", "agent"); mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { local: { baseUrl: program.providerUrl, api: "anthropic-messages", apiKey: "offline-dummy", models: [{ id: "fixture-model", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    }
    let current = await fixture(true, kind, kind === "pi" ? 0 : 1, file);
    let fault: { type: string; commit: boolean; hits: number } | null = null;
    let lookupDelay = 0;
    let hellos = 0;
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const body = request.method === "POST" && new URL(request.url).pathname === "/api/activity/runner-channel" ? await request.clone().json() as { type: string } : null;
      if (body?.type === "hello") hellos += 1;
      const active = fault && body?.type === fault.type ? fault : null;
      if (active) active.hits += 1;
      if (active && !active.commit) return new Response(null, { status: 503 });
      const response = await current.app.fetch(request);
      if (lookupDelay && request.method === "GET" && new URL(request.url).pathname.startsWith("/api/seat/command/")) await sleep(lookupDelay);
      return active ? new Response(null, { status: 503 }) : response;
    } });
    await new Promise<void>(done => server.once("listening", done));
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let output = "";
    const children: ReturnType<typeof spawn>[] = [];
    const start = () => {
      const f = current;
      const child = spawn(process.execPath, kind === "pi" ? ["--import", resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"), resolve(__dirname, "../src/adapters/pi-runner.ts"), "--session-name", "dev@channel", "--state-root", join(dir, "state"), "--cwd", dir, "--launch-id", f.grant.runId!, "--no-approve", ...(program ? ["--model", "local/fixture-model"] : [])]
        : [resolve(__dirname, "../../../docs/reference/community-harness-examples/dsh/openrig-dsh-runner.mjs")],
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), DSH_HOME: join(dir, "dsh"), DSH_SEAT_BIN: program?.bin ?? backend, DSH_TELEMETRY_DISABLED: "1", ...(program ? { DEEPSEEK_API_KEY: "offline-dummy", DEEPSEEK_BASE_URL: program.providerUrl } : {}),
        OPENRIG_HOME: join(dir, "home"), OPENRIG_URL: url, OPENRIG_ACTIVITY_HOOK_TOKEN: f.grant.token, OPENRIG_RUN_ID: f.grant.runId!,
        OPENRIG_NODE_ID: f.node.id, OPENRIG_SESSION_NAME: "dev@channel", OPENRIG_OCCUPANT_GENERATION: f.grant.generation, OPENRIG_RUNTIME: kind } });
      child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); }); children.push(child); return child;
    };
    cleanups.push(() => { for (const child of children) child.kill("SIGKILL"); });
    const ready = async () => { expect(await waitFor(() => current.channel.capable(current.node.id, "wake"), 6000), output).toBe(true); current.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(current.node.id); };
    const reopen = async (grant = current.grant) => {
      server.closeAllConnections(); await sleep(50);
      const retained = { node: current.node, grant }; current.db.close();
      current = await fixture(true, kind, kind === "pi" ? 0 : 1, file, retained);
    };
    const entries = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
    const prompts = () => entries().filter(entry => kind === "pi" ? entry.type === "prompt" : entry.method === "session/prompt")
      .map(entry => kind === "pi" ? entry.message : ((entry.params as { prompt: Array<{ text: string }> }).prompt.map(p => p.text).join("")));
    return { start, ready, reopen, url, server, prompts, entries, dir, get output() { return output; }, get f() { return current; }, get hellos() { return hellos; },
      get fault() { return fault; }, set fault(value) { fault = value; }, set lookupDelay(value: number) { lookupDelay = value; } };
  }

  it.each(["pi", "dsh"] as const)("%s process recovers every custody window through actual Core routes with one native effect", async kind => {
    const h = await nativeProcess(kind); h.start(); await h.ready();
    const { SeatIdentityStore } = await import("../src/domain/seat-identity-store.js");
    const origin = h.f.grants.get(h.f.grant.grantId)!;
    new SeatIdentityStore(h.f.db).upsert({ nodeId: h.f.node.id, verdict: "unconfirmed", evidenceSource: "pane_process", reason: null,
      sessionName: "dev@channel", observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPid: 101, observedPanePid: 101, observedCommand: "node", matchedLayer: null } });
    const adopted = new SessionRegistry(h.f.db).registerClaimedSession(h.f.node.id, "dev@channel", "adopt");
    expect(adopted.id).not.toBe(origin.sessionId);
    expect(h.f.grants.standing(origin.grantId)).toBe("current");
    expect(h.f.grants.get(origin.grantId)).toMatchObject({ sessionId: origin.sessionId, generation: origin.generation, runId: origin.runId });
    // A disconnected native route refuses without typed fallback or a fabricated receipt.
    h.server.closeAllConnections();
    expect(await waitFor(() => !h.f.channel.capable(h.f.node.id, "input"))).toBe(true);
    expect((await h.f.transport.send("dev@channel", "not offered", { deliveryId: "disconnected", actorSession: "sender" })).ok).toBe(false);
    expect(h.prompts()).toEqual([]); await h.ready();
    for (const [id, type, commit, restart] of [["offered", "ack", false, false], ["accepted", "ack", true, true], ["written", "submitted", false, true], ["result", "result", true, false]] as const) {
      h.fault = { type, commit, hits: 0 };
      await h.f.transport.sendNativeWake("dev@channel", id, id, "sender");
      expect(await waitFor(() => h.fault!.hits > 0), id).toBe(true);
      expect(h.f.outbox.runnerReceipt(id)?.stage).toBe(id === "offered" ? "offered" : id === "result" ? "completed" : "accepted");
      if (type === "ack") expect(h.prompts()).not.toContain(id);
      else expect(h.prompts().filter(text => text === id)).toHaveLength(1);
      const hellos = h.hellos;
      if (restart) await h.reopen(); else h.server.closeAllConnections();
      expect(await waitFor(() => h.hellos > hellos)).toBe(true);
      h.fault = null; await h.ready();
      expect(await waitFor(() => h.f.outbox.runnerReceipt(id)?.stage === "completed"), id).toBe(true);
      expect(h.f.outbox.runnerReceipt(id)?.result).toMatchObject({ completion: "completed", answer: `answer ${id}` });
      const conflicting = await fetch(`${h.url}/api/activity/runner-channel`, { method: "POST", headers: { authorization: `Bearer ${h.f.grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "result", runId: h.f.grant.runId, requestId: id, sequence: h.f.outbox.runnerReceipt(id)!.sequence, result: { kind: "wake", completion: "completed", answer: "changed result" } }) });
      expect(conflicting.status).toBe(409);
      await h.f.transport.sendNativeWake("dev@channel", id, id, "sender");
      expect(h.prompts().filter(text => text === id)).toHaveLength(1);
    }
    await h.f.transport.send("dev@channel", "SLOW:busy", { deliveryId: "busy", actorSession: "sender" });
    expect(await waitFor(() => h.prompts().includes("SLOW:busy"))).toBe(true);
    await h.f.transport.send("dev@channel", "ordinary", { deliveryId: "ordinary", actorSession: "sender" });
    await h.f.transport.sendNativeWake("dev@channel", "SLOW:wake", "wake-a", "sender");
    await h.f.transport.sendNativeWake("dev@channel", "wake-b", "wake-b", "sender");
    expect(await waitFor(() => h.prompts().includes("SLOW:wake"))).toBe(true);
    // A short caller stops waiting while native work remains active; later managed input stays behind its barrier.
    await h.f.transport.send("dev@channel", "after wake", { deliveryId: "after", actorSession: "sender" });
    h.lookupDelay = 100;
    await expect(fetch(`${h.url}/api/seat/command/dev%40channel?requestId=wake-a`, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
    h.lookupDelay = 0;
    await sleep(100); expect(h.prompts()).not.toContain("after wake");
    expect(h.f.outbox.runnerReceipt("wake-a")?.stage).not.toBe("completed");
    expect(await waitFor(() => h.f.outbox.runnerReceipt("after")?.stage === "completed")).toBe(true);
    expect(h.f.outbox.runnerReceipt("wake-a")?.result).toMatchObject({ answer: "answer SLOW:wake" });
    expect(h.f.outbox.runnerReceipt("wake-b")?.result).toMatchObject({ answer: "answer wake-b" });
    expect(h.prompts()).toEqual(["offered", "accepted", "written", "result", "SLOW:busy", "ordinary", "SLOW:wake", "wake-b", "after wake"]);
    for (const [id, body] of [["group-a", "source A"], ["group-b", "source B"]]) h.f.outbox.record({ outboxId: id!, senderSession: "sender", destinationSession: "dev@channel", body: body! });
    const group = { committedOutboxIds: ["group-a", "group-b"], actorSession: "sender", queueWake: true, nativeWake: true };
    await h.f.transport.send("dev@channel", "composed group", group);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("group-b")?.stage === "completed")).toBe(true);
    await h.f.transport.send("dev@channel", "composed group", group);
    expect(h.prompts().filter(text => text === "composed group")).toHaveLength(1);
    expect(h.f.outbox.runnerReceipt("group-b")?.result).toMatchObject({ answer: "answer composed group" });
    expect((await h.f.transport.send("dev@channel", "changed composition", group)).ok).toBe(false);
    await h.f.transport.sendNativeWake("dev@channel", "REFUSE", "refuse", "sender");
    expect(await waitFor(() => h.f.outbox.runnerReceipt("refuse")?.stage === "rejected")).toBe(true);
    await h.f.transport.sendNativeWake("dev@channel", "INTERRUPT", "interrupt", "sender");
    expect(await waitFor(() => h.f.outbox.runnerReceipt("interrupt")?.stage === "completed")).toBe(true);
    expect(h.f.outbox.runnerReceipt("interrupt")?.result).toMatchObject({ completion: "interrupted", answer: null });
    expect(h.entries().filter(entry => "childToken" in entry).every(entry => entry.childToken === false)).toBe(true);
  }, 40000);

  it.each([
    ["pi", "ack", "binding"], ["pi", "result", "binding"], ["dsh", "ack", "binding"], ["dsh", "result", "binding"],
    ["pi", "result", "failed read"], ["dsh", "result", "failed read"],
  ] as const)("%s retains custody through %s %s uncertainty and recovers without replay", async (kind, phase, cause) => {
    const h = await nativeProcess(kind);
    const { SeatIdentityStore } = await import("../src/domain/seat-identity-store.js");
    const identities = new SeatIdentityStore(h.f.db);
    const evidence = { nodeId: h.f.node.id, verdict: "unconfirmed" as const, evidenceSource: "pane_process" as const, reason: null,
      sessionName: "dev@channel", observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPid: 101,
        observedPanePid: 101, observedCommand: "node", matchedLayer: null } };
    identities.upsert(evidence);
    new SessionRegistry(h.f.db).registerClaimedSession(h.f.node.id, "dev@channel", "adopt");
    let restoreStanding: (() => void) | undefined;
    cleanups.push(() => restoreStanding?.());
    const loseEvidence = () => {
      if (cause === "binding") h.f.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id=?").run(h.f.node.id);
      else {
        const standing = h.f.grants.standing.bind(h.f.grants);
        const fault = vi.spyOn(h.f.grants, "standing").mockImplementation(id => {
          const prepare = h.f.db.prepare.bind(h.f.db);
          const read = vi.spyOn(h.f.db, "prepare").mockImplementation(((sql: string) => {
            if (sql === "PRAGMA table_info(activity_grants)") throw new Error("standing read unavailable");
            return prepare(sql);
          }) as typeof h.f.db.prepare);
          try { return standing(id); } finally { read.mockRestore(); }
        });
        restoreStanding = () => fault.mockRestore();
      }
    };
    const recoverEvidence = () => { restoreStanding?.(); restoreStanding = undefined; identities.upsert(evidence); };
    // Before an offer, unavailable binding evidence cannot authenticate hello or consume custody.
    loseEvidence(); h.start();
    expect(await waitFor(() => h.hellos >= 2), h.output).toBe(true);
    if (cause === "binding") expect(h.f.grants.standing(h.f.grant.grantId)).toBe("unverified");
    else expect(() => h.f.grants.standing(h.f.grant.grantId)).toThrow("standing read unavailable");
    expect(h.f.grants.get(h.f.grant.grantId)?.revokedAt).toBeNull();
    expect(h.f.outbox.runnerReceipts(h.f.node.id, h.f.grant.runId!)).toEqual([]);
    expect(h.prompts()).toEqual([]);
    recoverEvidence(); await h.ready();
    h.fault = { type: phase, commit: false, hits: 0 };
    const id = `unverified-${phase}`;
    await h.f.transport.sendNativeWake("dev@channel", id, id, "sender");
    expect(await waitFor(() => h.fault!.hits > 0), h.output).toBe(true);
    const saved = h.f.outbox.runnerReceipt(id)!;
    expect(saved.stage).toBe(phase === "ack" ? "offered" : "submitted");
    expect(h.prompts().filter(text => text === id)).toHaveLength(phase === "ack" ? 0 : 1);
    // The same selected run becomes temporarily unverifiable, not replaced or map-lost.
    loseEvidence(); h.fault = null; const hellos = h.hellos; h.server.closeAllConnections();
    expect(await waitFor(() => h.hellos > hellos), h.output).toBe(true);
    const refused = await fetch(`${h.url}/api/activity/runner-channel`, { method: "POST",
      headers: { authorization: `Bearer ${h.f.grant.token}`, "content-type": "application/json" }, body: JSON.stringify(h.f.hello) });
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json();
    expect(refusedBody).toMatchObject({ code: "runner_grant_unverified" });
    await sleep(500);
    expect(h.f.outbox.runnerReceipt(id)).toEqual(saved);
    expect(h.f.grants.get(h.f.grant.grantId)?.revokedAt).toBeNull();
    expect(h.prompts().filter(text => text === id)).toHaveLength(phase === "ack" ? 0 : 1);
    recoverEvidence(); await h.ready();
    expect(await waitFor(() => h.f.outbox.runnerReceipt(id)?.stage === "completed"), h.output).toBe(true);
    expect(h.f.outbox.runnerReceipt(id)?.result).toMatchObject({ completion: "completed", answer: `answer ${id}` });
    await h.f.transport.sendNativeWake("dev@channel", id, id, "sender");
    expect(h.prompts().filter(text => text === id)).toHaveLength(1);
    expect(h.f.outbox.runnerReceipts(h.f.node.id, h.f.grant.runId!)).toHaveLength(1);
    expect(refusedBody).toMatchObject({ retryable: true });
  }, 40000);

  it.each(["pi", "dsh"] as const)("%s receiver replacement fences missing state and all cross-run/seat authority through actual routes", async kind => {
    const h = await nativeProcess(kind), original = h.start(); await h.ready();
    const post = (token: string, body: unknown) => fetch(`${h.url}/api/activity/runner-channel`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const get = (token: string, cursor: string) => fetch(`${h.url}/api/activity/runner-channel`, { headers: { authorization: `Bearer ${token}`, "Last-Event-ID": cursor } });
    h.fault = { type: "ack", commit: false, hits: 0 };
    await h.f.transport.sendNativeWake("dev@channel", "never written", "lost-map", "sender");
    await h.f.transport.sendNativeWake("dev@channel", "successor", "successor", "sender");
    expect(await waitFor(() => h.fault!.hits > 0)).toBe(true);
    const old = h.f.grant;
    for (const change of [{ runId: "wrong-run" }, { sequence: 999 }, { requestId: "unknown-request" }]) expect((await post(old.token, { type: "submitted", runId: old.runId, requestId: "lost-map", sequence: 1, ...change })).status).toBe(409);
    const pending = h.f.grants.issue({ nodeId: h.f.node.id, generation: old.generation, issuedBy: "test", run: { runId: "run-two", binding: old.binding! } });
    expect((await post(pending.token, { ...h.f.hello, runId: "run-two" })).status).toBe(409);
    expect((await get(pending.token, "0")).status).toBe(409);
    expect((await post(INSTALL, h.f.hello)).status).toBe(401);
    for (const cursor of ["invalid", "-1", "999999"]) expect((await get(old.token, cursor)).status).toBeGreaterThanOrEqual(400);
    const rigs = new RigRepository(h.f.db), peer = rigs.addNode(rigs.createRig("peer").id, "peer", { runtime: kind });
    const sessions = new SessionRegistry(h.f.db); sessions.registerSession(peer.id, "peer@peer");
    h.f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('peer',?,'peer@peer','%2')").run(peer.id);
    const peerGrant = h.f.grants.issue({ nodeId: peer.id, generation: sessions.currentOccupantTenure(peer.id)!.generationUuid, issuedBy: "test", run: { runId: "peer-run", binding: { ...old.binding!, pane: "%2", panePid: 202 } } });
    h.f.grants.activate(peerGrant.grantId);
    expect((await post(peerGrant.token, { ...h.f.hello, runId: "peer-run" })).status).toBe(200);
    expect((await post(peerGrant.token, { type: "submitted", runId: "peer-run", requestId: "lost-map", sequence: 1 })).status).toBe(409);
    expect((await get(peerGrant.token, "1")).status).toBe(400);
    h.f.grants.revoke({ grantId: peerGrant.grantId }, "test");
    expect((await post(peerGrant.token, { ...h.f.hello, runId: "peer-run" })).status).toBe(401);
    original.kill("SIGKILL"); await new Promise(resolve => original.once("exit", resolve));
    h.fault = null; h.server.closeAllConnections(); const hellos = h.hellos; const lostReceiver = h.start();
    expect(await waitFor(() => h.hellos > hellos && h.f.outbox.runnerReceipt("lost-map")?.reconciliation === "receiver_state_lost")).toBe(true);
    expect(h.f.outbox.runnerReceipt("successor")?.stage).toBe("pending");
    expect(h.prompts()).toEqual([]);
    expect(h.f.channel.frames(old.token, 2)).toEqual([]);
    expect((await h.f.transport.sendNativeWake("dev@channel", "never written", "lost-map", "sender")).runnerReceipt?.reconciliation).toBe("receiver_state_lost");
    expect((await h.f.transport.sendNativeWake("dev@channel", "new admission", "no-fallback", "sender")).ok).toBe(false);
    // A real replacement attempt in the same tenure cannot inherit or settle the old receipt.
    expect(h.f.grants.activate(pending.grantId)).toBe(true);
    expect((await post(old.token, { type: "result", runId: "run-one", requestId: "lost-map", sequence: 1, result: { kind: "wake", completion: "completed", answer: "late" } })).status).toBe(401);
    expect((await post(pending.token, { ...h.f.hello, runId: "run-two" })).status).toBe(200);
    expect((await post(pending.token, { type: "submitted", runId: "run-two", requestId: "lost-map", sequence: 1 })).status).toBe(409);
    expect(h.f.outbox.runnerReceipt("lost-map")).toMatchObject({ runId: "run-one", reconciliation: "receiver_state_lost", payload: { question: "never written" } });
    expect(h.f.channel.frames(pending.token, 0)).toEqual([]);
    expect(h.prompts()).toEqual([]);
    lostReceiver.kill("SIGKILL"); await new Promise(resolve => lostReceiver.once("exit", resolve));
    await h.reopen(pending); h.fault = { type: "submitted", commit: false, hits: 0 };
    const writtenReceiver = h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "SLOW:uncertain", "after-write", "sender");
    expect(await waitFor(() => h.fault!.hits > 0)).toBe(true);
    expect(h.prompts().filter(text => text === "SLOW:uncertain")).toHaveLength(1);
    await h.f.transport.sendNativeWake("dev@channel", "pending after write", "pending-after-write", "sender");
    writtenReceiver.kill("SIGKILL"); await new Promise(resolve => writtenReceiver.once("exit", resolve));
    h.fault = null; h.server.closeAllConnections(); const newHellos = h.hellos; h.start();
    expect(await waitFor(() => h.hellos > newHellos && h.f.outbox.runnerReceipt("after-write")?.reconciliation === "receiver_state_lost")).toBe(true);
    expect(h.f.outbox.getById("after-write")?.deliveryState).toBe("indeterminate");
    expect(h.f.channel.frames(pending.token, 2)).toEqual([]);
    expect(h.prompts()).toEqual(["SLOW:uncertain"]);
  }, 20000);

  it.runIf(process.env["OPENRIG_NATIVE_PROGRAM_PROOF"] === "1").each(["pi", "dsh"] as const)("installed %s program answers idle and busy queued wakes using only a local fake provider", async kind => {
    const executable = process.env[kind === "pi" ? "OPENRIG_NATIVE_PI_BIN" : "OPENRIG_NATIVE_DSH_BIN"];
    expect(executable, "Set an explicit isolated native program path for opt-in proof").toBeTruthy();
    const requests: Array<{ text: string; model: string }> = [];
    const provider = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/messages")) return new Response(null, { status: 404 });
      const body = await request.json() as { model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
      const content = body.messages.filter(message => message.role === "user").at(-1)?.content;
      const text = typeof content === "string" ? content : content?.find(part => part.type === "text")?.text ?? "";
      requests.push({ text, model: body.model });
      const answer = `native-answer: ${text}`;
      const frames = [
        { type: "message_start", message: { id: `offline-${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }, { type: "message_stop" },
      ];
      await sleep(text.includes("SLOW:native") ? 700 : 30);
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    await new Promise<void>(done => provider.once("listening", done)); cleanups.push(() => { provider.closeAllConnections(); provider.close(); });
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const h = await nativeProcess(kind, { bin: executable!, providerUrl });
    const version = execFileSync(executable!, ["--version"], { encoding: "utf8", timeout: 10000, env: { PATH: process.env["PATH"], HOME: h.dir, DSH_HOME: join(h.dir, "dsh"), XDG_CONFIG_HOME: join(h.dir, "config"), XDG_DATA_HOME: join(h.dir, "data"), XDG_CACHE_HOME: join(h.dir, "cache"), DSH_TELEMETRY_DISABLED: "1" } }).trim();
    h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "idle native", "idle-native", "sender");
    expect(await waitFor(() => h.f.outbox.runnerReceipt("idle-native")?.stage === "completed", 12000), h.output).toBe(true);
    expect(h.f.outbox.runnerReceipt("idle-native")?.result).toMatchObject({ completion: "completed", answer: "native-answer: idle native" });
    await h.f.transport.send("dev@channel", "SLOW:native", { deliveryId: "busy-native", actorSession: "sender" });
    expect(await waitFor(() => requests.some(request => request.text === "SLOW:native")), h.output).toBe(true);
    await h.f.transport.send("dev@channel", "ordinary native", { deliveryId: "ordinary-native", actorSession: "sender" });
    await h.f.transport.sendNativeWake("dev@channel", "queued native A", "native-a", "sender");
    await h.f.transport.sendNativeWake("dev@channel", "queued native B", "native-b", "sender");
    expect(await waitFor(() => h.f.outbox.runnerReceipt("native-b")?.stage === "completed", 12000), h.output).toBe(true);
    for (const [id, text] of [["native-a", "queued native A"], ["native-b", "queued native B"]]) expect(h.f.outbox.runnerReceipt(id!)?.result).toMatchObject({ completion: "completed", answer: `native-answer: ${text}` });
    expect(requests.some(request => request.text === "ordinary native")).toBe(true);
    console.log(JSON.stringify({ nativeProgram: kind, version, executable, provider: "local fake Anthropic messages; no external network", prompts: requests.map(request => request.text) }));
  }, 45000);

  it.each(["binding", "failed read"])("refuses %s channel uncertainty retryably without changing custody, then recovers", async cause => {
    const f = await fixture();
    const { SeatIdentityStore } = await import("../src/domain/seat-identity-store.js");
    const identities = new SeatIdentityStore(f.db);
    const evidence = { nodeId: f.node.id, verdict: "unconfirmed" as const, evidenceSource: "pane_process" as const, reason: null,
      sessionName: "dev@channel", observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPid: 101,
        observedPanePid: 101, observedCommand: "node", matchedLayer: null } };
    identities.upsert(evidence); new SessionRegistry(f.db).registerClaimedSession(f.node.id, "dev@channel", "adopt");
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.admit("unverified"); f.channel.frames(f.grant.token, 0);
    const saved = f.outbox.runnerReceipt("unverified");
    const standing = f.grants.standing.bind(f.grants);
    const fault = cause === "failed read" ? vi.spyOn(f.grants, "standing").mockImplementation(id => {
      const prepare = f.db.prepare.bind(f.db);
      const read = vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
        if (sql === "PRAGMA table_info(activity_grants)") throw new Error("standing read unavailable");
        return prepare(sql);
      }) as typeof f.db.prepare);
      try { return standing(id); } finally { read.mockRestore(); }
    }) : null;
    if (!fault) f.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id=?").run(f.node.id);
    const headers = { authorization: `Bearer ${f.grant.token}`, "content-type": "application/json" };
    const ack = { type: "ack", runId: f.grant.runId, requestId: "unverified", sequence: 1, state: "accepted" };
    try {
      expect(f.channel.capable(f.node.id, "wake")).toBe(false);
      for (const body of [f.hello, ack, undefined]) {
        const response = await f.app.request("/api/activity/runner-channel", body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "runner_grant_unverified", retryable: true });
        expect(f.outbox.runnerReceipt("unverified")).toEqual(saved);
        expect(f.grants.get(f.grant.grantId)?.revokedAt).toBeNull();
      }
    } finally { fault?.mockRestore(); }
    identities.upsert(evidence);
    expect(f.channel.capable(f.node.id, "wake")).toBe(true);
    expect(f.grants.standing(f.grant.grantId)).toBe("current");
    expect((await f.app.request("/api/activity/runner-channel", { method: "POST", headers, body: JSON.stringify(ack) })).status).toBe(200);
    expect(f.outbox.runnerReceipt("unverified")?.stage).toBe("accepted");
  });

  it("pending and replacement grants cannot subscribe to or settle the retiring run's receipts", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token)); f.admit("old");
    f.channel.frames(f.grant.token, 0);
    const next = f.grants.issue({ nodeId: f.node.id, generation: f.grant.generation, issuedBy: "replacement",
      run: { runId: "run-two", binding: f.grant.binding! } });
    expect(() => f.channel.post(next.token, { ...f.hello, runId: "run-two" })).toThrow(/pending/);
    expect(f.grants.activate(next.grantId)).toBe(true);
    expect(() => f.channel.frames(f.grant.token, 0)).toThrow(/revoked/);
    expect(f.channel.post(next.token, { ...f.hello, runId: "run-two" })).toMatchObject({ receipts: [] });
    expect(f.channel.frames(next.token, 0)).toEqual([]);
    expect(() => f.channel.post(next.token, { type: "ack", runId: "run-two", requestId: "old", sequence: 1, state: "accepted" })).toThrow(/mismatch/);
    expect(f.outbox.runnerReceipt("old")?.stage).toBe("offered");
  });
  it("erasure removes channel payload visibility and rejects late acknowledgements/results without a native effect", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token)); f.admit("erase-me");
    expect(f.outbox.eraseRunner("erase-me", new Date().toISOString())).toBe(true);
    expect(f.channel.frames(f.grant.token, 0)).toEqual([]);
    for (const type of ["ack", "submitted", "result"])
      expect(() => f.channel.post(f.grant.token, { type, runId: "run-one", requestId: "erase-me", sequence: 1, state: "accepted", result: { answer: "revived text" } })).toThrow(/erased/);
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ receipts: [expect.objectContaining({ payload: {}, erasedAt: expect.any(String) })], unresolved: [] });
    expect(JSON.stringify(f.outbox.runnerReceipt("erase-me"))).not.toContain("revived text");
  });
  it.each([
    ["native", "typed", false], ["typed", "native", false], ["typed", "native", true],
  ] as const)("a held %s request cannot become %s after preference change (legacy=%s)", async (initial, selected, legacy) => {
    const f = await fixture();
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const effects: string[] = [];
    const transport = new SessionTransport({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), runnerChannel: f.channel,
      tmuxAdapter: { deliveryGuard: f.guard, getPaneCommand: async () => "pi", probeSession: async () => ({ state: "present" }),
        capturePaneContent: async () => "", sendText: async (_seat: string, text: string) => { effects.push(text); return { ok: true }; },
        sendKeys: async () => ({ ok: true }) } as never, sleep: async () => {} });
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.db.prepare("UPDATE nodes SET input_route=? WHERE id=?").run(initial, f.node.id);
    await f.guard.set(f.node.id, { mode: "hold" }, "person", "hold");
    const options = { deliveryId: "held-route", actorSession: "sender", identityProvenance: "transport:v1" };
    expect(await transport.send("dev@channel", "immutable", options)).toMatchObject({ outcome: "retained", sent: false });
    if (legacy) f.db.prepare("UPDATE outbox_entries SET guard_delivery=NULL WHERE outbox_id='held-route'").run();
    f.db.prepare("UPDATE nodes SET input_route=? WHERE id=?").run(selected, f.node.id);
    await f.guard.set(f.node.id, { mode: "off" }, "person", "release");
    expect(await transport.send("dev@channel", "immutable", options)).toMatchObject({ ok: false, sent: false, reason: "delivery_identity_conflict" });
    expect(effects).toEqual([]);
    expect(f.outbox.runnerReceipt("held-route")).toBeNull();
    expect(f.outbox.getById("held-route")?.deliveryState).toBe("retained");
    expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT identity_provenance AS source FROM outbox_entries").get()).toEqual({ source: "transport:v1" });
    const fresh = await transport.send("dev@channel", "new explicit request", { ...options, deliveryId: "new-route-id" });
    expect(fresh.ok).toBe(true);
    if (selected === "typed") expect(effects).toEqual(["new explicit request"]);
    else expect(fresh.runnerReceipt).toMatchObject({ inputRoute: "native", sequence: 1 });
  });
  it("legacy unmarked held input still uses the typed default when the preference stays typed", async () => {
    const f = await fixture(); const effects: string[] = [];
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const transport = new SessionTransport({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db),
      tmuxAdapter: { deliveryGuard: f.guard, getPaneCommand: async () => "pi", probeSession: async () => ({ state: "present" }), capturePaneContent: async () => "",
        sendText: async (_seat: string, text: string) => { effects.push(text); return { ok: true }; }, sendKeys: async () => ({ ok: true }) } as never, sleep: async () => {} });
    await f.guard.set(f.node.id, { mode: "hold" }, "person", "hold");
    const options = { deliveryId: "legacy", actorSession: "sender" };
    expect(await transport.send("dev@channel", "legacy text", options)).toMatchObject({ outcome: "retained" });
    f.db.prepare("UPDATE outbox_entries SET guard_delivery=NULL WHERE outbox_id='legacy'").run();
    await f.guard.set(f.node.id, { mode: "off" }, "person", "release");
    expect((await transport.send("dev@channel", "legacy text", options)).ok).toBe(true);
    expect(effects).toEqual(["legacy text"]);
    expect(f.outbox.runnerReceipts(f.node.id, "run-one")).toEqual([]);
  });
  it("a held native group cannot cross into typed delivery, including after capability loss", async () => {
    const f = await fixture(); const effects: string[] = [];
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const transport = new SessionTransport({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), runnerChannel: f.channel,
      tmuxAdapter: { deliveryGuard: f.guard, getPaneCommand: async () => "pi", probeSession: async () => ({ state: "present" }), capturePaneContent: async () => "",
        sendText: async (_seat: string, text: string) => { effects.push(text); return { ok: true }; }, sendKeys: async () => ({ ok: true }) } as never, sleep: async () => {} });
    f.channel.post(f.grant.token, f.hello); const disconnect = f.channel.connect(f.grant.token); cleanups.push(disconnect);
    f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    for (const id of ["held-a", "held-b"]) f.outbox.record({ outboxId: id, senderSession: "sender", destinationSession: "dev@channel", body: id });
    await f.guard.set(f.node.id, { mode: "hold" }, "person", "hold");
    const options = { committedOutboxIds: ["held-a", "held-b"], actorSession: "sender", queueWake: true };
    expect(await transport.send("dev@channel", "composed", options)).toMatchObject({ outcome: "retained" });
    await f.guard.set(f.node.id, { mode: "off" }, "person", "release"); disconnect();
    expect(await transport.send("dev@channel", "composed", options)).toMatchObject({ ok: false, reason: "runner_unavailable", sent: false });
    f.db.prepare("UPDATE nodes SET input_route='typed' WHERE id=?").run(f.node.id);
    expect(await transport.send("dev@channel", "composed", options)).toMatchObject({ ok: false, reason: "delivery_identity_conflict", sent: false });
    expect(effects).toEqual([]);
    expect(f.outbox.runnerReceipts(f.node.id, "run-one")).toEqual([]);
  });
  it("queue recovery never retypes a native wake intent after offer/uncertainty", async () => {
    const f = await fixture();
    const repo = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
    repo.attachOutbox(f.outbox);
    const item = await repo.create({ sourceSession: "lead@channel", destinationSession: "dev@channel", body: "durable work" });
    const id = `wake-intent-${item.qitemId}`, entry = f.outbox.getById(id)!;
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.admit(f.node.id, { outboxId: id, senderSession: entry.senderSession, destinationSession: entry.destinationSession,
      body: entry.body, auditPointer: entry.auditPointer ?? undefined, kind: "input", inputRoute: "native", payload: { text: entry.body } });
    expect(f.outbox.finalizeDelivery(id, "indeterminate").deliveryState).toBe("sending");
    f.channel.frames(f.grant.token, 0);
    f.outbox.forgetRunnerMap(f.node.id, "run-one");
    let effects = 0; repo.attachTransport({ send: async () => { effects++; return { ok: true, verified: true }; } });
    await repo.drainPendingWakeIntents();
    expect(effects).toBe(0);
    expect(f.outbox.getById(id)?.deliveryState).toBe("indeterminate");
  });
  it("seat route choice requires a live capability, and wake submission/lookup use that exact request", async () => {
    const f = await fixture();
    const post = (path: string, body: unknown) => f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/seat/set-input-route/dev%40channel", { route: "native", reason: "native" })).status).toBe(409);
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    expect((await post("/api/seat/command/dev%40channel", { type: "wake", requestId: "question", question: "why" })).status).toBe(409);
    expect((await post("/api/seat/set-input-route/dev%40channel", { route: "native", reason: "native" })).status).toBe(200);
    const response = await post("/api/seat/command/dev%40channel", { type: "wake", requestId: "question", question: "why" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ runnerReceipt: { kind: "wake", requestId: "question", payload: { question: "why" } } });
    const lookup = await f.app.request("/api/seat/command/dev%40channel?requestId=question");
    expect(await lookup.json()).toMatchObject({ receipt: { requestId: "question", stage: "pending" } });
    expect((await post("/api/seat/command/dev%40channel", { type: "wake", requestId: "question", question: "different" })).status).toBe(409);
  });
  it("the SSE route emits only the current run's offer and closes after grant revocation", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.admit("one"); f.admit("two");
    const response = await f.app.request("/api/activity/runner-channel", { headers: { authorization: `Bearer ${f.grant.token}` } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); cleanups.push(() => reader.cancel());
    const read = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("channel read timed out")), 2000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    expect(new TextDecoder().decode((await read()).value)).toContain('"requestId":"one"');
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: "one", sequence: 1, state: "accepted" });
    expect(new TextDecoder().decode((await read()).value)).toContain('"requestId":"two"');
    f.grants.revoke({ grantId: f.grant.grantId }, "stopped");
    expect((await read()).done).toBe(true);
  });
  it("a composed wake group stays one native operation while preserving its original member histories", async () => {
    const f = await fixture();
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const { SeatDeliveryGuard, resolveGuardTarget } = await import("../src/domain/seat-delivery-guard.js");
    const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name));
    const transport = new SessionTransport({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), tmuxAdapter: { deliveryGuard: guard } as never, runnerChannel: f.channel });
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    for (const [id, body] of [["member-one", "original one"], ["member-two", "original two"]])
      f.outbox.record({ outboxId: id!, senderSession: "system", destinationSession: "dev@channel", body: body!, auditPointer: id });
    const options = { committedOutboxIds: ["member-one", "member-two"], actorSession: "system", queueWake: true };
    const sent = await transport.send("dev@channel", "exact composed prompt", options);
    expect(sent).toMatchObject({ ok: true, outboxIds: options.committedOutboxIds, runnerReceipt: { requestId: "member-one", memberIds: options.committedOutboxIds, sequence: 1 } });
    expect(f.channel.frames(f.grant.token, 0)).toHaveLength(1);
    expect(f.outbox.getById("member-one")?.body).toBe("original one");
    expect(f.outbox.getById("member-two")?.body).toBe("original two");
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: "member-one", sequence: 1, state: "accepted" });
    f.channel.post(f.grant.token, { type: "submitted", runId: "run-one", requestId: "member-one", sequence: 1 });
    expect(f.outbox.getById("member-two")?.deliveryState).toBe("delivered");
    expect((await transport.send("dev@channel", "different composition", options)).ok).toBe(false);
    expect(f.outbox.runnerReceipts(f.node.id, "run-one")).toHaveLength(1);
  });
  it("ordinary transport applies the same held policy before native admission and never types on native refusal", async () => {
    const f = await fixture();
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const { SeatDeliveryGuard, resolveGuardTarget } = await import("../src/domain/seat-delivery-guard.js");
    const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name));
    const tmux = { deliveryGuard: guard, sendText: () => { throw new Error("unexpected typed fallback"); } };
    const transport = new SessionTransport({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), tmuxAdapter: tmux as never, runnerChannel: f.channel });
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    await guard.set(f.node.id, { mode: "hold" }, "person", "quiet");
    const held = await transport.send("dev@channel", "hello", { deliveryId: "held-native", actorSession: "sender" });
    expect(held).toMatchObject({ outcome: "retained", sent: false });
    expect(f.outbox.runnerReceipt("held-native")).toBeNull();
    await guard.set(f.node.id, { mode: "off" }, "person", "resume");
    const sent = await transport.send("dev@channel", "hello", { deliveryId: "native-send", actorSession: "sender" });
    expect(sent).toMatchObject({ ok: true, verified: false, runnerReceipt: { stage: "pending", sequence: 1 } });
    expect((await transport.send("dev@channel", "hello", { deliveryId: "native-send", actorSession: "sender" })).runnerReceipt?.sequence).toBe(1);
    expect(await transport.send("dev@channel", "ordinary notice", { deliveryId: "native-notice", openrigNotice: true }))
      .toMatchObject({ ok: true, runnerReceipt: { stage: "pending", sequence: 2 } });
    expect(await transport.send("dev@channel", "hello", { deliveryId: "native-send", actorSession: "sender", dangerouslyInteract: true, reason: "existing native ID" }))
      .toMatchObject({ ok: false, sent: false, reason: "delivery_identity_conflict" });
    f.db.prepare("UPDATE nodes SET input_route='typed' WHERE id=?").run(f.node.id);
    expect((await transport.send("dev@channel", "hello", { deliveryId: "native-send", actorSession: "sender" })).runnerReceipt?.sequence).toBe(1);
    expect((await transport.send("dev@channel", "different", { deliveryId: "native-send", actorSession: "sender" })).ok).toBe(false);
    f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    f.grants.revoke({ grantId: f.grant.grantId }, "stopped");
    expect(await transport.send("dev@channel", "hello", { deliveryId: "refused", actorSession: "sender" })).toMatchObject({ ok: false, sent: false });
  });
  it("the actual channel route requires a current bound grant and validates strict cursors", async () => {
    const f = await fixture();
    const request = (token: string, body: unknown) => f.app.request("/api/activity/runner-channel", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await request(INSTALL, f.hello)).status).toBe(401);
    expect((await request(f.grant.token, f.hello)).status).toBe(200);
    for (const cursor of ["1x", "-1", "1.5", "9007199254740992"])
      expect((await f.app.request("/api/activity/runner-channel", { headers: { authorization: `Bearer ${f.grant.token}`, "Last-Event-ID": cursor } })).status).toBe(400);
    f.grants.revoke({ grantId: f.grant.grantId }, "stopped");
    expect((await request(f.grant.token, f.hello)).status).toBe(401);
  });
  it.each([["pi", 0], ["arbitrary-preset", 1], ["arbitrary-rpc", 2]] as const)("recognizes Core-selected %s runner code %i without changing session provenance", async (runtime, runner) => {
    const f = await fixture(true, runtime, runner);
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: true, wake: true, cancel: false } });
  });
  it("raw builtins do not become managed native runners by sharing runner code zero", async () => {
    const { runnerChannelKind } = await import("../src/domain/runner-channel.js");
    expect(runnerChannelKind({ runtime: "terminal", runner: 0, pane: "%1", panePid: 1 })).toBeNull();
    expect(runnerChannelKind({ runtime: "claude-code", runner: 0, pane: "%1", panePid: 1 })).toBeNull();
  });
  it("intersects a recorded runner kind/version and explicit declaration without a community app-name whitelist", async () => {
    const f = await fixture(true, "community-future", 1);
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: true, wake: true, cancel: false } });
    expect(f.channel.post(f.grant.token, { ...f.hello, capabilities: { input: false, wake: false, cancel: false } }))
      .toMatchObject({ capabilities: { input: false, wake: false, cancel: false } });
  });
  it("submission uncertainty cannot accompany a fabricated completed wake answer", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.admit(f.node.id, { outboxId: "wake", senderSession: "sender", destinationSession: "dev@channel", body: "question", kind: "wake", inputRoute: "native", payload: { question: "question" } });
    f.channel.frames(f.grant.token, 0);
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: "wake", sequence: 1, state: "accepted" });
    f.channel.post(f.grant.token, { type: "submitted", runId: "run-one", requestId: "wake", sequence: 1 });
    expect(() => f.channel.post(f.grant.token, { type: "result", runId: "run-one", requestId: "wake", sequence: 1,
      result: { kind: "wake", completion: "completed", answer: "invented", submissionUnknown: true } })).toThrow(/uncertainty|Invalid/);
    expect(f.outbox.runnerReceipt("wake")?.stage).toBe("submitted");
  });
  it.each(["queued", "late-started", "owned", "noresponse"])("Pi %s child exit crosses strict Core custody and preserves uncertainty across reopen/erasure", async mode => {
    const { RunnerCore } = await import("../src/adapters/pi-runner.js");
    const { RunnerChannel } = await import("../src/domain/runner-channel.js");
    const { ActivityGrantStore } = await import("../src/domain/activity-grants.js");
    const { OutboxHandler } = await import("../src/domain/outbox-handler.js");
    const dir = mkdtempSync(join(tmpdir(), "pi-exit-custody-")), file = join(dir, "proof.sqlite");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await fixture(true, "pi", 0, file);
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    const wake = f.channel.admit(f.node.id, { outboxId: "exit-wake", senderSession: "sender", destinationSession: "dev@channel", body: "question", kind: "wake", inputRoute: "native", payload: { question: "question" } });
    f.admit("successor"); f.channel.frames(f.grant.token, 0);
    const rpc: Record<string, unknown>[] = [], refused: unknown[] = [];
    const core = new RunnerCore({ sendRpc: command => rpc.push(command), postRunner: async body => {
      try { f.channel.post(f.grant.token, body); return true; } catch (error) { refused.push(error); return false; }
    }, mirrorLine() {}, mirrorAppend() {}, postActivity() {}, writeSidecar() {}, now: () => new Date().toISOString() }, { sessionName: "dev@channel", runId: "run-one" });
    const event = (type: string, extra = {}) => core.handlePiLine(JSON.stringify({ type, ...extra }));
    const response = (disposition: string) => event("response", { id: "openrig-native-exit-wake", success: true, data: { disposition } });
    core.start(); event("response", { id: "pi-runner-get-state", success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
    const frame = { version: 1, requestId: wake.requestId, sequence: wake.sequence, runId: "run-one", kind: "wake" as const, payload: { question: "question" } };
    await core.acceptRunnerRequest(frame);
    event("response", { id: rpc.find(command => String(command.id).startsWith("openrig-native-idle-"))!.id, success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
    if (mode === "owned") response("started");
    event("agent_start");
    if (mode === "queued" || mode === "late-started") response(mode === "queued" ? "queued" : "started");
    core.handlePiExit(1); await new Promise(resolve => setImmediate(resolve));
    expect(refused).toEqual([]);
    expect(f.outbox.runnerReceipt(wake.requestId)).toMatchObject({ stage: "completed", result: { completion: mode === "owned" ? "failed" : "unknown", answer: null } });
    await core.acceptRunnerRequest(frame);
    expect(rpc.filter(command => command.type === "prompt")).toHaveLength(1);
    f.db.close();
    for (const erase of [false, true]) {
      const reopened = createDb(file); cleanups.push(() => { if (reopened.open) reopened.close(); });
      const outbox = new OutboxHandler(reopened), channel = new RunnerChannel(new ActivityGrantStore(reopened), outbox, new Set(["managed-pi"]));
      if (erase) outbox.eraseRunner(wake.requestId, new Date().toISOString());
      channel.post(f.grant.token, f.hello); cleanups.push(channel.connect(f.grant.token));
      if (mode !== "owned") {
        expect(outbox.runnerReceipt(wake.requestId)?.reconciliation).toBe("native_ownership_unknown");
        expect(channel.capable(f.node.id, "wake")).toBe(false);
        expect(channel.frames(f.grant.token, 0)).toEqual([]);
        expect(outbox.runnerReceipt("successor")?.stage).toBe("pending");
      } else expect(outbox.runnerReceipt(wake.requestId)?.reconciliation).toBeUndefined();
      if (erase) expect(outbox.runnerReceipt(wake.requestId)).toMatchObject({ payload: {}, erasedAt: expect.any(String) });
      reopened.close();
    }
  });
  it("unproven native wake ownership persists run quarantine across a fresh channel without replay", async () => {
    const { RunnerChannel } = await import("../src/domain/runner-channel.js");
    const { OutboxHandler } = await import("../src/domain/outbox-handler.js");
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.admit(f.node.id, { outboxId: "unowned", senderSession: "sender", destinationSession: "dev@channel", body: "question", kind: "wake", inputRoute: "native", payload: { question: "question" } });
    const post = (type: string, extra = {}) => f.channel.post(f.grant.token, { type, runId: f.grant.runId, requestId: "unowned", sequence: 1, ...extra });
    f.channel.frames(f.grant.token, 0); post("ack", { state: "accepted" }); post("submitted");
    expect(() => post("result", { result: { kind: "wake", completion: "completed", answer: "unrelated", ownershipUnknown: true } })).toThrow(/ownership|Invalid/);
    for (const ownershipUnknown of [false, "unknown"]) expect(() => post("result", { result: { kind: "wake", completion: "unknown", answer: null, ownershipUnknown } })).toThrow(/ownership|Invalid/);
    f.admit("following");
    post("result", { result: { kind: "wake", completion: "unknown", answer: null, ownershipUnknown: true } });
    expect(f.outbox.runnerReceipt("unowned")).toMatchObject({ stage: "completed", reconciliation: "native_ownership_unknown", result: { answer: null } });
    expect(f.outbox.getById("unowned")?.deliveryState).toBe("indeterminate");
    expect((await f.transport.sendNativeWake("dev@channel", "question", "unowned", "sender")).sent).toBeUndefined();
    const recovered = new RunnerChannel(f.grants, new OutboxHandler(f.db), new Set(["hosted-pi-rpc"]));
    recovered.post(f.grant.token, { ...f.hello, retained: false });
    cleanups.push(recovered.connect(f.grant.token));
    expect(recovered.capable(f.node.id, "wake")).toBe(false);
    expect(recovered.frames(f.grant.token, 0)).toEqual([]);
    expect(f.outbox.runnerReceipt("following")?.stage).toBe("pending");
    expect(() => recovered.admit(f.node.id, { outboxId: "later", senderSession: "sender", destinationSession: "dev@channel", body: "later", kind: "input", inputRoute: "native", payload: { text: "later" } })).toThrow();
    expect(f.outbox.runnerReceipt("unowned")?.result).toMatchObject({ answer: null, completion: "unknown" });
    expect(() => recovered.admit(f.node.id, { outboxId: "unowned", senderSession: "sender", destinationSession: "dev@channel", body: "question", kind: "wake", inputRoute: "native", payload: { question: "question" } })).toThrow();
    f.outbox.eraseRunner("unowned", new Date().toISOString());
    recovered.post(f.grant.token, f.hello);
    expect(recovered.capable(f.node.id, "wake")).toBe(false);
    expect(recovered.frames(f.grant.token, 0)).toEqual([]);
    expect(f.outbox.runnerReceipt("unowned")).toMatchObject({ payload: {}, erasedAt: expect.any(String), reconciliation: "native_ownership_unknown" });
    expect(f.outbox.runnerReceipt("unowned")?.result).toBeUndefined();
    expect(() => post("result", { result: { kind: "wake", completion: "completed", answer: "revived" } })).toThrow(/erased/);
  });
  it("broadcast counts pending and unknown native custody without claiming delivery or failure", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    const options = { deliveryId: "fan", actorSession: "sender" };
    expect(await f.transport.broadcast({ sessions: ["dev@channel"] }, "broadcast", options)).toMatchObject({ sent: 0, failed: 0, pendingNative: 1 });
    const id = "fan:dev@channel"; f.channel.frames(f.grant.token, 0);
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: id, sequence: 1, state: "accepted" });
    f.channel.post(f.grant.token, { type: "result", runId: "run-one", requestId: id, sequence: 1,
      result: { kind: "input", completion: "unknown", submissionUnknown: true } });
    const unknown = await f.transport.broadcast({ sessions: ["dev@channel"] }, "broadcast", options);
    expect(unknown).toMatchObject({ sent: 0, failed: 0, indeterminateNative: 1 });
    expect(unknown.results[0]?.sent).toBeUndefined();
  });
  it("the actual Pi runner delivers busy input and dedicated wakes through real Core routes", async () => {
    const f = await fixture(true, "pi", 0);
    const dir = mkdtempSync(join(tmpdir(), "pi-native-channel-")), bin = join(dir, "bin"), log = join(dir, "native.log");
    const { mkdirSync } = await import("node:fs"); mkdirSync(bin);
    const fake = join(bin, "pi");
    writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs');const send=v=>console.log(JSON.stringify(v));const log=v=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(v)+'\\n');let busy=false;
log({childToken:!!process.env.OPENRIG_ACTIVITY_HOOK_TOKEN});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);log(c);
if(c.type==='get_state')return send({type:'response',id:c.id,success:true,data:{isStreaming:busy,pendingMessageCount:0,sessionId:'native-fixture',sessionFile:${JSON.stringify(join(dir, "native.jsonl"))}}});
if(c.type==='get_entries')return send({type:'response',id:c.id,success:true,data:{entries:[]}});
if(c.type!=='prompt')return;
if(c.message==='HANDLED')return send({type:'response',id:c.id,command:'prompt',success:true,data:{disposition:'handled'}});
send({type:'response',id:c.id,command:'prompt',success:true,data:{disposition:busy?'queued':'started'}});if(busy)return;
busy=true;send({type:'agent_start'});setTimeout(()=>{send({type:'message_end',message:{role:'toolResult',content:[{type:'text',text:'not the answer'}]}});send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'answer '+c.message}],stopReason:'stop'}});busy=false;send({type:'agent_end'});},c.message==='BUSY'?500:100);
});`, { mode: 0o755 });
    let lostAck = false, lostResult = false;
    const server = serve({ fetch: async request => {
      const post = request.method === "POST" && new URL(request.url).pathname === "/api/activity/runner-channel"
        ? await request.clone().json() as { type?: string; requestId?: string } : null;
      const response = await f.app.fetch(request);
      if (post?.type === "ack" && !lostAck) { lostAck = true; return new Response(null, { status: 503 }); }
      if (post?.type === "result" && post.requestId === "wake-a" && !lostResult) { lostResult = true; return new Response(null, { status: 503 }); }
      return response;
    }, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const child = spawn(process.execPath, ["--import", "tsx", resolve(__dirname, "../src/adapters/pi-runner.ts"),
      "--session-name", "dev@channel", "--state-root", join(dir, "state"), "--cwd", dir, "--launch-id", "run-one", "--no-approve"],
      { cwd: resolve(__dirname, "../../.."), stdio: ["pipe", "pipe", "pipe"], env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir,
        OPENRIG_HOME: join(dir, "home"), OPENRIG_URL: url, OPENRIG_ACTIVITY_HOOK_TOKEN: f.grant.token, OPENRIG_RUN_ID: "run-one",
        OPENRIG_NODE_ID: f.node.id, OPENRIG_SESSION_NAME: "dev@channel", OPENRIG_OCCUPANT_GENERATION: f.grant.generation } });
    let output = ""; child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { output += String(chunk); });
    cleanups.push(() => { child.kill("SIGKILL"); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
    const entries = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
    expect(await waitFor(() => f.channel.capable(f.node.id, "input"), 4000), output).toBe(true);
    f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    await f.transport.send("dev@channel", "BUSY", { deliveryId: "busy", actorSession: "sender" });
    expect(await waitFor(() => entries().some(e => e.message === "BUSY")), output).toBe(true);
    await f.transport.send("dev@channel", "STEER", { deliveryId: "steer", actorSession: "sender" });
    await f.transport.sendNativeWake("dev@channel", "WAKE:A", "wake-a", "sender");
    await f.transport.sendNativeWake("dev@channel", "WAKE:B", "wake-b", "sender");
    expect(await waitFor(() => f.outbox.runnerReceipt("wake-b")?.stage === "completed"), output).toBe(true);
    expect(f.outbox.runnerReceipt("wake-a")?.result).toMatchObject({ kind: "wake", completion: "completed", answer: "answer WAKE:A" });
    expect(f.outbox.runnerReceipt("wake-b")?.result).toMatchObject({ completion: "completed", answer: "answer WAKE:B" });
    expect(entries().filter(e => e.type === "prompt").map(e => e.message)).toEqual(["BUSY", "STEER", "WAKE:A", "WAKE:B"]);
    expect(entries()).toContainEqual({ childToken: false });
    expect(lostAck && lostResult).toBe(true);
    server.closeAllConnections();
    expect(await waitFor(() => !f.channel.capable(f.node.id, "input")), output).toBe(true);
    expect(await waitFor(() => f.channel.capable(f.node.id, "input")), output).toBe(true);
    await f.transport.sendNativeWake("dev@channel", "WAKE:A", "wake-a", "sender");
    expect(entries().filter(entry => entry.message === "WAKE:A")).toHaveLength(1);
    await f.transport.sendNativeWake("dev@channel", "HANDLED", "handled", "sender");
    await f.transport.sendNativeWake("dev@channel", "/abort", "literal", "sender");
    expect(await waitFor(() => f.outbox.runnerReceipt("literal")?.stage === "completed"), output).toBe(true);
    expect(f.outbox.runnerReceipt("handled")?.result).toMatchObject({ answer: null, completion: "unknown" });
    expect(entries().filter(e => e.type === "abort")).toEqual([]);
    expect(f.outbox.runnerReceipt("literal")?.result).toMatchObject({ answer: "answer /abort" });
  }, 20000);
  it.each([["pi", 0, true], ["arbitrary-preset", 1, true], ["arbitrary-rpc", 2, false]] as const)("production channel intersects implemented families for %s/%i (enabled=%s)", async (runtime, runner, enabled) => {
    const { RunnerChannel } = await import("../src/domain/runner-channel.js");
    const f = await fixture(true, runtime, runner);
    const production = new RunnerChannel(f.grants, f.outbox);
    expect(production.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: enabled, wake: enabled, cancel: false } });
    expect(f.db.prepare("SELECT input_route FROM nodes WHERE id=?").get(f.node.id)).toEqual({ input_route: "typed" });
  });
  it("an explicitly disabled implementation never grants native input or cancellation", async () => {
    const f = await fixture(false);
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: false, wake: false, cancel: false } });
    expect(() => f.admit("one")).toThrow(/capable/);
    const live = await fixture();
    expect(live.channel.post(live.grant.token, live.hello)).toMatchObject({ capabilities: { input: true, wake: true, cancel: false } });
  });
  it("offers in order with one unacknowledged effect and retains accepted reconciliation beyond the cursor", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.admit("one"); f.admit("two");
    expect(f.channel.frames(f.grant.token, 0).map(frame => frame.requestId)).toEqual(["one"]);
    expect(f.channel.frames(f.grant.token, 1).map(frame => frame.requestId)).toEqual(["one"]);
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: "one", sequence: 1, state: "accepted" });
    expect(f.channel.frames(f.grant.token, 1).map(frame => frame.requestId)).toEqual(["two"]);
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ unresolved: [expect.objectContaining({ requestId: "one", stage: "accepted" }), expect.anything()] });
    const { RunnerChannel } = await import("../src/domain/runner-channel.js");
    const { ActivityGrantStore } = await import("../src/domain/activity-grants.js");
    const { OutboxHandler } = await import("../src/domain/outbox-handler.js");
    const restarted = new RunnerChannel(new ActivityGrantStore(f.db), new OutboxHandler(f.db), new Set(["hosted-pi-rpc"]));
    expect(restarted.post(f.grant.token, f.hello)).toMatchObject({ unresolved: [expect.objectContaining({ requestId: "one", stage: "accepted" }), expect.anything()] });
    expect(restarted.frames(f.grant.token, 1).map(frame => frame.requestId)).toEqual(["two"]);
    expect(() => f.channel.frames(f.grant.token, 3)).toThrow(/cursor/);
    expect(() => f.channel.post(f.grant.token, { type: "ack", runId: "other", requestId: "two", sequence: 2, state: "accepted" })).toThrow(/run/);
    f.grants.revoke({ grantId: f.grant.grantId }, "stopped");
    expect(() => f.channel.frames(f.grant.token, 0)).toThrow(/revoked/);
    expect(() => f.channel.post(f.grant.token, f.hello)).toThrow(/revoked/);
    expect(() => f.channel.post(INSTALL, f.hello)).toThrow(/bound/);
  });
  it("a receiver losing its map cannot reexecute an offered input even with an advanced cursor", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token)); f.admit("one"); f.admit("two");
    f.channel.frames(f.grant.token, 0);
    expect(f.channel.post(f.grant.token, { ...f.hello, retained: false })).toMatchObject({ unresolved: [expect.objectContaining({ reconciliation: "receiver_state_lost" }), expect.objectContaining({ stage: "pending" })] });
    expect(f.channel.frames(f.grant.token, 1)).toEqual([]);
    expect(f.outbox.getById("one")?.deliveryState).toBe("indeterminate");
  });
});
