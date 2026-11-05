// The runner conformance check's test double and fake agent against OpenRig's real activity and answered permission
// routes, served over HTTP, instead of the check's stand-in: so the wire the check accepts is the wire OpenRig speaks.
// A person's click reaches the agent, OpenRig's permit is delivered, the seat's opt-in refusal is held, and an earlier
// occupant's request is cancelled, never asked. No model, tmux or Slack is involved.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
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
  const opened = await waitFor(() => existsSync(record) && JSON.parse(readFileSync(record, "utf8")).nativeRef);
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
  }, 30_000);

  it("OpenRig's permit, with no one to ask, is delivered at once and opens no ask", async () => {
    const d = await daemon({ people: [] });
    const r = await launchRunner(d);
    r.send("edit the notes");
    const got = await waitFor(() => r.answers()[0]);
    expect(got?.msg.result?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(d.asks()).toEqual([]);
    expect(await waitFor(() => r.turnEnded())).toBe(true);
    expect(d.waitsOnPerson()).toBe(false);
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);
});
