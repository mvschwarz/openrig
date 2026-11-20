// A permission or elicitation request newer than a fresh Stop/running/idle hook stops that hook from narrowing the
// current-prompt read: the screen decides, a dialog it positively reads holds the send, and nothing else is refused.
// Native events go through the real relay, the activity ingress and the store; the sends through the real transport and
// queue. The tmux adapter is a fixture whose writes are spies. Schema-based synthetic Claude payloads, no live dialog.
import { createRequire } from "node:module";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { activityRoutes } from "../src/routes/activity.js";
import { createFullTestDb } from "./helpers/test-app.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (input: object, env: object, now: () => Date) => Record<string, unknown> | null;
};
const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });

// An agent's open AskUserQuestion whose first option publishes: the screen the dialogue-only read lets through.
const AUTHORIZE_PROMPT = [
  "Authorize the 0.4.0 release?",
  "",
  "❯ 1. Authorize publish → @latest (Recommended)",
  "  2. Roll back",
  "  3. Hold",
].join("\n");
const COMPOSER = [
  "⏺ Done.",
  "",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ accept edits on (shift+tab to cycle)",
].join("\n");
const ASK = { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "Authorize the 0.4.0 release?", header: "Release",
    options: [{ label: "Authorize publish", description: "SYNTHETIC" }, { label: "Hold", description: "SYNTHETIC" }],
    multiSelect: false }] } };
const ELICIT = { hook_event_name: "Elicitation", mcp_server_name: "fixture-server", message: "Please provide your credentials",
  mode: "form", requested_schema: { type: "object", properties: { username: { type: "string", title: "Username" } } } };
const elicitResult = (action: string) => ({ hook_event_name: "ElicitationResult", mcp_server_name: "fixture-server", action,
  mode: "form", ...(action === "accept" ? { content: { username: "SYNTHETIC_SECRET" } } : {}) });

function fixture() {
  const db = createFullTestDb();
  databases.push(db);
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("team");
  const node = rigRepo.addNode(rig.id, "driver", { role: "worker", runtime: "claude-code" });
  const registry = new SessionRegistry(db);
  const sessionName = "driver@team";
  const session = registry.registerSession(node.id, sessionName);
  registry.updateStatus(session.id, "running");
  registry.updateBinding(node.id, { tmuxSession: sessionName });
  let time = Date.parse("2026-11-20T01:00:00.000Z");
  const now = () => new Date(time);
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now,
    resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, gen) => registry.isOccupantGenerationRegistered(id, gen) });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, now, defaultWindowSeconds: 3 });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("rigRepo" as never, rigRepo as never);
    c.set("seatActivityService" as never, oracle as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    await next();
  });
  app.route("/activity", activityRoutes);
  const env = () => ({ OPENRIG_SESSION_NAME: sessionName, OPENRIG_NODE_ID: node.id, OPENRIG_RUNTIME: "claude-code",
    OPENRIG_OCCUPANT_GENERATION: registry.currentOccupantTenure(node.id)!.generationUuid });
  /** A native Claude hook input, through the shipped relay and the activity ingress, one second after the last. */
  const hook = async (native: object, overrides: Record<string, unknown> = {}) => {
    time += 1000;
    const wire = { ...relay.buildOpenRigPayload(native, env(), now), ...overrides };
    const response = await app.request("/activity/hooks", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-token" }, body: JSON.stringify(wire) });
    expect(response.status).toBe(200);
    return wire;
  };
  const screen = { text: AUTHORIZE_PROMPT as string | null };
  const sendText = vi.fn(async () => ({ ok: true as const }));
  const sendKeys = vi.fn(async () => ({ ok: true as const }));
  const tmux = {
    hasSession: async () => true,
    probeSession: async () => ({ state: "present" as const }),
    sendText, sendKeys,
    capturePaneContent: async () => screen.text,
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null, getPaneCommand: async () => null,
  } as unknown as TmuxAdapter;
  const transport = new SessionTransport({ db, rigRepo, sessionRegistry: registry, tmuxAdapter: tmux,
    agentActivityStore: store, eventBus: new EventBus(db), now, sleep: async () => {} });
  const send = async () => { time += 1000; return transport.send(sessionName, "STAND DOWN, do not ship"); };
  const wrote = () => sendText.mock.calls.length + sendKeys.mock.calls.length;
  return { db, node, registry, store, sessionName, screen, transport, hook, send, wrote, sendText, now,
    tick: (ms: number) => { time += ms; } };
}

