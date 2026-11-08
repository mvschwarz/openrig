// #2702: a harness started inside a seat inherits the seat's OpenRig environment, so OpenRig's hooks in it post as the
// seat: a Codex helper a Claude Code seat starts (the codex:codex-rescue plugin, `codex exec` from its Bash tool) loads
// the managed Codex hooks, and a Claude a Codex seat starts in the shared project loads the project's relay. The seat's
// activity and resume target must stay its own. Every post is built by the shipped relay from synthetic hook stdin and
// the environment that hook runs with, and goes through the real route, recorder and activity oracle.
import { createRequire } from "node:module";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";

type Payload = Record<string, unknown>;
type Env = Record<string, string>;
const relay = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")) as {
  buildOpenRigPayload(p: unknown, env: Env, now?: () => Date): Payload | null;
  buildSessionIdentityPayload(p: unknown, env: Env, now?: () => Date): Payload | null;
};

/** A Claude conversation and a Codex thread (synthetic ids), each with the transcript its own runtime names. */
const claudeConversation = "08a71998-0000-4000-8000-000000000001";
const claudeTranscript = `/home/u/.claude/projects/-work-repo/${claudeConversation}.jsonl`;
const codexThread = "01a1b6dc-0511-7841-b149-000000000002";
const codexRollout = `/home/u/.codex/sessions/2026/11/07/rollout-2026-11-07T16-33-55-${codexThread}.jsonl`;

/** One hook run: the stdin its runtime sends, and whether it runs as a Claude Code hook, which has Claude Code's marker
 *  CLAUDE_PROJECT_DIR. A Codex process a Claude started from its Bash tool doesn't have it (both recorded on Claude Code
 *  2.1.282). Codex names its turn, and sends an explicit null for a thread it never persists. */
type HookRun = { stdin: Payload; claudeHook: boolean };
const claude = (hook_event_name: string, extra: Payload = {}): HookRun => ({ claudeHook: true, stdin: {
  hook_event_name, session_id: claudeConversation, transcript_path: claudeTranscript, cwd: "/work/repo", permission_mode: "default", ...extra } });
