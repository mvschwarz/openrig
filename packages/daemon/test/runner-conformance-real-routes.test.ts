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
  it.each([["omp", 0], ["arbitrary-rpc", 2]] as const)("the production %s/%i family supports only implemented input even after a blanket hello", async (runtime, runner) => {
    const f = await fixture(true, runtime, runner);
    const { RunnerChannel } = await import("../src/domain/runner-channel.js");
    const production = new RunnerChannel(f.grants, f.outbox);
    expect(production.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: true, wake: false, cancel: false } });
    cleanups.push(production.connect(f.grant.token));
    expect(production.capable(f.node.id, "input")).toBe(true);
    expect(() => production.admit(f.node.id, { outboxId: "unsupported", senderSession: "sender", destinationSession: "dev@channel", body: "question", kind: "wake", inputRoute: "native", payload: { question: "question" } })).toThrow(/capable/);
    expect(f.outbox.runnerReceipt("unsupported")).toBeNull();
    expect(f.db.prepare("SELECT agent_app,agent_runner FROM sessions WHERE node_id=?").get(f.node.id))
      .toMatchObject(runtime === "omp" ? { agent_app: null } : { agent_app: runtime, agent_runner: 2 });
  });
  async function fixture(enabled = true, runtime = "pi", runner = 0, file?: string,
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
    const bus = new EventBus(db);
    const people = { ok: true as const, entities: [] as ReturnType<typeof person>[] };
    const nudges: Array<{ session: string; message: string }> = [];
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => people,
      permissionDecider: () => null, transport: { send: async (session: string, message: string) => { nudges.push({ session, message }); return { ok: true, verified: true, sent: true }; } } });
    const activityStore = new AgentActivityStore({ db, eventBus: bus });
    const outbox = new OutboxHandler(db), channel = new RunnerChannel(grants, outbox, enabled ? new Set([runner === 0 ? "managed-pi" : runner === 1 ? "preset" : "hosted-pi-rpc"]) : new Set());
    queueRepo.attachOutbox(outbox);
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog: new MissionControlActionLog(db) });
    const { SeatDeliveryGuard, resolveGuardTarget } = await import("../src/domain/seat-delivery-guard.js");
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const { seatRoutes } = await import("../src/routes/seat.js");
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    const tmux = { deliveryGuard: guard };
    const transport = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: registry, tmuxAdapter: tmux as never, runnerChannel: channel });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("runnerChannel" as never, channel); c.set("rigRepo" as never, rigs);
      c.set("eventBus" as never, bus); c.set("queueRepo" as never, queueRepo); c.set("agentActivityStore" as never, activityStore); c.set("sessionRegistry" as never, registry);
      c.set("activityHookToken" as never, INSTALL); c.set("missionControlWriteContract" as never, contract);
      c.set("tmuxAdapter" as never, tmux); c.set("sessionTransport" as never, transport); await next();
    });
    app.route("/api/activity", activityRoutes); app.route("/api/seat", seatRoutes);
    app.route("/api/mission-control", missionControlRoutes());
    const hello = { type: "hello", version: 1, runId: "run-one", retained: true, capabilities: { input: true, wake: true, cancel: true } };
    const admit = (id: string) => channel.admit(grant.nodeId, { outboxId: id, senderSession: "sender", destinationSession: "dev@channel", body: id,
      kind: "input", inputRoute: "native", payload: { text: id } });
    return { db, node, grant, grants, outbox, channel, hello, admit, app, guard, transport, tmux, queueRepo, people, nudges };
  }
  it.each([false, true])("a native wake rechecks its route after waiting for the lease without typing or retaining the question (held=%s)", async held => {
    const f = await fixture(); f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    if (held) await f.guard.set(f.node.id, true, "operator", "hold input");
    const writes = vi.fn(async () => ({ ok: true }));
    Object.assign(f.tmux, { sendText: writes, sendKeys: writes });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const holder = f.guard.custody([f.node.id], async () => { entered(); await gate;
      f.db.prepare("UPDATE nodes SET input_route='typed' WHERE id=?").run(f.node.id); });
    await ready;
    const queued = vi.spyOn(f.guard, "operation");
    const pending = f.transport.sendNativeWake("dev@channel", "question", "route-race", "sender");
    await vi.waitFor(() => expect(queued).toHaveBeenCalled()); release(); await holder;
    expect(await pending).toMatchObject({ ok: false, sent: false, reason: "native_route_required" });
    expect(writes).not.toHaveBeenCalled(); expect(f.outbox.runnerReceipt("route-race")).toBeNull();
    expect(f.outbox.getById("route-race")).toBeNull();
  });

  it.each(["caller", "queue", "committed"])("native admission respects cancellation ownership after lease wait (%s)", async owner => {
    const f = await fixture(); f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    const controller = new AbortController();
    const id = `cancel-${owner}`;
    if (owner === "committed") f.outbox.record({ outboxId: id, senderSession: "sender", destinationSession: "dev@channel", body: "question" });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const holder = f.guard.operation("dev@channel", async () => { entered(); await gate; });
    await ready;
    const queued = vi.spyOn(f.guard, "operation");
    const pending = f.transport.send("dev@channel", "question", { deliveryId: id, actorSession: "sender", signal: controller.signal,
      ...(owner === "queue" ? { queueWake: true } : {}), ...(owner === "committed" ? { committedOutboxIds: [id] } : {}) });
    await vi.waitFor(() => expect(queued).toHaveBeenCalled()); controller.abort(); release(); await holder;
    const result = await pending;
    if (owner === "caller") {
      expect(result).toMatchObject({ ok: false, sent: false, reason: "caller_cancelled" });
      expect(f.outbox.runnerReceipt(id)).toBeNull();
    } else expect(result).toMatchObject({ ok: true, runnerReceipt: { requestId: id } });
  });

  it.each(["grant", "mapping"])("missing %s evidence refuses cancellation without inventing an ended invocation", async missing => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello);
    cleanups.push(f.channel.connect(f.grant.token));
    if (missing === "grant") f.grants.revoke({ grantId: f.grant.grantId }, "test");
    const response = await f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel", requestId: "unknown-target", target: { runId: "run-one", nativeTurnId: "E" } }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "runner_unavailable" });
    expect(f.outbox.runnerReceipt("unknown-target")).toBeNull();
  });
  it.each([false, true])("cancel caller abort after lease wait retains only existing immutable custody (existing=%s)", async existing => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const command = { type: "cancel", requestId: "caller-aborted-cancel", target: { runId: "run-one", nativeTurnId: "E" } };
    if (existing) f.channel.cancel(f.node.id, { requestId: command.requestId, sender: "unknown", destination: "dev@channel", target: command.target });
    const controller = new AbortController(); let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = f.guard.custody([f.node.id], async () => { entered(); await gate; }); await ready;
    const queued = vi.spyOn(f.guard, "custody");
    const request = (body = command) => f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify(body) });
    const pending = request(); await vi.waitFor(() => expect(queued).toHaveBeenCalled());
    controller.abort(); release(); await holder;
    const response = await pending;
    if (existing) {
      expect(response.status).toBe(202); expect(f.outbox.runnerReceipt(command.requestId)?.stage).toBe("pending");
      expect((await request({ ...command, target: { ...command.target, nativeTurnId: "F" } })).status).toBe(409);
    } else {
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "caller_cancelled" });
      expect(f.outbox.runnerReceipt(command.requestId)).toBeNull(); expect(f.outbox.getById(command.requestId)).toBeNull();
      expect(f.channel.frames(f.grant.token, 0)).toEqual([]);
    }
  });
  it.each(["disconnect", "standing"])("temporary cancel %s refuses before consuming an ID and same-ID recovery succeeds", async cause => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); let disconnect = f.channel.connect(f.grant.token); cleanups.push(() => disconnect());
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const command = { type: "cancel", requestId: "temporary", target: { runId: "run-one", nativeTurnId: "E" } };
    const post = () => f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    let calls = 0; const original = f.grants.standing.bind(f.grants);
    const fault = cause === "standing" ? vi.spyOn(f.grants, "standing").mockImplementation(id => ++calls === 2 ? "unverified" : original(id)) : null;
    if (cause === "disconnect") disconnect();
    const refused = await post(); expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ retryable: true });
    expect(f.outbox.runnerReceipt(command.requestId)).toBeNull(); fault?.mockRestore();
    if (cause === "disconnect") disconnect = f.channel.connect(f.grant.token);
    expect((await post()).status).toBe(202); expect(f.outbox.runnerReceipt(command.requestId)?.stage).toBe("pending");
  });
  it("pre-effect rejected cancel has no invented outcome, while cancel-only reconciliation does not block unrelated work", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const target = { runId: "run-one", nativeTurnId: "E" };
    const first = f.channel.cancel(f.node.id, { requestId: "retired", sender: "s", destination: "dev@channel", target });
    f.channel.frames(f.grant.token, 0); f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: first.requestId, sequence: first.sequence, state: "accepted" });
    const result = { kind: "cancel", reason: "preparation_failed", applied: false };
    for (const bad of [{ confirmed: "true" }, { operationAccepted: "true" }, { confirmed: true }])
      expect(() => f.channel.post(f.grant.token, { type: "rejected", runId: "run-one", requestId: first.requestId, sequence: first.sequence, result: { ...result, ...bad } })).toThrow(/cancellation outcome/);
    expect(f.outbox.runnerReceipt(first.requestId)?.stage).toBe("accepted");
    expect(f.channel.post(f.grant.token, { type: "rejected", runId: "run-one", requestId: first.requestId, sequence: first.sequence, result })).toMatchObject({ receipt: { stage: "rejected", result } });
    const second = f.channel.cancel(f.node.id, { requestId: "unknown-cancel", sender: "s", destination: "dev@channel", target });
    f.channel.frames(f.grant.token, first.sequence); f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: second.requestId, sequence: second.sequence, state: "accepted" });
    f.channel.prepareCancellation(f.grant.token, { runId: "run-one", requestId: second.requestId, sequence: second.sequence }, () => ({ confirmed: true, pendingSubmissions: 0, withdrawn: 0 }));
    f.channel.post(f.grant.token, { type: "submitted", runId: "run-one", requestId: second.requestId, sequence: second.sequence, result: { kind: "cancel", outcome: "requested", confirmed: false } });
    const submitted = f.outbox.runnerReceipt(second.requestId);
    expect(() => f.channel.post(f.grant.token, { type: "rejected", runId: "run-one", requestId: second.requestId, sequence: second.sequence, result })).toThrow(/different native result|Submitted/);
    expect(f.outbox.runnerReceipt(second.requestId)).toEqual(submitted);
    f.outbox.forgetRunnerMap(f.node.id, "run-one");
    expect(f.channel.capable(f.node.id, "input")).toBe(true);
    const next = f.admit("later-input"); expect(f.channel.frames(f.grant.token, 0).map(row => row.requestId)).toEqual([next.requestId]);
    expect(f.outbox.runnerReceipt(second.requestId)?.reconciliation).toBe("receiver_state_lost");
  });
  it("seat recovery projects current and historical uncertain native evidence without bodies or claiming all work is held", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const cancel = f.channel.cancel(f.node.id, { requestId: "uncertain-E", sender: "requester", destination: "dev@channel", target: { runId: "run-one", nativeTurnId: "E" } });
    for (const stage of ["offered", "accepted", "submitted"] as const) f.outbox.updateRunner(f.node.id, "run-one", cancel.requestId, cancel.sequence, stage);
    f.outbox.updateRunner(f.node.id, "run-one", cancel.requestId, cancel.sequence, "completed", { result: { kind: "cancel", outcome: "requested", confirmed: false } });
    f.db.prepare("UPDATE outbox_entries SET guard_delivery=json_set(guard_delivery,'$.runner.reconciliation','receiver_state_lost') WHERE outbox_id=?").run(cancel.requestId);
    f.admit("later-private-body");
    const old = f.outbox.admitRunner({ outboxId: "old-unknown", nodeId: f.node.id, runId: "older-run", senderSession: "old-requester", destinationSession: "dev@channel", body: "SECRET OLD BODY", inputRoute: "native", kind: "cancel", payload: { target: { runId: "older-run", nativeTurnId: "old-E" } } });
    for (const stage of ["offered", "accepted"] as const) f.outbox.updateRunner(f.node.id, "older-run", old.requestId, old.sequence, stage);
    f.outbox.forgetRunnerMap(f.node.id, "older-run");
    for (const runId of ["run-one", "historical-run"]) for (const kind of ["input", "wake"] as const) {
      const id = `${runId}-${kind}-resolved`, text = "PRIVATE RESOLVED PAYLOAD".repeat(50000);
      const resolved = f.outbox.admitRunner({ outboxId: id, nodeId: f.node.id, runId, senderSession: "sender", destinationSession: "dev@channel", body: text, inputRoute: "native", kind, payload: kind === "input" ? { text } : { question: text } });
      for (const stage of ["offered", "accepted", "submitted", "completed"] as const) f.outbox.updateRunner(f.node.id, runId, id, resolved.sequence, stage);
    }
    const reference = f.channel.unresolved(f.node.id);
    const { OutboxHandler } = await import("../src/domain/outbox-handler.js");
    const fullReads = vi.spyOn(OutboxHandler.prototype, "runnerReceipts"), bodyReads = vi.spyOn(OutboxHandler.prototype, "getById");
    cleanups.push(() => { fullReads.mockRestore(); bodyReads.mockRestore(); });
    const response = await f.app.request("/api/seat/status/dev%40channel"); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.nativeInput.unresolved).toEqual(reference);
    expect(data.nativeInput).toMatchObject({ input: true, wake: true, cancel: true, target: { runId: "run-one", nativeTurnId: "E" } });
    expect(fullReads).not.toHaveBeenCalled(); expect(bodyReads).not.toHaveBeenCalled();
    expect(data.nativeInput.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: "uncertain-E", inCurrentRun: true, sender: "requester", destination: "dev@channel", outcome: "requested" }),
      expect.objectContaining({ requestId: "old-unknown", inCurrentRun: false, reconciliation: "receiver_state_lost", destination: "dev@channel" }),
      expect.objectContaining({ requestId: "later-private-body", kind: "input", stage: "pending" }),
    ]));
    expect(JSON.stringify(data.nativeInput.unresolved)).not.toContain("SECRET OLD BODY");
    expect(data.nativeInput.unresolved.every((row: Record<string, unknown>) => !("body" in row) && !("payload" in row) && !("blocking" in row))).toBe(true);
    expect(data.nativeInput.recovery).toMatch(/rig seat stop.*--reason/);
    f.outbox.eraseRunner(cancel.requestId, "2026-11-16T00:00:00.000Z");
    const erased = await (await f.app.request("/api/seat/status/dev%40channel")).json();
    expect(erased.nativeInput.unresolved).toContainEqual(expect.objectContaining({ requestId: cancel.requestId, erasedAt: expect.any(String), target: { runId: "run-one", nativeTurnId: "E" } }));
    expect(JSON.stringify(erased.nativeInput.unresolved)).not.toContain("SECRET OLD BODY");
    f.db.prepare("UPDATE outbox_entries SET guard_delivery=json_set(guard_delivery,'$.runner.reconciliation','receiver_state_lost') WHERE outbox_id=?").run("later-private-body");
    fullReads.mockClear(); bodyReads.mockClear();
    const guarded = await (await f.app.request("/api/seat/status/dev%40channel")).json();
    expect(guarded.nativeInput).toMatchObject({ input: false, wake: false, cancel: false, target: null });
    expect(fullReads).not.toHaveBeenCalled(); expect(bodyReads).not.toHaveBeenCalled();
  });
  it.each(["ordinary", "retry-create", "no-owner", "same-node", "stopped-owner", "failed-delivery", "group", "erased-input", "erased-cancel", "erase-notice", "erase-members", "foreign-node", "old-run", "other-E"] as const)("retained continuation uses ordinary responsible-agent work without replay (%s)", async mode => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    const rigs = new RigRepository(f.db), registry = new SessionRegistry(f.db);
    const owner = rigs.addNode(f.node.rigId, "owner", { runtime: "claude-code" }); const ownerSession = registry.registerSession(owner.id, "owner@channel"); registry.updateStatus(ownerSession.id, "running");
    f.db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES('owner-binding',?,'owner@channel','%2')").run(owner.id);
    f.db.prepare("INSERT INTO edges(id,rig_id,source_id,target_id,kind) VALUES('continuation-owner',?,?,?,'delegates_to')").run(f.node.rigId, owner.id, f.node.id);
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const privateWords = "PRIVATE: continue the report without losing my words";
    if (mode === "group") {
      for (const [id, text] of [["retained-input-id", privateWords], ["group-member-id", "PRIVATE: second grouped words"]]) f.outbox.record({ outboxId: id!, senderSession: "person", destinationSession: "dev@channel", body: text! });
    }
    const retained = f.channel.admit(f.node.id, { outboxId: "retained-input-id", senderSession: "person", destinationSession: "dev@channel", body: privateWords, inputRoute: "native", kind: "input",
      ...(mode === "group" ? { memberIds: ["retained-input-id", "group-member-id"] } : {}), payload: { text: mode === "group" ? privateWords + "\nPRIVATE: second grouped words" : privateWords } }); for (const stage of ["offered", "accepted", "submitted", "completed"] as const) f.outbox.updateRunner(f.node.id, "run-one", retained.requestId, retained.sequence, stage, { nativeTurnId: "E" });
    const waiting = f.admit("waiting-F");
    const cancel = f.channel.cancel(f.node.id, { requestId: "continue-E", sender: "requester", destination: "dev@channel", target: { runId: "run-one", nativeTurnId: "E" } });
    f.channel.frames(f.grant.token, 0); f.outbox.updateRunner(f.node.id, "run-one", cancel.requestId, cancel.sequence, "accepted");
    f.channel.prepareCancellation(f.grant.token, { runId: "run-one", requestId: cancel.requestId, sequence: cancel.sequence }, () => ({ confirmed: true, pendingSubmissions: 0, withdrawn: 0 }));
    f.outbox.updateRunner(f.node.id, "run-one", cancel.requestId, cancel.sequence, "submitted", { result: { kind: "cancel", outcome: "requested", confirmed: false } });
    const body = { type: "result", runId: "run-one", requestId: cancel.requestId, sequence: cancel.sequence, result: { kind: "cancel", outcome: "requested", confirmed: false,
      continuation: { inputRequestIds: [retained.requestId], pendingRequestIds: [waiting.requestId], unmatchedCount: 0 } } };
    const foreignInput = ["foreign-node", "old-run", "other-E"].includes(mode);
    const foreignWords = "PRIVATE FOREIGN WORDS MUST STAY HIDDEN";
    if (foreignInput) {
      const nodeId = mode === "foreign-node" ? rigs.addNode(f.node.rigId, "other-input", { runtime: "pi" }).id : f.node.id;
      const runId = mode === "old-run" ? "older-run" : "run-one";
      const input = f.outbox.admitRunner({ outboxId: "foreign-input-id", nodeId, runId, senderSession: "another-person", destinationSession: "another-seat@channel", body: foreignWords, inputRoute: "native", kind: "input", payload: { text: foreignWords } });
      for (const stage of ["offered", "accepted", "submitted", "completed"] as const) f.outbox.updateRunner(nodeId, runId, input.requestId, input.sequence, stage, { nativeTurnId: mode === "other-E" ? "other-native-E" : "E" });
      body.result.continuation.inputRequestIds = [input.requestId];
    }
    const post = () => f.app.request("/api/activity/runner-channel", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.grant.token}` }, body: JSON.stringify(body) });
    if (mode === "no-owner" || mode === "same-node") f.db.prepare("DELETE FROM edges WHERE id='continuation-owner'").run();
    if (mode === "same-node") f.db.prepare("INSERT INTO edges(id,rig_id,source_id,target_id,kind) VALUES('self-owner',?,?,?,'delegates_to')").run(f.node.rigId, f.node.id, f.node.id);
    if (mode === "stopped-owner") registry.updateStatus(ownerSession.id, "exited");
    if (mode === "failed-delivery" || mode === "stopped-owner") f.queueRepo.attachTransport({ send: async (session, message) => { f.nudges.push({ session, message }); return { ok: false, sent: false, reason: "no_session", error: "offline fixture owner" }; } });
    if (mode === "erased-input") f.outbox.eraseRunner(retained.requestId, "2026-11-17T00:00:00Z");
    if (mode === "erased-cancel") f.outbox.eraseRunner(cancel.requestId, "2026-11-17T00:00:00Z");
    const notices = () => f.queueRepo.list({ limit: 100 }).filter(row => row.tags?.includes("native-continuation"));
    if (mode === "retry-create") {
      const failure = vi.spyOn(f.queueRepo, "create").mockRejectedValueOnce(new Error("transient queue failure"));
      expect((await post()).status).toBe(503); expect(f.outbox.runnerReceipt(cancel.requestId)?.stage).toBe("completed"); failure.mockRestore();
    }
    if (mode === "ordinary") for (const continuation of [
      { ...body.result.continuation, inputRequestIds: [retained.requestId, retained.requestId] },
      { ...body.result.continuation, unmatchedCount: -1 }, { ...body.result.continuation, words: ["must not copy runner words"] },
      { ...body.result.continuation, pendingRequestIds: ["x".repeat(1025)] },
    ]) {
      const rejected = await f.app.request("/api/activity/runner-channel", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.grant.token}` }, body: JSON.stringify({ ...body, result: { ...body.result, continuation } }) });
      expect(rejected.status).toBe(400); expect(f.outbox.runnerReceipt(cancel.requestId)?.stage).toBe("submitted");
    }
    const response = await post();
    if (mode === "erased-cancel") { expect(response.status).toBe(409); expect(notices()).toEqual([]); return; }
    expect(response.status).toBe(200);
    if (mode === "no-owner" || mode === "same-node") {
      expect(await response.json()).toMatchObject({ continuation: { state: "unavailable", step: expect.stringContaining("new plain prompt") } }); expect(notices()).toEqual([]); return;
    }
    expect(notices()).toHaveLength(1); expect(notices()[0]).toMatchObject({ sourceSession: "dev@channel", destinationSession: "owner@channel" });
    if (mode === "erased-input" || foreignInput) expect(notices()[0]!.body).not.toContain(privateWords); else expect(notices()[0]!.body).toContain(privateWords);
    if (foreignInput) { expect(notices()[0]!.body).not.toContain(foreignWords); expect(notices()[0]!.body).toContain("1 retained word entries were not observable or attributable"); }
    if (mode === "group") { expect(notices()[0]!.body).toContain("PRIVATE: second grouped words"); expect(notices()[0]!.body).toContain("group-member-id"); }
    expect(notices()[0]!.body).toContain("waiting-F");
    expect(notices()[0]!.body).toContain("new plain prompt"); expect(notices()[0]!.body).toContain("without resending");
    if (mode === "stopped-owner") { expect(notices()[0]!.body).toContain("stopped"); expect(notices()[0]!.body).toContain("not delivery or pickup proof"); }
    expect(await waitFor(() => f.nudges.some(nudge => nudge.session === "owner@channel"))).toBe(true);
    if (mode === "failed-delivery" || mode === "stopped-owner") expect(await waitFor(() => notices()[0]!.lastNudgeResult?.includes("failed"))).toBe(true);
    if (mode === "erase-notice" || mode === "erase-members") {
      const { eraseQueue } = await import("../src/domain/queue-erasure.js"); const noticeId = notices()[0]!.qitemId;
      const bySource = await eraseQueue(f.db, { scope: { kind: "members", members: ["dev@channel"] }, apply: false, nowIso: "2026-11-17T00:00:00Z" });
      expect(bySource.mixed).toContainEqual({ qitemId: noticeId, memberEndpoint: "source" });
      await eraseQueue(f.db, { scope: mode === "erase-notice" ? { kind: "ids", entries: [{ qitemId: noticeId, action: "scrub" }] } : { kind: "members", members: ["dev@channel", "owner@channel"] }, apply: true, nowIso: "2026-11-17T00:00:00Z" });
      expect(mode === "erase-notice" ? f.queueRepo.getById(noticeId)?.body : f.queueRepo.getById(noticeId)).toBe(mode === "erase-notice" ? "" : null);
      expect((await post()).status).toBe(200); expect(notices()).toEqual([]);
      expect(mode === "erase-notice" ? f.queueRepo.getById(noticeId)?.body : f.queueRepo.getById(noticeId)).toBe(mode === "erase-notice" ? "" : null);
      expect(f.nudges.filter(nudge => nudge.session === "owner@channel")).toHaveLength(1); return;
    }
    f.db.prepare("DELETE FROM edges WHERE id='continuation-owner'").run(); // A retry must keep its original work destination.
    expect((await post()).status).toBe(200); expect(notices()).toHaveLength(1);
    expect(f.nudges.filter(nudge => nudge.session === "owner@channel")).toHaveLength(1);
  });
  it("missing permission correlation is accepted diagnostically while claimed cancelled-E hints still deny", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello);
    const body = { nodeId: f.node.id, sessionName: "dev@channel", generation: f.grant.generation, runId: "run-one", nativeTurnId: "E", nativeRef: "native", turnId: "1", requestId: "uncorrelated",
      toolCall: { title: "edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] };
    const post = (request = body) => f.app.request("/api/activity/permission-requests", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.grant.token}` }, body: JSON.stringify(request) });
    const accepted = await post(); expect(accepted.status).toBe(200); expect(await accepted.json()).toMatchObject({ ok: true, correlation: "unverified" });
    f.db.prepare("INSERT INTO events(type,node_id,payload) VALUES('agent.runner_turn_fenced',?,?)").run(f.node.id, JSON.stringify({ runId: "run-one", nativeTurnId: "E" }));
    const refused = await post({ ...body, requestId: "late-E" }); expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ code: "turn_withdrawn" });
    expect((await post({ ...body, requestId: "wrong-run", runId: "other" })).status).toBe(409);
  });
  it("retains authenticated native epoch evidence with family-local sequence and replay conflict checks", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello);
    const report = { type: "turn", runId: f.grant.runId, sequence: 1, nativeTurnId: "epoch-E", state: "opened", acceptedTurnIds: ["1", "2"] };
    expect(() => f.channel.post(f.grant.token, { ...report, state: "closed" })).toThrow();
    expect(f.channel.post(f.grant.token, report)).toMatchObject({ accepted: true });
    expect(f.channel.post(f.grant.token, report)).toMatchObject({ accepted: true });
    expect(() => f.channel.post(f.grant.token, { ...report, acceptedTurnIds: ["3"] })).toThrow();
    expect(f.channel.currentTurn(f.node.id)).toMatchObject({ runId: f.grant.runId, nativeTurnId: "epoch-E", acceptedTurnIds: ["1", "2"] });
    f.channel.post(f.grant.token, { ...report, sequence: 2, state: "closed" });
    expect(f.channel.currentTurn(f.node.id)).toBeNull();
    expect(f.db.prepare("SELECT count(*) AS n FROM events WHERE type='agent.runner_turn'").get()).toEqual({ n: 2 });
    f.grants.revoke({ grantId: f.grant.grantId }, "test");
    expect(() => f.channel.post(f.grant.token, { ...report, sequence: 3 })).toThrow();
    expect(f.channel.currentTurn(f.node.id)).toBeNull();
  });
  it("retains named cancel and offers control ahead of successor input with no pending cancellation result", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); const disconnect = f.channel.connect(f.grant.token); cleanups.push(disconnect);
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const ordinary = f.admit("successor");
    const request = { type: "cancel", requestId: "cancel-E", target: { runId: "run-one", nativeTurnId: "E" } };
    const response = await f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(response.status).toBe(202);
    const receipt = f.outbox.runnerReceipt("cancel-E")!;
    expect(receipt).toMatchObject({ kind: "cancel", payload: { target: request.target }, stage: "pending" }); expect(receipt.result).toBeUndefined();
    expect(f.channel.frames(f.grant.token, 0)[0]?.requestId).toBe("cancel-E");
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: "cancel-E", sequence: receipt.sequence, state: "accepted" });
    expect(f.channel.prepareCancellation(f.grant.token, { type: "cancel-prepare", runId: "run-one", requestId: "cancel-E", sequence: receipt.sequence }, () => ({ confirmed: true, pendingSubmissions: 0, withdrawn: 0 })))
      .toMatchObject({ withdrawal: { confirmed: true } });
    expect(f.outbox.runnerReceipt("cancel-E")?.withdrawal?.stage).toBe("confirmed");
    expect(f.outbox.runnerReceipt(ordinary.requestId)?.stage).toBe("pending");
    expect((await f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, target: { ...request.target, nativeTurnId: "F" } }) })).status).toBe(409);
  });
  it.each(["binding", "failed read"])("keeps %s cancellation uncertainty separate from a changed native turn", async cause => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello);
    cleanups.push(f.channel.connect(f.grant.token));
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const request = { type: "cancel", requestId: "uncertain-cancel", target: { runId: "run-one", nativeTurnId: "E" } };
    const cancel = () => f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const standing = f.grants.standing.bind(f.grants);
    const fault = vi.spyOn(f.grants, "standing").mockImplementation(id => {
      if (cause === "binding") return "unverified";
      const prepare = f.db.prepare.bind(f.db);
      const read = vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
        if (sql === "PRAGMA table_info(activity_grants)") throw new Error("standing read unavailable");
        return prepare(sql);
      }) as typeof f.db.prepare);
      try { return standing(id); } finally { read.mockRestore(); }
    });
    try {
      expect(f.channel.currentTurn(f.node.id)).toBeNull();
      const refused = await cancel();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "runner_grant_unverified", retryable: true });
      expect(f.outbox.runnerReceipt(request.requestId)).toBeNull();
      expect(f.grants.get(f.grant.grantId)?.revokedAt).toBeNull();
    } finally { fault.mockRestore(); }
    const accepted = await cancel(); expect(accepted.status).toBe(202);
    const receipt = f.outbox.runnerReceipt(request.requestId)!;
    f.channel.frames(f.grant.token, 0);
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: request.requestId, sequence: receipt.sequence, state: "accepted" });
    const saved = f.outbox.runnerReceipt(request.requestId), withdraw = vi.fn(() => ({ confirmed: true, pendingSubmissions: 0, withdrawn: 0 }));
    let calls = 0;
    const uncertainTarget = vi.spyOn(f.grants, "standing").mockImplementation(id => ++calls === 1 ? standing(id) : "unverified");
    try {
      expect(() => f.channel.prepareCancellation(f.grant.token, { type: "cancel-prepare", runId: "run-one", requestId: request.requestId, sequence: receipt.sequence }, withdraw)).toThrow(/unverified/);
      expect(withdraw).not.toHaveBeenCalled();
      expect(f.outbox.runnerReceipt(request.requestId)).toEqual(saved);
    } finally { uncertainTarget.mockRestore(); }
    expect(f.channel.prepareCancellation(f.grant.token, { type: "cancel-prepare", runId: "run-one", requestId: request.requestId, sequence: receipt.sequence }, withdraw))
      .toMatchObject({ withdrawal: { confirmed: true } });
    expect(withdraw).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("explicit receiver map loss invalidates E durably with only completed receipts=%s", async completedReceipt => {
    const dir = mkdtempSync(join(tmpdir(), "native-empty-map-")), file = join(dir, "core.sqlite");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await fixture(true, "pi", 0, file);
    const turn = { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "person-E", state: "opened", acceptedTurnIds: ["1"] };
    expect(() => f.channel.post(f.grant.token, turn)).toThrow(/Handshake required/);
    f.channel.post(f.grant.token, { ...f.hello, retained: false });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.runner_map_lost'").get()).toEqual({ n: 0 });
    f.channel.post(f.grant.token, turn);
    expect(f.channel.currentTurn(f.node.id)?.nativeTurnId).toBe("person-E");
    f.channel.post(f.grant.token, f.hello);
    const disconnect = f.channel.connect(f.grant.token);
    f.channel.post(f.grant.token, { ...turn, sequence: 2 });
    expect(f.channel.currentTurn(f.node.id)?.nativeTurnId).toBe("person-E");
    if (completedReceipt) {
      const input = f.admit("completed-input"); f.channel.frames(f.grant.token, 0);
      const body = { runId: "run-one", requestId: input.requestId, sequence: input.sequence };
      f.channel.post(f.grant.token, { ...body, type: "ack", state: "accepted" });
      f.channel.post(f.grant.token, { ...body, type: "submitted", acceptedTurnId: "1", nativeTurnId: "person-E" });
      f.channel.post(f.grant.token, { ...body, type: "result", result: { kind: "input", accepted: true } });
    }
    const receipts = f.outbox.runnerReceipts(f.node.id, "run-one");
    expect(receipts).toHaveLength(completedReceipt ? 1 : 0);
    if (completedReceipt) expect(receipts[0]?.stage).toBe("completed");
    disconnect(); expect(f.channel.currentTurn(f.node.id)?.nativeTurnId).toBe("person-E");
    f.channel.post(f.grant.token, { ...f.hello, retained: false });
    expect(f.channel.currentTurn(f.node.id)).toBeNull();
    expect(f.outbox.runnerReceipts(f.node.id, "run-one")).toEqual(receipts);
    // A late same-run report/retained hello cannot reconstruct a map the receiver says it lost.
    f.channel.post(f.grant.token, f.hello); f.channel.post(f.grant.token, { ...turn, sequence: 3 });
    expect(f.channel.currentTurn(f.node.id)).toBeNull();
    f.db.close();
    const reopened = await fixture(true, "pi", 0, file, { node: f.node, grant: f.grant });
    expect(reopened.channel.currentTurn(f.node.id)).toBeNull();
    reopened.channel.post(f.grant.token, { ...f.hello, retained: false });
    expect(reopened.channel.currentTurn(f.node.id)).toBeNull();
    expect(reopened.outbox.runnerReceipts(f.node.id, "run-one")).toEqual(receipts);
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.runner_map_lost'").get()).toEqual({ n: 1 });
    const command = { requestId: "after-map-loss", sender: "s", destination: "dev@channel", target: { runId: "run-one", nativeTurnId: "person-E" } };
    expect(() => reopened.channel.cancel(f.node.id, command)).toThrow(/ownership is unknown/);
    expect(reopened.outbox.runnerReceipt(command.requestId)).toBeNull();
    const next = reopened.grants.issue({ nodeId: f.node.id, generation: f.grant.generation, issuedBy: "replacement",
      run: { runId: "run-two", binding: f.grant.binding! } });
    expect(reopened.grants.activate(next.grantId)).toBe(true);
    reopened.channel.post(next.token, { ...f.hello, runId: "run-two", retained: false });
    reopened.channel.post(next.token, { ...turn, runId: "run-two", nativeTurnId: "F" });
    expect(reopened.channel.currentTurn(f.node.id)).toMatchObject({ runId: "run-two", nativeTurnId: "F" });
    const close = reopened.channel.connect(next.token); expect(reopened.channel.capable(f.node.id, "cancel")).toBe(true); close();
  });
  it("retains cancellation preparation while another native receipt needs reconciliation", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const target = { runId: "run-one", nativeTurnId: "E" };
    const receipt = f.channel.cancel(f.node.id, { requestId: "held-cancel", sender: "s", destination: "dev@channel", target });
    f.channel.frames(f.grant.token, 0);
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: receipt.requestId, sequence: receipt.sequence, state: "accepted" });
    const saved = f.outbox.runnerReceipt(receipt.requestId);
    const unknown = f.outbox.admitRunner({ outboxId: "unknown-wake", senderSession: "s", destinationSession: "dev@channel", body: "wake",
      nodeId: f.node.id, runId: "run-one", kind: "wake", inputRoute: "native", payload: { question: "wake" } });
    for (const stage of ["offered", "accepted", "submitted"] as const) f.outbox.updateRunner(f.node.id, "run-one", unknown.requestId, unknown.sequence, stage);
    f.outbox.updateRunner(f.node.id, "run-one", unknown.requestId, unknown.sequence, "completed",
      { result: { kind: "wake", completion: "unknown", answer: null, ownershipUnknown: true } });
    expect(f.channel.currentTurn(f.node.id)).toBeNull();
    const withdraw = vi.fn(() => ({ confirmed: true, pendingSubmissions: 0, withdrawn: 0 }));
    expect(() => f.channel.prepareCancellation(f.grant.token, { type: "cancel-prepare", runId: "run-one", requestId: receipt.requestId, sequence: receipt.sequence }, withdraw))
      .toThrow(/ownership is unknown/);
    expect(withdraw).not.toHaveBeenCalled(); expect(f.outbox.runnerReceipt(receipt.requestId)).toEqual(saved);
    expect(() => f.channel.cancel(f.node.id, { requestId: "new-cancel", sender: "s", destination: "dev@channel", target })).toThrow(/ownership is unknown/);
    expect(f.outbox.runnerReceipt("new-cancel")).toBeNull();
  });
  it.each([[2, "unverified"], [2, "failed read"], [3, "unverified"], [3, "failed read"]] as const)
    ("keeps permission metadata standing read %s %s retryable without recording a request", async (at, cause) => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello);
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const { ActivityGrantStore } = await import("../src/domain/activity-grants.js");
    const standing = ActivityGrantStore.prototype.standing;
    let calls = 0;
    const fault = vi.spyOn(ActivityGrantStore.prototype, "standing").mockImplementation(function (this: InstanceType<typeof ActivityGrantStore>, id) {
      if (++calls !== at) return standing.call(this, id);
      if (cause === "unverified") return "unverified";
      const prepare = f.db.prepare.bind(f.db);
      const read = vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
        if (sql === "PRAGMA table_info(activity_grants)") throw new Error("standing read unavailable");
        return prepare(sql);
      }) as typeof f.db.prepare);
      try { return standing.call(this, id); } finally { read.mockRestore(); }
    });
    const body = { nodeId: f.node.id, sessionName: "dev@channel", generation: f.grant.generation,
      runId: "run-one", nativeTurnId: "E", nativeRef: "native", turnId: "1", requestId: "late-auth",
      toolCall: { title: "edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] };
    const post = () => f.app.request("/api/activity/permission-requests", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.grant.token}` }, body: JSON.stringify(body) });
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM events").get();
    try {
      const refused = await post(); expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: expect.stringMatching(/^(activity|runner)_grant_unverified$/), retryable: true });
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before);
      expect(f.queueRepo.list({ limit: 100 })).toEqual([]);
      expect(f.grants.get(f.grant.grantId)?.revokedAt).toBeNull();
    } finally { fault.mockRestore(); }
    expect((await post()).status).toBe(200);
    const missing = await postWithMissingTurn(); expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ correlation: "unverified" });
    async function postWithMissingTurn() {
      return f.app.request("/api/activity/permission-requests", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.grant.token}` }, body: JSON.stringify({ ...body, nativeTurnId: "missing" }) });
    }
  });
  it("keeps retained E and permission binding during SSE disconnect without pretending unknown is idle", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello);
    const disconnect = f.channel.connect(f.grant.token);
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    disconnect();
    expect(f.channel.capable(f.node.id, "cancel")).toBe(false);
    expect(f.channel.currentTurn(f.node.id)).toMatchObject({ runId: "run-one", nativeTurnId: "E" });
    const response = await f.app.request("/api/activity/permission-requests", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${f.grant.token}` },
      body: JSON.stringify({ nodeId: f.node.id, sessionName: "dev@channel", generation: f.grant.generation,
        runId: "run-one", nativeTurnId: "E", nativeRef: "native", turnId: "1", requestId: "still-live",
        toolCall: { title: "edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: "permitted", optionId: "allow" });
  });
  it("pending withdrawal has no fifth outcome, late E preserves its withdrawal evidence and wrong-run preparation has no effects", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    const turn = { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] };
    f.channel.post(f.grant.token, turn);
    const receipt = f.channel.cancel(f.node.id, { requestId: "cancel", sender: "sender", destination: "dev@channel", target: { runId: "run-one", nativeTurnId: "E" } });
    f.channel.frames(f.grant.token, 0); f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: receipt.requestId, sequence: receipt.sequence, state: "accepted" });
    const body = { type: "cancel-prepare", runId: "run-one", requestId: receipt.requestId, sequence: receipt.sequence };
    let calls = 0; const withdraw = () => { calls++; return { confirmed: false, pendingSubmissions: 1, withdrawn: 2 }; };
    expect(() => f.channel.prepareCancellation(f.grant.token, { ...body, runId: "another" }, withdraw)).toThrow(); expect(calls).toBe(0);
    f.channel.prepareCancellation(f.grant.token, body, withdraw);
    expect(f.outbox.runnerReceipt(receipt.requestId)).toMatchObject({ withdrawal: { stage: "pending", withdrawn: 2 } });
    expect(f.outbox.runnerReceipt(receipt.requestId)?.result).toBeUndefined();
    expect(() => f.channel.post(f.grant.token, { ...body, type: "submitted", result: { kind: "cancel", outcome: "requested", confirmed: false } })).toThrow();
    f.channel.post(f.grant.token, { ...turn, sequence: 2, state: "closed" });
    expect(f.channel.prepareCancellation(f.grant.token, body, withdraw)).toMatchObject({ withdrawal: { notThisTurn: true } }); expect(calls).toBe(1);
    f.channel.post(f.grant.token, { ...body, type: "result", result: { kind: "cancel", outcome: "not-this-turn", confirmed: false } });
    expect(f.outbox.runnerReceipt(receipt.requestId)).toMatchObject({ stage: "completed", result: { outcome: "not-this-turn" }, withdrawal: { stage: "pending", withdrawn: 2 } });
  });
  it("retains pending withdrawal stage on owner failure and never repeats a confirmed withdrawal", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    const receipt = f.channel.cancel(f.node.id, { requestId: "withdraw-failure", sender: "s", destination: "dev@channel", target: { runId: "run-one", nativeTurnId: "E" } });
    f.channel.frames(f.grant.token, 0); f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: receipt.requestId, sequence: receipt.sequence, state: "accepted" });
    const body = { type: "cancel-prepare", runId: "run-one", requestId: receipt.requestId, sequence: receipt.sequence };
    try { f.channel.prepareCancellation(f.grant.token, body, () => { throw new Error("withdrawal store failed"); }); } catch { /* retained stage is the proof, never native submission */ }
    expect(f.outbox.runnerReceipt(receipt.requestId)?.withdrawal?.stage).toBe("pending");
    expect(f.outbox.runnerReceipt(receipt.requestId)?.result).toBeUndefined();
    let calls = 0; const withdraw = () => { calls++; return { confirmed: true, pendingSubmissions: 0, withdrawn: 0 }; };
    f.channel.prepareCancellation(f.grant.token, body, withdraw); f.channel.prepareCancellation(f.grant.token, body, withdraw);
    expect(calls).toBe(1);
  });
  it("cancel results progress requested to actual proof without allowing terminal reversal or unsupported after submission", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    const invalid = await f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "cancel", requestId: "no-target" }) });
    expect(invalid.status).toBe(400); expect(f.outbox.runnerReceipt("no-target")).toBeNull();
    f.channel.post(f.grant.token, { type: "turn", runId: "run-one", sequence: 1, nativeTurnId: "E", state: "opened", acceptedTurnIds: ["1"] });
    f.channel.post(f.grant.token, { ...f.hello, capabilities: { input: true, wake: true, cancel: false } });
    expect(f.channel.cancel(f.node.id, { requestId: "unsupported", sender: "s", destination: "dev@channel", target: { runId: "run-one", nativeTurnId: "E" } })).toMatchObject({ stage: "completed", result: { outcome: "not-supported", confirmed: false } });
    f.channel.post(f.grant.token, f.hello);
    const receipt = f.channel.cancel(f.node.id, { requestId: "progress", sender: "s", destination: "dev@channel", target: { runId: "run-one", nativeTurnId: "E" } });
    const body = { runId: "run-one", requestId: receipt.requestId, sequence: receipt.sequence };
    f.channel.frames(f.grant.token, 0); f.channel.post(f.grant.token, { ...body, type: "ack", state: "accepted" });
    f.channel.prepareCancellation(f.grant.token, body, () => ({ confirmed: true, pendingSubmissions: 0, withdrawn: 0 }));
    f.channel.post(f.grant.token, { ...body, type: "submitted", result: { kind: "cancel", outcome: "requested", confirmed: false } });
    expect(f.outbox.runnerReceipt(receipt.requestId)?.result?.outcome).toBe("requested");
    expect(f.outbox.getById(receipt.requestId)?.deliveryState).toBe("indeterminate");
    expect(() => f.channel.post(f.grant.token, { ...body, type: "result", result: { kind: "cancel", outcome: "not-supported", confirmed: false } })).toThrow();
    f.channel.post(f.grant.token, { ...body, type: "result", result: { kind: "cancel", outcome: "cancelled", confirmed: true } });
    expect(() => f.channel.post(f.grant.token, { ...body, type: "result", result: { kind: "cancel", outcome: "requested", confirmed: false } })).toThrow();
    expect(f.outbox.runnerReceipt(receipt.requestId)?.result?.outcome).toBe("cancelled");
  });
  async function nativeProcess(kind: "pi" | "dsh", program?: { bin: string; providerUrl: string }) {
    const dir = mkdtempSync(join(tmpdir(), `native-recovery-${kind}-`)), file = join(dir, "core.sqlite"), log = join(dir, "native.log");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { mkdirSync } = await import("node:fs"); const bin = join(dir, "bin"); mkdirSync(bin);
    const backend = join(bin, kind);
    const common = `#!${process.execPath}\nconst fs=require('node:fs');const send=x=>{log({native:x});console.log(JSON.stringify(x));};const log=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');log({childToken:!!process.env.OPENRIG_ACTIVITY_HOOK_TOKEN,childPid:process.pid});process.stdin.on('end',()=>process.exit(0));`;
    // Distinct offline RPC and ACP backends. Each is exercised through its own production consumer.
    writeFileSync(backend, kind === "pi" ? `${common}
let busy=false,timer,activeText='';const end=(stopReason,message)=>{send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'answer '+message}],stopReason}});busy=false;send({type:'agent_end'});send({type:'agent_settled',aborted:stopReason==='aborted'});};require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);log(c);
if(c.type==='get_state')return send({type:'response',id:c.id,success:true,data:{isStreaming:busy,pendingMessageCount:0,sessionId:'fixture'}});
if(c.type==='get_entries')return send({type:'response',id:c.id,success:true,data:{entries:[]}});if(c.type==='abort'){if(activeText.includes('EXIT CANCEL'))return process.exit(7);if(busy&&!activeText.includes('IGNORE CANCEL')){clearTimeout(timer);end('aborted','cancelled');}return send({type:'response',id:c.id,success:true});}if(c.type!=='prompt')return;
if(c.message==='REFUSE')return send({type:'response',id:c.id,success:false,error:'fixture refusal'});
send({type:'response',id:c.id,command:'prompt',success:true,data:{disposition:busy?'queued':'started'}});if(busy)return;
busy=true;activeText=c.message;send({type:'agent_start'});timer=setTimeout(()=>end(c.message==='INTERRUPT'?'aborted':'stop',c.message),c.message.startsWith('HOLD')?5000:c.message.startsWith('SLOW')?900:80);
});` : `${common}
if(process.argv.includes('--version')){console.log('fixture dsh');process.exit(0);}const session='native-fixture';let active,timer,activeText='';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);log(c);const reply=result=>send({jsonrpc:'2.0',id:c.id,result});
if(c.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{},agentInfo:{name:'dsh',version:'fixture'}});
if(c.method==='session/new')return reply({sessionId:session});if(c.method==='session/cancel'){if(activeText.includes('EXIT CANCEL'))return process.exit(7);if(activeText.includes('IGNORE CANCEL'))return;if(active){clearTimeout(timer);active({stopReason:'cancelled'});active=null;}return;}if(c.method!=='session/prompt')return;
const text=c.params.prompt.map(p=>p.text||'').join('');activeText=text;if(text==='REFUSE')return send({jsonrpc:'2.0',id:c.id,error:{code:-32602,message:'fixture refusal'}});
if(text.includes('PERMISSION E'))for(const id of [1001,1002])send({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:session,toolCall:{title:'edit '+id,kind:'edit'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'reject',name:'Reject',kind:'reject_once'}]}});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer '+text}}}});
active=reply;timer=setTimeout(()=>{active=null;reply({stopReason:text==='INTERRUPT'?'cancelled':'end_turn'});},text.includes('PERMISSION E')?20000:text.startsWith('HOLD')?5000:text.startsWith('SLOW')?900:80);
});`, { mode: 0o755 });
    if (program) {
      // A transparent scratch wire tap counts real RPC/ACP effects; it never substitutes native replies.
      writeFileSync(backend, `#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline'),spawn=require('node:child_process').spawn;
const log=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');log({childToken:!!process.env.OPENRIG_ACTIVITY_HOOK_TOKEN,childPid:process.pid});
const child=spawn(${JSON.stringify(program.bin)},process.argv.slice(2),{env:process.env,stdio:['pipe','pipe','inherit']});
child.stdin.on('error',()=>{});
rl.createInterface({input:process.stdin}).on('line',line=>{try{log(JSON.parse(line));}catch{}child.stdin.write(line+'\\n');}).on('close',()=>{child.stdin.end();setTimeout(()=>child.kill('SIGKILL'),1000).unref();});
rl.createInterface({input:child.stdout}).on('line',line=>{try{const x=JSON.parse(line);const data=x.data,result=x.result;
log({native:{type:x.type,id:x.id,method:x.method,success:x.success,aborted:x.aborted,steering:x.steering,followUp:x.followUp,
message:x.message?{role:x.message.role,stopReason:x.message.stopReason}:undefined,
data:data?{isStreaming:data.isStreaming,pendingMessageCount:data.pendingMessageCount,disposition:data.disposition,steering:data.steering,followUp:data.followUp}:undefined,
result:result?{stopReason:result.stopReason,sessionId:result.sessionId,outcome:result.outcome}:undefined}});}catch{}process.stdout.write(line+'\\n');});
process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
`, { mode: 0o755 });
    }
    if (program && kind === "pi") {
      const agent = join(dir, "state", "dev@channel", "agent"); mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { local: { baseUrl: program.providerUrl, api: "anthropic-messages", apiKey: "offline-dummy", models: [{ id: "fixture-model", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    }
    let current = await fixture(true, kind, kind === "pi" ? 0 : 1, file);
    let fault: { type: string; commit: boolean; hits: number; requestId?: string; status?: number } | null = null;
    let lookupDelay = 0;
    let ackGate: Promise<void> | null = null; let heldAcks = 0;
    let cancelPrepareGate: ((requestId: string) => Promise<void>) | null = null;
    let permissionReadGate: Promise<void> | null = null, heldPermissionReads = 0;
    let hellos = 0;
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const body = request.method === "POST" && new URL(request.url).pathname === "/api/activity/runner-channel" ? await request.clone().json() as { type: string; requestId?: string } : null;
      if (body?.type === "hello") hellos += 1;
      const active = fault && body?.type === fault.type && (!fault.requestId || fault.requestId === body.requestId) ? fault : null;
      if (active) active.hits += 1;
      if (active && !active.commit) return new Response(null, { status: active.status ?? 503 });
      if (body?.type === "ack" && ackGate) { heldAcks++; await ackGate; }
      const response = await current.app.fetch(request);
      if (body?.type === "cancel-prepare" && cancelPrepareGate) await cancelPrepareGate(body.requestId!);
      if (permissionReadGate && request.method === "GET" && new URL(request.url).pathname.startsWith("/api/activity/permission-requests/")) {
        const answer = await response.clone().json() as { state?: string; optionId?: string };
        if (answer.state === "answered" && answer.optionId) { heldPermissionReads++; await permissionReadGate; }
      }
      if (lookupDelay && request.method === "GET" && new URL(request.url).pathname.startsWith("/api/seat/command/")) await sleep(lookupDelay);
      return active ? new Response(null, { status: active.status ?? 503 }) : response;
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
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), DSH_HOME: join(dir, "dsh"), DSH_SEAT_BIN: backend, DSH_TELEMETRY_DISABLED: "1", ...(program ? { DEEPSEEK_API_KEY: "offline-dummy", DEEPSEEK_BASE_URL: program.providerUrl } : {}),
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
      set ackGate(value: Promise<void> | null) { ackGate = value; }, get heldAcks() { return heldAcks; },
      set cancelPrepareGate(value: ((requestId: string) => Promise<void>) | null) { cancelPrepareGate = value; },
      set permissionReadGate(value: Promise<void> | null) { permissionReadGate = value; }, get heldPermissionReads() { return heldPermissionReads; },
      get fault() { return fault; }, set fault(value) { fault = value; }, set lookupDelay(value: number) { lookupDelay = value; } };
  }

  it.each(["stale preparation", "busy successor", "native exit", "target end"] as const)("dsh captured preparation identity survives %s without stale native cancellation", async mode => {
    const h = await nativeProcess("dsh"), child = h.start(); await h.ready(); child.stdin!.write(mode === "target end" ? "SLOW E\n" : "HOLD E\n");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    let releaseFirst!: () => void, releaseSecond!: () => void; let enteredFirst = false, enteredSecond = false;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; }), secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    cleanups.push(() => { releaseFirst(); releaseSecond(); });
    h.cancelPrepareGate = id => { if (id === "R1") { enteredFirst = true; return firstGate; } enteredSecond = true; return secondGate; };
    const post = (requestId: string) => h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "cancel", requestId, target }) });
    expect((await post("R1")).status).toBe(202); expect(await waitFor(() => enteredFirst)).toBe(true);
    if (mode === "target end") {
      expect(await waitFor(() => h.f.outbox.runnerReceipt("R1")?.result?.outcome === "not-this-turn"), h.output).toBe(true);
      child.stdin!.write("PERSON F\n");
      expect(await waitFor(() => h.prompts().includes("PERSON F")), h.output).toBe(true); releaseFirst();
    } else if (mode === "native exit") {
      const pid = h.entries().filter(entry => typeof entry.childPid === "number").at(-1)!.childPid as number; process.kill(pid, "SIGKILL");
      expect(await waitFor(() => h.f.outbox.runnerReceipt("R1")?.stage === "rejected"), h.output).toBe(true);
      expect(h.f.outbox.runnerReceipt("R1")?.result).toMatchObject({ applied: false, reason: "runner_exited_before_write" }); releaseFirst();
    } else {
      if (mode === "stale preparation") {
        child.stdin!.write("PERSON F\n"); expect(await waitFor(() => h.f.outbox.runnerReceipt("R1")?.stage === "rejected"), h.output).toBe(true);
      }
      expect((await post("R2")).status).toBe(202);
      if (mode === "stale preparation") {
        expect(await waitFor(() => enteredSecond)).toBe(true); releaseFirst(); releaseSecond();
        expect(await waitFor(() => h.f.outbox.runnerReceipt("R2")?.result?.outcome === "cancelled"), h.output).toBe(true);
        expect(await waitFor(() => h.prompts().includes("PERSON F")), h.output).toBe(true);
        expect(h.f.outbox.runnerReceipt("R1")?.stage).toBe("rejected");
      } else {
        expect(await waitFor(() => h.f.outbox.runnerReceipt("R2")?.stage === "rejected"), h.output).toBe(true);
        expect(h.f.outbox.runnerReceipt("R2")?.result).toMatchObject({ reason: "cancellation_in_progress", applied: false });
        releaseFirst(); expect(await waitFor(() => h.f.outbox.runnerReceipt("R1")?.result?.outcome === "cancelled"), h.output).toBe(true);
      }
    }
    expect(h.entries().filter(entry => entry.method === "session/cancel")).toHaveLength(["native exit", "target end"].includes(mode) ? 0 : 1);
  });
  it("dsh clears an already-finished cancellation fence only after its still-outstanding native prompt ends", async () => {
    const h = await nativeProcess("dsh"), child = h.start(); await h.ready(); child.stdin!.write("HOLD E\n");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    const prepare = h.f.channel.prepareCancellation.bind(h.f.channel);
    const coreEnded = vi.spyOn(h.f.channel, "prepareCancellation").mockImplementationOnce((...args) => {
      h.f.channel.post(h.f.grant.token, { type: "turn", runId: target!.runId, nativeTurnId: target!.nativeTurnId, sequence: 2, state: "closed", acceptedTurnIds: target!.acceptedTurnIds });
      return prepare(...args);
    }); cleanups.push(() => coreEnded.mockRestore());
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "cancel", requestId: "core-ended-E", target }) })).status).toBe(202);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("core-ended-E")?.result?.outcome === "not-this-turn"), h.output).toBe(true);
    const ePrompt = h.entries().find(entry => entry.method === "session/prompt")!;
    expect(h.entries().some(entry => (entry.native as { id?: unknown } | undefined)?.id === ePrompt.id)).toBe(false);
    child.stdin!.write("PERSON F\n"); await h.f.transport.sendNativeWake("dev@channel", "MANAGED F", "managed-after-E", "sender");
    expect(h.prompts()).toEqual(["HOLD E"]); expect(h.entries().filter(entry => entry.method === "session/cancel")).toEqual([]);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("managed-after-E")?.result?.completion === "completed"), h.output).toBe(true);
    expect(h.prompts()).toEqual(["HOLD E", "PERSON F", "MANAGED F"]);
    expect(h.entries().filter(entry => entry.method === "session/cancel")).toEqual([]);
  });
  it("dsh target end releases locally before a delayed accepted ACK, then reports only after custody acceptance", async () => {
    const h = await nativeProcess("dsh"), child = h.start(); await h.ready(); child.stdin!.write("SLOW E\n");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    let release!: () => void; h.ackGate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(() => release());
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "cancel", requestId: "delayed-ACK", target }) })).status).toBe(202);
    expect(await waitFor(() => h.heldAcks === 1)).toBe(true);
    expect(await waitFor(() => h.f.channel.currentTurn(h.f.node.id) === null)).toBe(true);
    child.stdin!.write("PERSON F\n");
    expect(await waitFor(() => h.prompts().includes("PERSON F")), h.output).toBe(true);
    expect(h.f.outbox.runnerReceipt("delayed-ACK")?.stage).toBe("offered");
    release(); expect(await waitFor(() => h.f.outbox.runnerReceipt("delayed-ACK")?.stage === "rejected" || h.f.outbox.runnerReceipt("delayed-ACK")?.result?.outcome === "not-this-turn"), h.output).toBe(true);
    expect(h.entries().filter(entry => entry.method === "session/cancel")).toEqual([]);
  });
  it("dsh person abort remains repeatable after a managed cancel was already requested", async () => {
    const h = await nativeProcess("dsh"), child = h.start(); await h.ready(); child.stdin!.write("HOLD IGNORE CANCEL E\n");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "cancel", requestId: "managed-once", target }) })).status).toBe(202);
    expect(await waitFor(() => h.entries().filter(entry => entry.method === "session/cancel").length === 1)).toBe(true);
    child.stdin!.write("/abort\n/abort\n");
    expect(await waitFor(() => h.entries().filter(entry => entry.method === "session/cancel").length === 3)).toBe(true);
    expect(h.f.outbox.runnerReceipt("managed-once")?.result?.outcome).toBe("requested");
  });
  it.each(["pending", "delivered", "in-flight answer", "handed-off answer", "in-flight submission"] as const)("dsh named cancellation fences %s through actual human and receiving-agent write owners", async mode => {
    const h = await nativeProcess("dsh"); h.f.people.entities.push(person("mike"), person("dana"));
    h.f.db.prepare("UPDATE nodes SET permissions_to=? WHERE id=?").run(PERSON, h.f.node.id);
    const asks = () => h.f.queueRepo.list({ limit: 100 }).filter(row => row.tags?.includes("runner-permission") && !row.handedOffFrom);
    const act = async (id: string, verb: string, actor = PERSON, extra: Record<string, unknown> = {}) => h.f.app.request("/api/mission-control/action", {
      method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": actor },
      body: JSON.stringify({ verb, qitemId: id, actorSession: actor, ...extra }) });
    const decide = async (id: string) => h.f.app.request(`/api/activity/permission-requests/${id}/decide`, { method: "POST",
      headers: { "content-type": "application/json", "X-OpenRig-Session": "lead@channel" }, body: JSON.stringify({ optionId: "allow", reason: "the person agreed" }) });
    const permissionReplies = () => h.entries().filter(entry => [1001, 1002].includes(entry.id as number) && !entry.method && entry.result);
    let releaseRead!: () => void, releaseCreate!: () => void;
    if (mode === "in-flight answer" || mode === "handed-off answer") {
      h.permissionReadGate = new Promise<void>(done => { releaseRead = done; }); cleanups.push(() => releaseRead());
    }
    if (mode === "in-flight submission") {
      const create = h.f.queueRepo.create.bind(h.f.queueRepo);
      const spy = vi.spyOn(h.f.queueRepo, "create").mockImplementationOnce(async input => {
        await new Promise<void>(done => { releaseCreate = done; }); return create(input);
      });
      cleanups.push(() => { releaseCreate?.(); spy.mockRestore(); });
    }
    h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "HOLD PERMISSION E", "permission-E", "sender");
    expect(await waitFor(() => asks().length === (mode === "in-flight submission" ? 1 : 2)), h.output).toBe(true);
    const target = h.f.channel.currentTurn(h.f.node.id)!; expect(target).toBeTruthy();
    const first = asks()[0]!;
    if (["delivered", "in-flight answer", "handed-off answer"].includes(mode)) {
      let answerId = first.qitemId, actor = PERSON;
      if (mode === "handed-off answer") {
        expect((await act(answerId, "handoff", PERSON, { destinationSession: "dana@external" })).status).toBe(200);
        const child = h.f.queueRepo.list({ limit: 100 }).find(row => row.handedOffFrom === answerId)!;
        expect(child).toBeTruthy(); answerId = child.qitemId; actor = "dana@external";
      }
      expect((await act(answerId, "answer", actor, { questionId: "permission", optionId: "allow" })).status).toBe(200);
      expect((await decide(first.qitemId)).status).toBe(200);
      if (mode === "delivered") expect(await waitFor(() => permissionReplies().length === 1), h.output).toBe(true);
      else expect(await waitFor(() => h.heldPermissionReads === 1), h.output).toBe(true);
    }
    await h.f.transport.sendNativeWake("dev@channel", "SLOW SAFE F", "permission-F", "sender");
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel", requestId: "cancel-permissions", target: { runId: target.runId, nativeTurnId: target.nativeTurnId } }) })).status).toBe(202);
    if (mode === "in-flight submission") {
      expect(await waitFor(() => h.f.outbox.runnerReceipt("cancel-permissions")?.withdrawal?.stage === "pending"), h.output).toBe(true);
      expect(h.entries().filter(entry => entry.method === "session/cancel")).toEqual([]);
      releaseCreate();
    }
    expect(await waitFor(() => h.f.outbox.runnerReceipt("cancel-permissions")?.result?.outcome === "cancelled"), h.output).toBe(true);
    expect(h.f.outbox.runnerReceipt("cancel-permissions")?.withdrawal?.stage).toBe("confirmed");
    releaseRead?.();
    // These are the same write owners as Steering and `seat decide-permission`, after E has been withdrawn.
    for (const ask of asks()) {
      await act(ask.qitemId, "answer", PERSON, { questionId: "permission", optionId: "allow" });
      const late = await decide(ask.qitemId);
      expect(await late.json()).toMatchObject({ state: "withdrawn" });
    }
    expect(await waitFor(() => h.f.outbox.runnerReceipt("permission-F")?.result?.completion === "completed"), h.output).toBe(true);
    const replies = permissionReplies(); expect(replies).toHaveLength(2);
    const selected = replies.filter(entry => (entry.result as { outcome: { outcome: string } }).outcome.outcome === "selected");
    expect(selected).toHaveLength(mode === "delivered" ? 1 : 0);
    const records = h.entries(), cancelIndex = records.findIndex(entry => entry.method === "session/cancel");
    expect(cancelIndex).toBeGreaterThan(0);
    for (const reply of replies) {
      const replyIndex = records.findIndex(entry => entry.id === reply.id && !entry.method && entry.result);
      expect(replyIndex).toBeGreaterThan(0); expect(replyIndex).toBeLessThan(cancelIndex);
    }
    expect(records.filter(entry => entry.method === "session/cancel")).toHaveLength(1);
    if (["delivered", "in-flight answer", "handed-off answer"].includes(mode)) {
      // Keep the person's action as audit evidence; native delivery is a separate fact.
      expect(h.f.db.prepare("SELECT actor_session FROM mission_control_actions WHERE action_verb='answer'").all()).toContainEqual({ actor_session: mode === "handed-off answer" ? "dana@external" : PERSON });
    }
  }, 30_000);

  it.each(["pi", "dsh"] as const)("%s process cancels exact E and releases queued F through actual Core routes", async kind => {
    const h = await nativeProcess(kind); h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "SLOW CANCEL E", "work-E", "sender");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target, h.output).toBeTruthy();
    await h.f.transport.sendNativeWake("dev@channel", "SLOW FOLLOW F", "work-F", "sender");
    const body = { type: "cancel", requestId: "cancel-E", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } };
    const post = () => h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post()).status).toBe(202);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("cancel-E")?.result?.outcome === "cancelled"), h.output).toBe(true);
    expect(await waitFor(() => { const current = h.f.channel.currentTurn(h.f.node.id); return current && current.nativeTurnId !== target!.nativeTurnId; }), h.output).toBeTruthy();
    expect(h.f.outbox.runnerReceipt("cancel-E")?.withdrawal?.stage).toBe("confirmed");
    expect((await post()).status).toBe(200);
    const cancelWrites = () => h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel");
    expect(cancelWrites()).toHaveLength(1);
    expect(h.prompts()).toEqual(["SLOW CANCEL E", "SLOW FOLLOW F"]);
    const late = await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, requestId: "late-E" }) });
    expect(late.status).toBe(200);
    expect(h.f.outbox.runnerReceipt("late-E")?.result?.outcome).toBe("not-this-turn");
    expect(cancelWrites()).toHaveLength(1);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("work-F")?.result?.completion === "completed"), h.output).toBe(true);
  });
  it.each(["pi", "dsh"] as const)("%s permanent cancel acknowledgement refusal never withdraws or aborts and does not strand person F", async kind => {
    const h = await nativeProcess(kind), child = h.start(); await h.ready(); child.stdin!.write("SLOW PERSON E\n");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    h.fault = { type: "ack", requestId: "refused-cancel", status: 409, commit: false, hits: 0 };
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel", requestId: "refused-cancel", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } }) })).status).toBe(202);
    expect(await waitFor(() => h.fault!.hits > 0)).toBe(true); child.stdin!.write("PERSON F\n");
    expect(await waitFor(() => h.prompts().includes("PERSON F")), h.output).toBe(true);
    expect(h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel")).toEqual([]);
    expect(h.f.outbox.runnerReceipt("refused-cancel")?.withdrawal).toBeUndefined();
    expect(h.f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.runner_turn_fenced'").get()).toEqual({ n: 0 });
  });
  it.each(["pi", "dsh"] as const)("%s permanent authority loss during withdrawal releases only pre-effect preparation", async kind => {
    const h = await nativeProcess(kind), child = h.start(); await h.ready(); child.stdin!.write("SLOW PERSON E\n");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    h.fault = { type: "cancel-prepare", requestId: "authority-lost", status: 503, commit: false, hits: 0 };
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel", requestId: "authority-lost", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } }) })).status).toBe(202);
    expect(await waitFor(() => h.fault!.hits > 0)).toBe(true); h.fault!.status = 401;
    expect(await waitFor(() => h.f.outbox.runnerReceipt("authority-lost")?.stage === "rejected"), h.output).toBe(true);
    child.stdin!.write("PERSON F\n");
    expect(await waitFor(() => h.prompts().includes("PERSON F")), h.output).toBe(true);
    expect(h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel")).toEqual([]);
    expect(h.f.outbox.runnerReceipt("authority-lost")?.withdrawal).toBeUndefined();
    expect(h.f.outbox.runnerReceipt("authority-lost")?.result).toMatchObject({ applied: false });
    expect(h.f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.runner_turn_fenced'").get()).toEqual({ n: 0 });
    expect(h.prompts().filter(text => text === "SLOW PERSON E")).toHaveLength(1);
  });
  it.each(["pi", "dsh"] as const)("%s reconnect retains lower unacked N after control N+1 overtakes it", async kind => {
    const h = await nativeProcess(kind); h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "HOLD E", "E", "sender");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    h.fault = { type: "ack", requestId: "older-N", commit: false, hits: 0 };
    await h.f.transport.sendNativeWake("dev@channel", "OLDER F", "older-N", "sender");
    expect(await waitFor(() => h.fault!.hits > 0)).toBe(true);
    const response = await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel", requestId: "newer-control", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } }) });
    expect(response.status).toBe(202);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("newer-control")?.result?.outcome === "cancelled"), h.output).toBe(true);
    const cursor = h.f.outbox.runnerReceipt("newer-control")!.sequence;
    expect(h.f.channel.frames(h.f.grant.token, cursor)[0]?.requestId).toBe("older-N");
    const hellos = h.hellos; h.server.closeAllConnections();
    expect(await waitFor(() => h.hellos > hellos)).toBe(true); h.fault = null;
    expect(await waitFor(() => h.f.outbox.runnerReceipt("older-N")?.result?.completion === "completed"), h.output).toBe(true);
    expect(h.prompts()).toEqual(["HOLD E", "OLDER F"]);
    expect(h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel")).toHaveLength(1);
  });
  it("busy Pi steers retain distinct accepted IDs inside the cancelled E invocation", async () => {
    const h = await nativeProcess("pi"), child = h.start(); await h.ready(); child.stdin!.write("SLOW PERSON E\n");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    await h.f.transport.send("dev@channel", "BUSY STEER", { deliveryId: "steer-E", actorSession: "sender" });
    expect(await waitFor(() => h.f.outbox.runnerReceipt("steer-E")?.stage === "completed"), h.output).toBe(true);
    expect(h.f.outbox.runnerReceipt("steer-E")).toMatchObject({ nativeTurnId: target!.nativeTurnId, acceptedTurnId: "2" });
    await h.f.transport.sendNativeWake("dev@channel", "AFTER E", "after-E", "sender");
    const response = await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel", requestId: "cancel-steered", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } }) });
    expect(response.status).toBe(202);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("cancel-steered")?.result?.outcome === "cancelled"), h.output).toBe(true);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("after-E")?.result?.completion === "completed"), h.output).toBe(true);
    expect(h.entries().some(entry => (entry.native as { type?: string; aborted?: boolean } | undefined)?.type === "agent_settled" && (entry.native as { aborted?: boolean }).aborted === true)).toBe(true);
    expect(h.entries().filter(entry => entry.type === "abort")).toHaveLength(1);
  });
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

  it.each((["pi", "dsh"] as const).flatMap(kind => (["cancel-prepare", "submitted", "result"] as const).flatMap(type => [false, true].map(commit => [kind, type, commit] as const))))
    ("%s reconciles cancel %s response loss (commit=%s) without repeating native effect", async (kind, type, commit) => {
    const h = await nativeProcess(kind); h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "HOLD CANCEL E", "fault-E", "sender");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    await h.f.transport.sendNativeWake("dev@channel", "FAULT F", "fault-F", "sender");
    h.fault = { type, requestId: "fault-cancel", commit, hits: 0 };
    const body = { type: "cancel", requestId: "fault-cancel", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } };
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(202);
    expect(await waitFor(() => h.fault!.hits > 0)).toBe(true);
    const cancelWrites = () => h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel");
    if (type === "cancel-prepare") {
      expect(await waitFor(() => h.f.outbox.runnerReceipt("fault-cancel")?.stage === "rejected"), h.output).toBe(true);
      expect(cancelWrites()).toEqual([]); expect(h.f.outbox.runnerReceipt("fault-cancel")?.result).toMatchObject({ applied: false });
      h.fault = null; h.server.closeAllConnections();
      expect(await waitFor(() => h.f.outbox.runnerReceipt("fault-F")?.result?.completion === "completed"), h.output).toBe(true);
      expect(cancelWrites()).toEqual([]); expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
      return;
    }
    else {
      expect(cancelWrites()).toHaveLength(1);
      expect(await waitFor(() => h.entries().some(entry => { const frame = entry.native as { type?: string; result?: { stopReason?: string } } | undefined; return kind === "pi" ? frame?.type === "agent_end" : frame?.result?.stopReason === "cancelled"; }))).toBe(true);
      if (type === "submitted") expect(h.f.outbox.runnerReceipt("fault-cancel")?.result?.outcome).toBe(commit ? "requested" : undefined);
      else expect(h.f.outbox.runnerReceipt("fault-cancel")?.result?.outcome).toBe(commit ? "cancelled" : "requested");
    }
    const hellos = h.hellos;
    if (type === "submitted" && !commit) await h.reopen(); else h.server.closeAllConnections();
    expect(await waitFor(() => h.hellos > hellos)).toBe(true); h.fault = null;
    expect(await waitFor(() => h.f.outbox.runnerReceipt("fault-cancel")?.stage === "completed" && h.f.outbox.runnerReceipt("fault-cancel")?.result?.outcome === "cancelled"), h.output).toBe(true);
    expect(await waitFor(() => h.f.outbox.runnerReceipt("fault-F")?.result?.completion === "completed"), h.output).toBe(true);
    expect(cancelWrites()).toHaveLength(1); expect(h.prompts()).toEqual(["HOLD CANCEL E", "FAULT F"]);
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
    expect(cancelWrites()).toHaveLength(1);
  });
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

  it.each(["pi", "dsh"] as const)("%s loses accepted cancellation map honestly and never replays E into a new receiver/run", async kind => {
    const h = await nativeProcess(kind), receiver = h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "HOLD LOST E", "lost-E", "sender");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    await h.f.transport.sendNativeWake("dev@channel", "NEVER REPLAY F", "lost-F", "sender");
    let prepared = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(() => release());
    h.cancelPrepareGate = () => { prepared = true; return gate; };
    const command = { type: "cancel", requestId: "lost-cancel", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } };
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) })).status).toBe(202);
    expect(await waitFor(() => prepared)).toBe(true); receiver.kill("SIGKILL"); await new Promise(resolve => receiver.once("exit", resolve));
    release(); h.cancelPrepareGate = null; const hellos = h.hellos; const replacement = h.start();
    expect(await waitFor(() => h.hellos > hellos && h.f.outbox.runnerReceipt("lost-cancel")?.reconciliation === "receiver_state_lost")).toBe(true);
    expect(h.f.outbox.runnerReceipt("lost-cancel")?.result).toBeUndefined();
    expect(h.f.channel.currentTurn(h.f.node.id)).toBeNull();
    expect(h.f.channel.frames(h.f.grant.token, 0)).toEqual([]);
    expect(h.prompts()).toEqual(["HOLD LOST E"]);
    const old = h.f.grant;
    const next = h.f.grants.issue({ nodeId: h.f.node.id, generation: old.generation, issuedBy: "replacement", run: { runId: "next-run", binding: old.binding! } });
    expect(h.f.grants.activate(next.grantId)).toBe(true);
    expect(() => h.f.channel.post(old.token, { type: "result", runId: old.runId, requestId: "lost-cancel", sequence: h.f.outbox.runnerReceipt("lost-cancel")!.sequence, result: { kind: "cancel", outcome: "cancelled", confirmed: true } })).toThrow(/revoked/);
    replacement.kill("SIGKILL"); await new Promise(resolve => replacement.once("exit", resolve));
    await h.reopen(next); h.start(); await h.ready();
    expect(h.f.channel.currentTurn(h.f.node.id)).toBeNull();
    await h.f.transport.sendNativeWake("dev@channel", "NEW RUN F", "new-F", "sender");
    expect(await waitFor(() => h.f.outbox.runnerReceipt("new-F")?.result?.completion === "completed"), h.output).toBe(true);
    const late = await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...command, requestId: "old-target-new-run" }) });
    expect(late.status).toBe(200); expect(h.f.outbox.runnerReceipt("old-target-new-run")?.result?.outcome).toBe("not-this-turn");
    expect(h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel")).toEqual([]);
    expect(h.prompts()).toEqual(["HOLD LOST E", "NEW RUN F"]);
  });
  it.each(["pi", "dsh"] as const)("%s erased cancellation survives Core reopen without reopening E or accepting a late result", async kind => {
    const h = await nativeProcess(kind); h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", "HOLD ERASE E", "erase-E", "sender");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    h.fault = { type: "result", requestId: "erase-cancel", commit: true, hits: 0 };
    const body = { type: "cancel", requestId: "erase-cancel", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } };
    await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await waitFor(() => h.f.outbox.runnerReceipt("erase-cancel")?.result?.outcome === "cancelled")).toBe(true);
    const original = h.f.outbox.runnerReceipt("erase-cancel")!; h.f.outbox.eraseRunner(original.requestId, new Date().toISOString());
    await h.reopen(); h.fault = null; await h.ready();
    expect(h.f.outbox.runnerReceipt(original.requestId)).toMatchObject({ erasedAt: expect.any(String), bindingHash: original.bindingHash, payload: { target: body.target }, withdrawal: { stage: "confirmed" }, result: { outcome: "cancelled" } });
    expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(409);
    expect(() => h.f.channel.post(h.f.grant.token, { type: "result", runId: h.f.grant.runId, requestId: original.requestId, sequence: original.sequence, result: { kind: "cancel", outcome: "cancelled", confirmed: true, detail: "ERASED PRIVATE DATA" } })).toThrow(/erased/);
    expect(() => h.f.channel.prepareCancellation(h.f.grant.token, { runId: h.f.grant.runId, requestId: original.requestId, sequence: original.sequence }, () => { throw new Error("must never reopen"); })).toThrow();
    expect(JSON.stringify(h.f.outbox.runnerReceipt(original.requestId))).not.toContain("ERASED PRIVATE DATA");
    expect(h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel")).toHaveLength(1);
    expect(h.f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.runner_turn_fenced'").get()).toEqual({ n: 1 });
  });
  it.each((["pi", "dsh"] as const).flatMap(kind => ["IGNORE", "EXIT"].map(outcome => [kind, outcome] as const)))
    ("%s native %s after cancel submission never fabricates cancelled", async (kind, outcome) => {
    const h = await nativeProcess(kind); h.start(); await h.ready();
    await h.f.transport.sendNativeWake("dev@channel", `SLOW ${outcome} CANCEL E`, "uncertain-E", "sender");
    const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
    await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "cancel", requestId: "uncertain-cancel", target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } }) });
    expect(await waitFor(() => h.f.outbox.runnerReceipt("uncertain-cancel")?.result?.outcome === "requested"), h.output).toBe(true);
    if (outcome === "IGNORE") {
      expect(await waitFor(() => h.f.outbox.runnerReceipt("uncertain-cancel")?.stage === "completed"), h.output).toBe(true);
      expect(await waitFor(() => h.f.outbox.runnerReceipt("uncertain-E")?.result?.completion === "completed"), h.output).toBe(true);
    } else await sleep(300);
    expect(h.f.outbox.runnerReceipt("uncertain-cancel")?.result).toMatchObject({ outcome: "requested", confirmed: false });
    expect(h.entries().filter(entry => kind === "pi" ? entry.type === "abort" : entry.method === "session/cancel")).toHaveLength(1);
  });
  it.runIf(process.env["OPENRIG_NATIVE_PROGRAM_PROOF"] === "1").each(["pi", "dsh"] as const)("installed %s program qualifies input, wake and named cancellation through Core with a local fake provider", async kind => {
    const executable = process.env[kind === "pi" ? "OPENRIG_NATIVE_PI_BIN" : "OPENRIG_NATIVE_DSH_BIN"];
    expect(executable, "Set an explicit isolated native program path for opt-in proof").toBeTruthy();
    const requests: Array<{ text: string; model: string; history: string }> = [];
    const held = new Map<string, () => void>();
    const provider = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/messages")) return new Response(null, { status: 404 });
      const body = await request.json() as { model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
      const content = body.messages.filter(message => message.role === "user").at(-1)?.content;
      const raw = typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text ?? "").join("\n") ?? "";
      // dsh may merge historical E and fresh F into one user message: choose the last owned marker.
      const marker = [...raw.matchAll(/NATIVE_(?:CANCEL|BUSY)_(?:E|F|STEER)/g)].at(-1)?.[0];
      const text = marker ?? (typeof content === "string" ? content : content?.find(part => part.type === "text")?.text ?? "");
      const history = body.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n");
      requests.push({ text, model: body.model, history });
      const answer = `native-answer: ${text}`;
      const frames = [
        { type: "message_start", message: { id: `offline-${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }, { type: "message_stop" },
      ];
      if (marker && !marker.endsWith("STEER")) {
        const encoder = new TextEncoder(), encode = (frame: { type: string }) => encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          for (const frame of frames.slice(0, 2)) controller.enqueue(encode(frame));
          held.set(marker, () => { for (const frame of frames.slice(2)) controller.enqueue(encode(frame)); controller.close(); held.delete(marker); });
        }, cancel() { held.delete(marker); } }), { headers: { "content-type": "text/event-stream" } });
      }
      await sleep(text.includes("SLOW:native") ? 700 : 30);
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    await new Promise<void>(done => provider.once("listening", done)); cleanups.push(() => { provider.closeAllConnections(); provider.close(); });
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const h = await nativeProcess(kind, { bin: executable!, providerUrl });
    const version = execFileSync(executable!, ["--version"], { encoding: "utf8", timeout: 10000, env: { PATH: process.env["PATH"], HOME: h.dir, DSH_HOME: join(h.dir, "dsh"), XDG_CONFIG_HOME: join(h.dir, "config"), XDG_DATA_HOME: join(h.dir, "data"), XDG_CACHE_HOME: join(h.dir, "cache"), DSH_TELEMETRY_DISABLED: "1" } }).trim();
    const runner = h.start(); await h.ready();
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
    const nativeFrames = () => h.entries().flatMap(entry => entry.native ? [entry.native as Record<string, unknown>] : []);
    for (const busy of kind === "pi" ? [false, true] : [false]) {
      const nativeStart = nativeFrames().length;
      const label = busy ? "BUSY" : "CANCEL", e = `NATIVE_${label}_E`, f = `NATIVE_${label}_F`, cancelId = `cancel-native-${label}`;
      if (busy) await h.f.transport.send("dev@channel", e, { deliveryId: `E-${label}`, actorSession: "sender" });
      else await h.f.transport.sendNativeWake("dev@channel", e, `E-${label}`, "sender");
      expect(await waitFor(() => held.has(e), 12000), h.output).toBe(true);
      const target = await waitFor(() => h.f.channel.currentTurn(h.f.node.id)); expect(target).toBeTruthy();
      if (busy) {
        await h.f.transport.send("dev@channel", "NATIVE_BUSY_STEER", { deliveryId: "native-owned-steer", actorSession: "sender" });
        expect(await waitFor(() => nativeFrames().some(frame => frame.type === "queue_update" && (frame.steering as string[] | undefined)?.includes("NATIVE_BUSY_STEER"))), h.output).toBe(true);
        expect(h.f.outbox.runnerReceipt("native-owned-steer")?.nativeTurnId).toBe(target!.nativeTurnId);
      }
      await h.f.transport.sendNativeWake("dev@channel", f, `F-${label}`, "sender");
      const command = { type: "cancel", requestId: cancelId, target: { runId: target!.runId, nativeTurnId: target!.nativeTurnId } };
      if (!busy) h.fault = { type: "result", requestId: cancelId, commit: true, hits: 0 };
      expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) })).status).toBe(202);
      expect(await waitFor(() => h.f.outbox.runnerReceipt(cancelId)?.stage === "completed", 12000), h.output).toBe(true);
      const cancellationReceipt = h.f.outbox.runnerReceipt(cancelId)!;
      expect(cancellationReceipt.result).toMatchObject(kind === "pi" && busy
        ? { outcome: "requested", confirmed: false, operationAccepted: false, detail: "native_end_without_cancellation_proof" }
        : { outcome: "cancelled", confirmed: true });
      if (busy) {
        // Native cancellation releases its hold, but the dedicated wake still requires an idle, empty native queue.
        expect(await waitFor(() => nativeFrames().slice(nativeStart).some(frame => String(frame.id).startsWith("openrig-native-idle-")
          && (frame.data as { isStreaming?: boolean; pendingMessageCount?: number } | undefined)?.isStreaming === false
          && (frame.data as { pendingMessageCount?: number } | undefined)?.pendingMessageCount === 1)), h.output).toBe(true);
        expect(nativeFrames().slice(nativeStart).filter(frame => frame.type === "queue_update").at(-1)).toMatchObject({ steering: ["NATIVE_BUSY_STEER"], followUp: [] });
        expect(held.has(f)).toBe(false); expect(requests.filter(request => request.text === "NATIVE_BUSY_STEER")).toEqual([]);
        // Explicit person continuation is a disclosed native-queue limitation, not automatic successor progress.
        runner.stdin!.write("person continues retained work\n");
        expect(await waitFor(() => requests.filter(request => request.text === "NATIVE_BUSY_STEER").length === 1, 12000), h.output).toBe(true);
      }
      expect(await waitFor(() => held.has(f), 12000), h.output).toBe(true);
      if (!busy) { const hello = h.hellos; h.server.closeAllConnections(); expect(await waitFor(() => h.hellos > hello)).toBe(true); h.fault = null; }
      const calls = () => h.entries().filter(frame => kind === "pi" ? frame.type === "abort" && frame.id === `openrig-cancel-${cancelId}` : frame.method === "session/cancel");
      const before = calls().length; expect(before).toBe(1);
      expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) })).status).toBe(200);
      expect((await h.f.app.request("/api/seat/command/dev@channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...command, requestId: `late-${cancelId}` }) })).status).toBe(200);
      expect(h.f.outbox.runnerReceipt(`late-${cancelId}`)?.result?.outcome).toBe("not-this-turn"); expect(calls()).toHaveLength(before);
      const entries = h.entries();
      const promptText = (frame: Record<string, unknown>) => kind === "pi" ? frame.message : ((frame.params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt ?? []).map(part => part.text ?? "").join("");
      expect(entries.filter(frame => promptText(frame) === e)).toHaveLength(1); expect(entries.filter(frame => promptText(frame) === f)).toHaveLength(1);
      const fIndex = entries.findIndex(frame => promptText(frame) === f);
      if (kind === "pi") {
        const ackIndex = entries.findIndex(frame => (frame.native as { type?: string; id?: string; success?: boolean } | undefined)?.type === "response" && (frame.native as { id?: string; success?: boolean }).id === `openrig-cancel-${cancelId}` && (frame.native as { success?: boolean }).success === true);
        expect(ackIndex).toBeGreaterThan(-1);
        const eIndex = entries.findIndex(frame => promptText(frame) === e);
        const aborted = entries.findIndex((frame, index) => index > eIndex && (frame.native as { message?: { stopReason?: string } } | undefined)?.message?.stopReason === "aborted");
        const ended = entries.findIndex((frame, index) => index > aborted && (frame.native as { type?: string } | undefined)?.type === "agent_end");
        expect(aborted).toBeGreaterThan(eIndex); expect(ended).toBeGreaterThan(aborted); expect(fIndex).toBeGreaterThan(ended);
        const settled = entries.findIndex((frame, index) => index > ended && (frame.native as { type?: string; aborted?: boolean } | undefined)?.type === "agent_settled" && (frame.native as { aborted?: boolean }).aborted === true);
        expect(settled).toBeGreaterThan(ended); expect(fIndex).toBeGreaterThan(settled);
        expect(ackIndex).toBeGreaterThan(ended);
        expect(entries.filter(frame => frame.type === "clear_queue")).toEqual([]);
        expect(entries.filter(frame => frame.type === "get_state" && frame.id === `openrig-cancel-state-${cancelId}`)).toEqual([]);
      } else {
        const ePrompt = entries.find(frame => promptText(frame) === e)!;
        const terminal = entries.findIndex(frame => (frame.native as { id?: unknown; result?: { stopReason?: string } } | undefined)?.id === ePrompt.id && (frame.native as { result?: { stopReason?: string } }).result?.stopReason === "cancelled");
        expect(terminal).toBeGreaterThan(-1); expect(fIndex).toBeGreaterThan(terminal);
      }
      held.get(f)!();
      expect(await waitFor(() => h.f.outbox.runnerReceipt(`F-${label}`)?.result?.completion === "completed", 12000), h.output).toBe(true);
      expect(h.f.outbox.runnerReceipt(`F-${label}`)?.result?.answer).toBe(`native-answer: ${f}`);
      if (kind === "dsh") {
        const fPrompt = h.entries().find(frame => promptText(frame) === f)!;
        expect(nativeFrames().find(frame => frame.id === fPrompt.id && (frame.result as { stopReason?: string } | undefined)?.stopReason === "end_turn")).toBeTruthy();
      }
      if (busy) {
        expect(requests.filter(request => request.text === "NATIVE_BUSY_STEER")).toHaveLength(1);
        expect(requests.find(request => request.text === f)?.history).toContain("NATIVE_BUSY_STEER");
      }
    }
    console.log(JSON.stringify({ nativeProgram: kind, version, executable, provider: "local fake Anthropic messages; no external network", prompts: requests.map(request => request.text) }));
  }, 60000);

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

  it("committed run replacement settles old native custody without replay", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    f.admit("accepted"); f.channel.frames(f.grant.token, 0);
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: "accepted", sequence: 1, state: "accepted" });
    f.admit("pending");
    const wake = f.channel.admit(f.node.id, { outboxId: "unanswered", senderSession: "sender", destinationSession: "dev@channel", body: "why", kind: "wake", inputRoute: "native", payload: { question: "why" } });
    f.outbox.updateRunner(f.node.id, "run-one", wake.requestId, wake.sequence, "offered");
    f.outbox.updateRunner(f.node.id, "run-one", wake.requestId, wake.sequence, "accepted");
    f.outbox.updateRunner(f.node.id, "run-one", wake.requestId, wake.sequence, "submitted");
    for (const id of ["offered", "submitted-input", "completed", "rejected", "erased"]) {
      const r = f.admit(id);
      f.outbox.updateRunner(f.node.id, "run-one", id, r.sequence, "offered");
      if (id !== "offered") {
        f.outbox.updateRunner(f.node.id, "run-one", id, r.sequence, "accepted");
        if (id !== "rejected") f.outbox.updateRunner(f.node.id, "run-one", id, r.sequence, "submitted");
        if (id === "completed" || id === "rejected") f.outbox.updateRunner(f.node.id, "run-one", id, r.sequence, id, { result: { kind: "input", accepted: id === "completed" } });
        if (id === "erased") f.outbox.eraseRunner(id, "2026-11-16T00:00:00.000Z");
      }
    }
    const preserved = ["submitted-input", "completed", "rejected", "erased"].map(id => ({ id, row: f.outbox.getById(id), receipt: f.outbox.runnerReceipt(id) }));
    // A same-run credential refresh and a runner death do not by themselves lose custody.
    const refresh = f.grants.issue({ nodeId: f.node.id, generation: f.grant.generation, issuedBy: "refresh", run: { runId: "run-one", binding: f.grant.binding! } });
    expect(f.grants.activate(refresh.grantId)).toBe(true);
    expect(f.outbox.runnerReceipt("accepted")?.reconciliation).toBeUndefined();
    f.grants.revoke({ grantId: refresh.grantId }, "runner died");
    const next = f.grants.issue({ nodeId: f.node.id, generation: f.grant.generation, issuedBy: "replacement", run: { runId: "run-two", binding: f.grant.binding! } });
    expect(f.outbox.getById("pending")?.deliveryState).toBe("sending");
    expect(f.grants.activate(next.grantId)).toBe(true);
    expect(f.channel.post(next.token, { ...f.hello, runId: "run-two" })).toMatchObject({ receipts: [] });
    for (const id of ["accepted", "unanswered", "offered"]) {
      expect(f.outbox.runnerReceipt(id)?.reconciliation).toBe("receiver_state_lost");
      expect(f.outbox.getById(id)?.deliveryState).toBe("indeterminate");
    }
    expect(f.outbox.getById("pending")?.deliveryState).toBe("failed");
    expect(f.outbox.runnerReceipt("pending")).toMatchObject({ stage: "rejected", result: { error: "not offered: its run ended" } });
    for (const item of preserved) {
      expect(f.outbox.runnerReceipt(item.id)).toEqual(item.receipt);
      expect(f.outbox.getById(item.id)).toEqual(item.row);
    }
    expect(f.channel.frames(next.token, 0)).toEqual([]);
    cleanups.push(f.channel.connect(next.token));
    expect(f.channel.admit(f.node.id, { outboxId: "fresh", senderSession: "sender", destinationSession: "dev@channel", body: "new", kind: "input", inputRoute: "native", payload: { text: "new" } })).toMatchObject({ runId: "run-two", sequence: 1 });
  });
  it.each([false, true])("held native wake identity cannot become ordinary input (held=%s)", async held => {
    const f = await fixture(); f.db.prepare("UPDATE nodes SET input_route='native' WHERE id=?").run(f.node.id);
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    await f.guard.set(f.node.id, { mode: "hold" }, "person", "hold");
    expect(await f.transport.sendNativeWake("dev@channel", "why", "held-wake", "sender")).toMatchObject({ outcome: "retained" });
    if (!held) await f.guard.set(f.node.id, { mode: "off" }, "person", "release");
    expect(await f.transport.send("dev@channel", "why", { deliveryId: "held-wake", actorSession: "sender" })).toMatchObject({ ok: false, reason: "delivery_identity_conflict" });
    expect(f.outbox.runnerReceipt("held-wake")).toBeNull();
    expect(f.outbox.getById("held-wake")?.deliveryState).toBe("retained");
    await f.guard.set(f.node.id, { mode: "off" }, "person", "release");
    expect(await f.transport.sendNativeWake("dev@channel", "why", "held-wake", "sender")).toMatchObject({ runnerReceipt: { kind: "wake" } });
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
  it("seat route choice persists without a live capability, and wake submission/lookup use that exact request", async () => {
    const f = await fixture();
    const post = (path: string, body: unknown) => f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/seat/set-input-route/dev%40channel", { route: "native", reason: "native" })).status).toBe(200);
    expect(f.channel.capable(f.node.id, "input")).toBe(false);
    expect(await (await post("/api/seat/set-input-route/dev%40channel", { route: "native", reason: "native" })).json()).toMatchObject({ inputRoute: "native", nativeInput: { input: false, wake: false, cancel: false } });
    expect((await post("/api/seat/command/dev%40channel", { type: "wake", requestId: "unavailable", question: "why" })).status).toBe(409);
    expect(f.outbox.runnerReceipt("unavailable")).toBeNull();
    f.db.prepare("UPDATE nodes SET input_route='typed' WHERE id=?").run(f.node.id);
    f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    expect((await post("/api/seat/command/dev%40channel", { type: "wake", requestId: "question", question: "why" })).status).toBe(409);
    expect(await (await post("/api/seat/set-input-route/dev%40channel", { route: "native", reason: "native" })).json())
      .toMatchObject({ inputRoute: "native", nativeInput: { input: true, wake: true, cancel: true } });
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
    const readFrame = async () => {
      let text = "";
      while (!text.includes("\n\n")) text += new TextDecoder().decode((await read()).value);
      return text;
    };
    expect(await readFrame()).toContain('"requestId":"one"');
    f.channel.post(f.grant.token, { type: "ack", runId: "run-one", requestId: "one", sequence: 1, state: "accepted" });
    expect(await readFrame()).toContain('"requestId":"two"');
    f.grants.revoke({ grantId: f.grant.grantId }, "stopped");
    expect((await read()).done).toBe(true);
  });
  it("the SSE route sizes a complete composed receipt and reoffers its unchanged custody after a lost ack", async () => {
    const f = await fixture(); f.channel.post(f.grant.token, f.hello); cleanups.push(f.channel.connect(f.grant.token));
    const bodies = ["\0".repeat(1024 * 1024), "\0".repeat(1024 * 1024)];
    const memberIds = ["large-member-one", "large-member-two"];
    for (const [i, id] of memberIds.entries()) f.outbox.record({ outboxId: id, senderSession: "system", destinationSession: "dev@channel", body: bodies[i]! });
    const payload = { question: bodies.join("\n") };
    const receipt = f.channel.admit(f.node.id, { outboxId: memberIds[0]!, senderSession: "system", destinationSession: "dev@channel", body: bodies[0]!, kind: "wake", inputRoute: "native", payload, memberIds });
    const readOffer = async (cursor: number) => {
      const response = await f.app.request("/api/activity/runner-channel", { headers: { authorization: `Bearer ${f.grant.token}`, "Last-Event-ID": String(cursor) } });
      const reader = response.body!.getReader(); cleanups.push(() => reader.cancel());
      let text = "";
      const decoder = new TextDecoder();
      while (!text.includes("\n\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("offer missing"); text += decoder.decode(chunk.value, { stream: true }); }
      await reader.cancel();
      const data = text.split("\n").find(line => line.startsWith("data: "))!.slice(6);
      expect(data.length).toBeGreaterThan(12 * 1024 * 1024);
      expect(text.split("\n")[0]).toBe(`: runner-frame-chars=${data.length}`);
      return JSON.parse(data);
    };
    const offered = await readOffer(0);
    expect(offered).toMatchObject({ ...receipt, stage: "offered", memberIds, payload });
    expect(await readOffer(receipt.sequence)).toEqual(offered);
    expect(f.outbox.runnerReceipts(f.node.id, "run-one")).toHaveLength(1);
    for (const [i, id] of memberIds.entries()) expect(f.outbox.getById(id)?.body).toBe(bodies[i]);
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
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: true, wake: runner !== 2, cancel: runner !== 2 } });
  });
  it("raw builtins do not become managed native runners by sharing runner code zero", async () => {
    const { runnerChannelKind } = await import("../src/domain/runner-channel.js");
    expect(runnerChannelKind({ runtime: "terminal", runner: 0, pane: "%1", panePid: 1 })).toBeNull();
    expect(runnerChannelKind({ runtime: "claude-code", runner: 0, pane: "%1", panePid: 1 })).toBeNull();
  });
  it("intersects a recorded runner kind/version and explicit declaration without a community app-name whitelist", async () => {
    const f = await fixture(true, "community-future", 1);
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: true, wake: true, cancel: true } });
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
    const recovered = new RunnerChannel(f.grants, new OutboxHandler(f.db), new Set(["managed-pi"]));
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
log({childToken:!!process.env.OPENRIG_ACTIVITY_HOOK_TOKEN,childPid:process.pid});
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
    expect(entries()).toContainEqual(expect.objectContaining({ childToken: false }));
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
  it.each([["pi", 0, true], ["omp", 0, false], ["arbitrary-preset", 1, true], ["arbitrary-rpc", 2, false]] as const)("production channel intersects implemented families for %s/%i (invocation mapping=%s)", async (runtime, runner, enabled) => {
    const { RunnerChannel } = await import("../src/domain/runner-channel.js");
    const f = await fixture(true, runtime, runner);
    const production = new RunnerChannel(f.grants, f.outbox);
    expect(production.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: true, wake: enabled, cancel: enabled } });
    expect(f.db.prepare("SELECT input_route FROM nodes WHERE id=?").get(f.node.id)).toEqual({ input_route: "typed" });
  });
  it("an explicitly disabled implementation never grants native input or cancellation", async () => {
    const f = await fixture(false);
    expect(f.channel.post(f.grant.token, f.hello)).toMatchObject({ capabilities: { input: false, wake: false, cancel: false } });
    expect(() => f.admit("one")).toThrow(/capable/);
    const live = await fixture();
    expect(live.channel.post(live.grant.token, live.hello)).toMatchObject({ capabilities: { input: true, wake: true, cancel: true } });
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
    const restarted = new RunnerChannel(new ActivityGrantStore(f.db), new OutboxHandler(f.db), new Set(["managed-pi"]));
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
