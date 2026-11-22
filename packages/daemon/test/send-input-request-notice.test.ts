// A permission or elicitation request the main session made after its latest activity report, still unsettled, is
// context for the sender: the send's result carries a notice saying exactly that, and the send itself goes as it would
// have without it. Native events go through the real relay, the activity ingress and the store; the sends through the
// real transport and queue. The tmux adapter is a fixture whose writes are spies. Synthetic Claude payloads, no live dialog.
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
  const send = async (opts?: Parameters<SessionTransport["send"]>[2]) => { time += 1000; return transport.send(sessionName, "STAND DOWN, do not ship", opts); };
  const wrote = () => sendText.mock.calls.length + sendKeys.mock.calls.length;
  return { db, node, registry, store, sessionName, screen, transport, hook, send, wrote, sendText, now,
    tick: (ms: number) => { time += ms; } };
}

/** The notice's exact words: what was observed, never that a dialog is open. */
const noticeFor = (f: ReturnType<typeof fixture>, at: string) => `${f.sessionName}'s main session made a permission or elicitation request at ${at}, after its latest activity report, and OpenRig hasn't seen it settled. That doesn't establish that a dialog is open; if this message matters, check the seat.`;

describe("an unsettled permission or elicitation request is a notice on the send, never a change to it", () => {
  it("a request after a fresh Stop, with a menu drawn: the send goes as it would without it, and carries the notice", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    const request = await f.hook(ASK);
    const result = await f.send();
    expect(result.ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
    expect(result.inputRequest).toEqual({ observedAt: request.occurredAt, notice: noticeFor(f, String(request.occurredAt)) });
  });

  it("control: the same screen after a fresh Stop and no request delivers the same way, with no notice", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    const result = await f.send();
    expect(result.ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
    expect(result.inputRequest).toBeUndefined();
  });

  it("a request after a fresh running hook: delivered as without it, with the notice", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "UserPromptSubmit", prompt: "SYNTHETIC" });
    await f.hook(ASK);
    const result = await f.send();
    expect(result.ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
    expect(result.inputRequest).toBeDefined();
  });

  it("a refusal the send already makes stays the same refusal, with the notice beside it", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Notification", notification_type: "permission_prompt" });
    await f.hook(ASK);
    const result = await f.send();
    expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.wrote()).toBe(0);
    expect(result.inputRequest).toBeDefined();
  });

  it("a prompt answer gets no notice: it's aimed at the prompt", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK);
    const result = await f.send({ dangerouslyInteract: true, reason: "SYNTHETIC", actorSession: "planner@team" });
    expect(result.inputRequest).toBeUndefined();
  });

  it.each([
    ["settled by a later tool batch from the same session", async (f: ReturnType<typeof fixture>) => {
      await f.hook({ hook_event_name: "Stop" }); await f.hook(ASK); await f.hook({ hook_event_name: "PostToolBatch", tool_calls: [] });
    }],
    ["a subagent's request (not tied to the main pane)", async (f: ReturnType<typeof fixture>) => {
      await f.hook({ hook_event_name: "Stop" }); await f.hook({ ...ASK, agent_id: "subagent-1" });
    }],
    ["a request older than the latest hook", async (f: ReturnType<typeof fixture>) => {
      await f.hook(ASK); await f.hook({ hook_event_name: "Stop" });
    }],
    ["a replaced occupant's request", async (f: ReturnType<typeof fixture>) => {
      const before = f.registry.currentOccupantTenure(f.node.id)!.generationUuid;
      f.registry.mintOccupantTenure(f.node.id, "handover");
      await f.hook({ hook_event_name: "Stop" }); await f.hook(ASK, { generation: before });
    }],
    // Past the send window the existing full read applies, so this one draws an ordinary composer.
    ["a request past its five-minute lifetime", async (f: ReturnType<typeof fixture>) => {
      f.screen.text = COMPOSER; await f.hook({ hook_event_name: "Stop" }); await f.hook(ASK); f.tick(300_000);
    }],
  ])("no notice for %s, and the send is unchanged", async (_name, arrange) => {
    const f = fixture();
    await arrange(f);
    const result = await f.send();
    expect(result.inputRequest).toBeUndefined();
    expect(f.sendText).toHaveBeenCalled();
  });

  it("an unreadable pane: the send's own result, with the notice", async () => {
    const f = fixture();
    f.screen.text = null;
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ASK);
    const control = fixture();
    control.screen.text = null;
    await control.hook({ hook_event_name: "Stop" });
    const [result, expected] = [await f.send(), await control.send()];
    expect({ ok: result.ok, reason: result.reason }).toEqual({ ok: expected.ok, reason: expected.reason });
    expect(result.inputRequest).toBeDefined();
  });
});

describe("MCP elicitations are observation and settlement inputs only", () => {
  it("an elicitation after a fresh Stop: delivered as without it, with the notice", async () => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    const request = await f.hook(ELICIT);
    const result = await f.send();
    expect(result.ok).toBe(true);
    expect(f.sendText).toHaveBeenCalled();
    expect(result.inputRequest?.notice).toBe(noticeFor(f, String(request.occurredAt)));
  });

  it.each(["accept", "decline", "cancel"])("its result (%s) settles it: no notice", async action => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    await f.hook(ELICIT);
    await f.hook(elicitResult(action));
    expect(f.store.getUnsettledInputRequestForNode(f.node.id, f.sessionName)).toBeNull();
    expect((await f.send()).inputRequest).toBeUndefined();
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

describe("queue wakes are unchanged by a request", () => {
  const queueOn = (f: ReturnType<typeof fixture>) => {
    const repo = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
    repo.attachTransport(f.transport as never);
    return repo;
  };

  it.each([true, false])("a wake after a fresh Stop is typed as it would be (request=%s)", async withRequest => {
    const f = fixture();
    await f.hook({ hook_event_name: "Stop" });
    if (withRequest) await f.hook(ASK);
    const repo = queueOn(f);
    const row = await repo.create({ sourceSession: "planner@team", destinationSession: f.sessionName, body: "x" });
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.lastNudgeResult).toBeTruthy());
    expect(repo.getById(row.qitemId)?.lastNudgeResult).not.toMatch(/target_needs_input/);
    expect(f.sendText).toHaveBeenCalled();
  });
});