const codex = (hook_event_name: string, transcript_path: string | null = codexRollout, extra: Payload = {}): HookRun => ({ claudeHook: false, stdin: {
  hook_event_name, session_id: codexThread, turn_id: "01a1b6dc-0000-7000-8000-00000000t001", transcript_path,
  cwd: "/work/repo", model: "gpt-test", permission_mode: "default", ...extra } });

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function seat(runtime: "claude-code" | "codex") {
  const clock = { at: Date.parse("2026-11-08T08:00:00.000Z") };
  const now = () => new Date(clock.at);
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db), sessions = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigs.createRig("rig-a");
  const node = rigs.addNode(rig.id, "dev.a", { runtime, cwd: "/work/repo" });
  const name = "dev-a@rig-a";
  const session = sessions.registerSession(node.id, name);
  sessions.updateStatus(session.id, "running");
  sessions.updateResumeToken(session.id, runtime === "codex" ? "codex_id" : "claude_id",
    runtime === "codex" ? codexThread : claudeConversation, "hook");
  const store = new AgentActivityStore({ db, eventBus, now,
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now });
  // A Codex seat's hook rung enters at trial and earns authority by agreeing with its screen (AM-2). This is a seat
  // whose hooks already have, so they decide its activity, as a Claude seat's do from the start.
  if (runtime === "codex") oracle.declareRungInventory({ seatNodeId: node.id, sessionName: name }, {
    ...CODEX_ACTIVITY_RUNG_INVENTORY,
    rungs: CODEX_ACTIVITY_RUNG_INVENTORY.rungs.map(r => r.rung === "lifecycle-hooks" ? { ...r, initialTrust: "authoritative" as const } : r),
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture" as never);
    c.set("seatActivityService" as never, oracle as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("eventBus" as never, eventBus as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  // What the seat's own harness has in its environment, and so what any process it starts inherits.
  const seatEnv: Env = { OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: node.id, OPENRIG_RUNTIME: runtime,
    OPENRIG_OCCUPANT_GENERATION: sessions.currentOccupantTenure(node.id)!.generationUuid };
  const post = async (payload: Payload) => {
    const res = await app.request("/api/activity/hooks", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    return await res.json() as Payload;
  };
  /** One run of the shipped relay, as its main() posts: the activity report, then on a SessionStart the identity
   *  report. A second later each time, so the reports arrive in order. */
  const hook = async (run: HookRun, inherited: Env = seatEnv) => {
    clock.at += 1000;
    const env = run.claudeHook ? { ...inherited, CLAUDE_PROJECT_DIR: "/work/repo" } : inherited;
    const replies: Payload[] = [];
    for (const payload of [relay.buildOpenRigPayload(run.stdin, env, now), relay.buildSessionIdentityPayload(run.stdin, env, now)]) {
      if (payload) replies.push(await post(payload));
    }
    return replies;
  };
  /** A runtime switch to `target` that has staged its successor and not yet committed; the successor's environment. */
  const stageSwitch = (target: "claude-code" | "codex"): Env => {
    const successor = "0b9d8c7e-0000-4000-8000-00000000s001";
    db.prepare(`INSERT INTO seat_runtime_switches (id, node_id, canonical_session, staging_session, predecessor_pane, successor_pane,
      predecessor_generation, successor_generation, from_runtime, to_runtime, phase, reason, plan_json, deadline_at)
      VALUES ('sw1', ?, ?, 'openrig-switch-sw1', '%0', '%5', ?, ?, ?, ?, 'preparing', 'limit', '{}', '2026-11-08T09:00:00Z')`)
      .run(node.id, name, seatEnv.OPENRIG_OCCUPANT_GENERATION, successor, runtime, target);
    return { ...seatEnv, OPENRIG_RUNTIME: target, OPENRIG_OCCUPANT_GENERATION: successor };
  };
  return {
    hook, post, seatEnv, now, stageSwitch,
    activity: () => oracle.getSeatState(node.id)?.activity,
    token: () => db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(session.id),
    successorToken: () => (db.prepare("SELECT successor_resume_token AS t FROM seat_runtime_switches WHERE id = 'sw1'").get() as { t: string | null }).t,
    identityEvents: () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.session_identity'").get() as { n: number }).n,
  };
}

describe("#2702: a Codex helper's turn inside a Claude Code seat isn't the seat's activity", () => {
  it.each([
    ["a persisted thread (its rollout file)", codexRollout],
    ["a thread Codex never persisted (an explicit null)", null],
  ])("the seat stays working through a Codex helper's whole run with %s, and its own Stop still ends the turn", async (_label, transcript) => {
    const s = seat("claude-code");
    await s.hook(claude("UserPromptSubmit"));
    expect(s.activity()).toBe("working");
    // The seat's Claude runs `codex exec`: the helper starts, takes its prompt and finishes its turn.
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) await s.hook(codex(event, transcript, event === "SessionStart" ? { source: "startup" } : {}));
    expect(s.activity()).toBe("working");
    expect(s.token()).toEqual({ resume_type: "claude_id", resume_token: claudeConversation });
    await s.hook(claude("Stop"));
    expect(s.activity()).toBe("idle-at-prompt");
  });

  it("an older relay's report (no transcriptPathPresent field) still counts as the seat's, as before", async () => {
    const s = seat("claude-code");
    await s.hook(claude("UserPromptSubmit"));
    const stop = relay.buildOpenRigPayload(codex("Stop").stdin, s.seatEnv, s.now)!;
    delete stop.transcriptPathPresent;
    delete stop.transcriptPath;
    await s.post(stop);
    expect(s.activity()).toBe("idle-at-prompt");
  });
});

describe("#2702 mirror: a Claude started inside a Codex seat isn't the seat", () => {
  it("the Codex seat keeps resuming its own thread after the Claude's SessionStart", async () => {
    const s = seat("codex");
    const identities = s.identityEvents();
    const replies = await s.hook(claude("SessionStart", { source: "startup" }));
    expect(s.token()).toEqual({ resume_type: "codex_id", resume_token: codexThread });
    expect(s.identityEvents()).toBe(identities);
    expect(replies[1]).toMatchObject({ ok: true, tokenPersisted: false, code: "transcript_not_this_session" });
  });

  it("the Codex seat stays working through the Claude's turn, and its own Stop still ends its turn", async () => {
    const s = seat("codex");
    await s.hook(codex("UserPromptSubmit", null));
    expect(s.activity()).toBe("working");
    for (const event of ["UserPromptSubmit", "Notification", "Stop"]) await s.hook(claude(event));
    expect(s.activity()).toBe("working");
    await s.hook(codex("Stop", null));
    expect(s.activity()).toBe("idle-at-prompt");
  });

  it("the Codex seat's own new thread still moves its resume target", async () => {
    const s = seat("codex");
    const next = "01a1b6dc-0511-7841-b149-000000000009";
    const replies = await s.hook(codex("SessionStart", `/home/u/.codex/sessions/2026/11/08/rollout-2026-11-08T08-00-00-${next}.jsonl`,
      { session_id: next, source: "startup" }));
    expect(replies[1]).toMatchObject({ ok: true, tokenPersisted: true });
    expect(s.token()).toEqual({ resume_type: "codex_id", resume_token: next });
  });

  // Codex keeps a legacy or supplied rollout name when it resumes a thread, so its transcript can be `<thread id>.jsonl`,
  // even in a folder laid out like Claude Code's. It still isn't a Claude Code hook, so it's still the seat.
  it.each([
    ["a legacy name", "/home/u/.codex/sessions"],
    ["a legacy name in a folder laid out like Claude Code's", "/home/u/.claude/projects/-work-repo"],
  ])("a Codex seat resumed from a rollout with %s still reports its own thread and turns", async (_label, folder) => {
    const s = seat("codex");
    const resumed = "01a1b6dc-0511-7841-b149-00000000000a";
    const own = (event: string, extra: Payload = {}) => codex(event, `${folder}/${resumed}.jsonl`, { session_id: resumed, ...extra });
    expect((await s.hook(own("SessionStart", { source: "resume" })))[1]).toMatchObject({ tokenPersisted: true });
    expect(s.token()).toEqual({ resume_type: "codex_id", resume_token: resumed });
    await s.hook(own("UserPromptSubmit"));
    expect(s.activity()).toBe("working");
    await s.hook(own("Stop"));
    expect(s.activity()).toBe("idle-at-prompt");
  });
});

describe("#2702: a runtime switch's staged successor keeps its own id through a helper of the other runtime", () => {
  it.each([
    ["a Codex seat moving to Claude Code, whose successor runs a Codex helper", "codex", "claude-code"],
    ["a Claude Code seat moving to Codex, whose successor runs a Claude", "claude-code", "codex"],
  ] as const)("%s: the switch keeps the successor's own conversation for its commit", async (_label, from, to) => {
    const s = seat(from);
    const successorEnv = s.stageSwitch(to);
    // The successor's own SessionStart, then, during its handover turn, the helper's.
    const own = to === "claude-code" ? claude("SessionStart", { source: "startup" }) : codex("SessionStart", codexRollout, { source: "startup" });
    const helper = to === "claude-code" ? codex("SessionStart", codexRollout, { source: "startup" }) : claude("SessionStart", { source: "startup" });
    await s.hook(own, successorEnv);
    expect(s.successorToken()).toBe(own.stdin.session_id);
    await s.hook(helper, successorEnv);
    expect(s.successorToken()).toBe(own.stdin.session_id);
  });
});

describe("#2702: the relay names the conversation on every activity and identity report", () => {
  const env: Env = { OPENRIG_SESSION_NAME: "dev-a@rig-a", OPENRIG_RUNTIME: "claude-code" };
  it.each([
    ["a transcript path", { transcript_path: codexRollout }, { transcriptPathPresent: true, transcriptPath: codexRollout }],
    ["an explicit null", { transcript_path: null }, { transcriptPathPresent: true, transcriptPath: null }],
    ["no transcript_path key", {}, { transcriptPathPresent: false }],
  ])("forwards the session id and %s", (_label, transcript, expected) => {
    const payload = relay.buildOpenRigPayload({ hook_event_name: "Stop", session_id: codexThread, ...transcript }, env)!;
    expect(payload).toMatchObject({ sessionId: codexThread, ...expected });
    expect(Object.hasOwn(payload, "transcriptPath")).toBe(Object.hasOwn(transcript, "transcript_path"));
  });

  it("says whether Claude Code's marker, CLAUDE_PROJECT_DIR, is set, and sends nothing of its value", () => {
    const stdin = { hook_event_name: "SessionStart", session_id: claudeConversation, transcript_path: claudeTranscript };
    for (const build of [relay.buildOpenRigPayload, relay.buildSessionIdentityPayload]) {
      expect(build(stdin, env)).toMatchObject({ claudeHook: false });
      const asHook = build(stdin, { ...env, CLAUDE_PROJECT_DIR: "/work/secret-project" })!;
      expect(asHook).toMatchObject({ claudeHook: true });
      expect(JSON.stringify(asHook)).not.toContain("secret-project");
    }
  });
});
