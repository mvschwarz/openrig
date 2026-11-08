// #2702: a Codex helper started inside a Claude Code seat (the codex:codex-rescue plugin, or `codex exec` from the seat's
// Bash tool) inherits the seat's OpenRig environment, so OpenRig's managed Codex hook reports its Codex thread as the
// Claude seat's session. The seat must keep resuming its own Claude conversation. Each post is built by the shipped
// relay from a synthetic SessionStart stdin; the real activity route and SQLite registry receive it.
import { createRequire } from "node:module";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";

const relay = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")) as {
  buildSessionIdentityPayload(p: unknown, env: Record<string, string>): Record<string, unknown> | null;
};
/** The seat's own Claude conversation, and the Codex helper's thread, as in the report (synthetic ids). */
const claudeConversation = "08a71998-0000-4000-8000-000000000001";
const codexThread = "01a1b6dc-0511-7841-b149-000000000002";
const codexRollout = `/home/u/.codex/sessions/2026/11/07/rollout-2026-11-07T16-33-55-${codexThread}.jsonl`;
const name = "orch-lead@rig-a";

function claudeSeat() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("rig-a");
  const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/work/repo" });
  const session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id, "running");
  const generation = registry.currentOccupantTenure(node.id)?.generationUuid ?? "";
  registry.updateResumeToken(session.id, "claude_id", claudeConversation, "hook");
  const app = new Hono();
  app.use("*", async (c, go) => {
    c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }) as never);
    c.set("activityHookToken" as never, "fixture" as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("eventBus" as never, eventBus as never);
    await go();
  });
  app.route("/api/activity", activityRoutes);
  // What the seat's Claude has in its environment, and so what any process it starts inherits.
  const seatEnv = { OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: node.id, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation };
  const post = async (payload: Record<string, unknown> | null) => {
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  /** One SessionStart through the shipped relay's payload builder and the real route, run with the seat's environment. */
  const sessionStart = async (stdin: Record<string, unknown>) => post(relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", ...stdin }, seatEnv));
  const token = () => (db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(session.id) as { resume_type: string | null; resume_token: string | null });
  const identityEvents = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.session_identity'").get() as { n: number }).n;
  return { sessionStart, post, token, identityEvents, seatEnv };
}

describe("#2702: a Codex helper inside a Claude seat doesn't take over the seat's resume token", () => {
  it.each([
    ["a persisted thread (its rollout file)", { transcript_path: codexRollout }],
    ["a thread Codex never persisted (an explicit null)", { transcript_path: null }],
  ])("after a Codex helper's SessionStart with %s, the seat still resumes its own Claude conversation", async (_label, transcript) => {
    const s = claudeSeat();
    const before = s.identityEvents();
    const r = await s.sessionStart({ session_id: codexThread, source: "startup", ...transcript });
    expect(r.body).toMatchObject({ ok: true, tokenPersisted: false, code: "transcript_not_this_session" });
    expect(s.token()).toEqual({ resume_type: "claude_id", resume_token: claudeConversation });
    // Nothing reads as the seat's new identity either.
    expect(s.identityEvents()).toBe(before);
  });

  it("the seat's own Claude still moves the token, in either path spelling, after a helper's report was refused", async () => {
    const s = claudeSeat();
    await s.sessionStart({ session_id: codexThread, source: "startup", transcript_path: codexRollout });
    const cleared = "5f0c2d11-0000-4000-8000-000000000003";
    const before = s.identityEvents();
    const r = await s.sessionStart({ session_id: cleared, source: "clear", transcript_path: `/home/u/.claude/projects/-work-repo/${cleared}.jsonl` });
    expect(r.body).toMatchObject({ ok: true, tokenPersisted: true });
    expect(s.token()).toEqual({ resume_type: "claude_id", resume_token: cleared });
    expect(s.identityEvents()).toBe(before + 1);
    const windows = "7a1e9b42-0000-4000-8000-000000000004";
    expect((await s.sessionStart({ session_id: windows, source: "clear", transcript_path: `C:\\Users\\u\\.claude\\projects\\C--work-repo\\${windows}.jsonl` })).body)
      .toMatchObject({ tokenPersisted: true });
    expect(s.token().resume_token).toBe(windows);
  });

  it("an older relay's post (no transcriptPathPresent field at all) still writes, as today", async () => {
    const s = claudeSeat();
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: codexThread, transcript_path: codexRollout }, s.seatEnv)!;
    delete payload.transcriptPathPresent;
    delete payload.transcriptPath;
    expect((await s.post(payload)).body).toMatchObject({ tokenPersisted: true });
    expect(s.token().resume_token).toBe(codexThread);
  });
});