describe("a newer permission or elicitation request ends a fresh hook's narrowed read", () => {
  it("a request after a fresh Stop, with its dialog drawn: refused before any write", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK);
    const result = await f.send();
    expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.wrote()).toBe(0);
  });

  it("control (unchanged): the same screen after a fresh Stop and no request still delivers", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    const result = await f.send();
    expect(result.ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
  });

  it("a request after a fresh running hook, with its dialog drawn: refused before any write", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "UserPromptSubmit", prompt: "SYNTHETIC" });
    await f.hook(ASK);
    expect(await f.send()).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.wrote()).toBe(0);
  });

  it("a later tool batch from the same session settles the request: the fresh Stop's reading stands again", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK);
    await f.hook({ hook_event_name: "PostToolBatch", tool_calls: [] });
    expect((await f.send()).ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
  });

  it("a request decided with no dialog shown (an ordinary composer on screen) delivers", async () => {
    const f = fixture();
    f.screen.text = COMPOSER;
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK);
    expect((await f.send()).ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
  });

  it("an unreadable pane isn't a refusal: the fresh Stop's reading stands", async () => {
    const f = fixture();
    f.screen.text = null;
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK);
    const result = await f.send();
    expect(result.reason).not.toBe("target_needs_input");
  });

  it("a subagent's request isn't tied to the main pane: the fresh Stop's reading stands", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook({ ...ASK, agent_id: "subagent-1" });
    expect((await f.send()).ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
  });

  it("a request older than the fresh hook doesn't count", async () => {
    const f = fixture();
    await f.hook(ASK);
    await f.hook({ hook_event_name: "Stop" });
    expect((await f.send()).ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
  });

  it("a replaced occupant's request doesn't count against the new occupant", async () => {
    const f = fixture();
    const before = f.registry.currentOccupantTenure(f.node.id)!.generationUuid;
    f.registry.mintOccupantTenure(f.node.id, "handover");
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK, { generation: before });
    expect(f.store.getUnsettledInputRequestForNode(f.node.id, f.sessionName)).toBeNull();
    expect((await f.send()).ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
  });

  it("a request past its lifetime no longer counts", async () => {
    const f = fixture();
    await f.hook(ASK);
    expect(f.store.getUnsettledInputRequestForNode(f.node.id, f.sessionName)).not.toBeNull();
    f.tick(300_000);
    expect(f.store.getUnsettledInputRequestForNode(f.node.id, f.sessionName)).toBeNull();
  });
});

describe("MCP elicitations are observation and settlement inputs only", () => {
  it("an elicitation after a fresh Stop, with a dialog drawn: refused before any write", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ELICIT);
    expect(await f.send()).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.wrote()).toBe(0);
  });

  it.each(["accept", "decline", "cancel"])("its result (%s) settles it, and the fresh Stop's reading stands again", async action => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ELICIT);
    await f.hook(elicitResult(action));
    expect(f.store.getUnsettledInputRequestForNode(f.node.id, f.sessionName)).toBeNull();
    expect((await f.send()).ok).toBe(true);
  });

  it("a result at the same instant as the request doesn't settle it", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    const request = await f.hook(ELICIT);
    await f.hook(elicitResult("accept"), { occurredAt: request.occurredAt });
    expect(f.store.getUnsettledInputRequestForNode(f.node.id, f.sessionName)).toBe(request.occurredAt);
  });

  it("neither event changes activity, and no server text, form field or response leaves the relay", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    const before = f.store.getLatestForNode({ nodeId: f.node.id });
    const request = await f.hook(ELICIT);
    const result = await f.hook(elicitResult("accept"));
    expect(f.store.getLatestForNode({ nodeId: f.node.id })?.rawEvent).toBe(before?.rawEvent);
    for (const wire of [request, result]) {
      expect(Object.keys(wire).sort()).toEqual(
        ["generation", "hookAgentId", "hookEvent", "nodeId", "occurredAt", "relayRoute", "runtime", "sessionName"]);
    }
    const stored = JSON.stringify(f.db.prepare("SELECT * FROM events").all());
    expect(stored).not.toContain("SYNTHETIC_SECRET");
    expect(stored).not.toContain("Please provide your credentials");
  });
});

describe("queue wakes take the same reading", () => {
  const queueOn = (f: ReturnType<typeof fixture>) => {
    const repo = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
    repo.attachTransport(f.transport as never);
    return repo;
  };

  it("a wake after a newer request, with its dialog drawn, is refused before any write", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK);
    const repo = queueOn(f);
    const row = await repo.create({ sourceSession: "planner@team", destinationSession: f.sessionName, body: "x" });
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.lastNudgeResult).toMatch(/^failed:/));
    expect(repo.getById(row.qitemId)?.lastNudgeResult).toMatch(/target_needs_input|interactive prompt/);
    expect(f.wrote()).toBe(0);
  });

  it("control: with no request, the same wake after a fresh Stop is typed", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    const repo = queueOn(f);
    const row = await repo.create({ sourceSession: "planner@team", destinationSession: f.sessionName, body: "x" });
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.lastNudgeResult).toBeTruthy());
    expect(repo.getById(row.qitemId)?.lastNudgeResult).not.toMatch(/target_needs_input/);
    expect(f.sendText).toHaveBeenCalled();
  });
});
