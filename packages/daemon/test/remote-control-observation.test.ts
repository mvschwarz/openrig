// #3513: a Claude seat's own hooks report its Remote Control session (CLAUDE_CODE_BRIDGE_SESSION_ID), and the node read
// shows the last one seen, bound to the current occupant and conversation. The shipped relay builds each post from a
// synthetic Claude hook stdin; the real activity route, SQLite store and node inventory route receive and serve it.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { parseRemoteControlReport } from "../src/domain/remote-control-observations.js";

const relayPath = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const relay = createRequire(import.meta.url)(relayPath) as {
  buildOpenRigPayload(p: unknown, env: Record<string, string>, now?: () => Date): Record<string, unknown> | null;
};
const conversation = "11111111-1111-4111-8111-111111111111";
const otherConversation = "22222222-2222-4222-8222-222222222222";
const linkA = "session_01AbCdEfGhIjKlMnOpQrStUv";
const linkB = "session_01ZyXwVuTsRqPoNmLkJiHgFe";
const name = "dev-impl@rig-a";

function seat(initialConversation: string | null = conversation) {
  const db = createFullTestDb();
  const t = createTestApp(db, { activityHookToken: "fixture" });
  const rig = t.rigRepo.createRig("rig-a");
  const node = t.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/repo" });
  const session = t.sessionRegistry.registerSession(node.id, name);
  t.sessionRegistry.updateStatus(session.id, "running");
  if (initialConversation) t.sessionRegistry.updateResumeToken(session.id, "claude_id", initialConversation, "hook");
  const generation = t.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? "";
  const env = (extra: Record<string, string> = {}) => ({ OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: node.id,
    OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation, CLAUDE_PROJECT_DIR: "/work/repo", ...extra });
  /** One Claude Stop hook through the shipped relay and the real route. */
  const hook = async (opts: { at: string; link?: string; session?: string; generation?: string; runtime?: string; event?: string }) => {
    const e = env({ ...(opts.link !== undefined ? { CLAUDE_CODE_BRIDGE_SESSION_ID: opts.link } : {}),
      ...(opts.generation ? { OPENRIG_OCCUPANT_GENERATION: opts.generation } : {}), ...(opts.runtime ? { OPENRIG_RUNTIME: opts.runtime } : {}) });
    const payload = relay.buildOpenRigPayload({ hook_event_name: opts.event ?? "Stop", session_id: opts.session ?? conversation,
      transcript_path: `/home/u/.claude/projects/-work-repo/${opts.session ?? conversation}.jsonl` }, e, () => new Date(opts.at));
    const res = await t.app.request("/api/activity/hooks", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
    expect(res.status).toBeLessThan(500);
  };
  const read = async () => {
    const res = await t.app.request(`/api/rigs/${rig.id}/nodes`);
    expect(res.status).toBe(200);
    const [row] = await res.json() as Array<Record<string, unknown>>;
    return row!.remoteControl;
  };
  return { t, db, node, session, generation, env, hook, read };
}

it.each([null, conversation])("shows Remote Control after the real two-post SessionStart with prior conversation %s", async prior => {
  const s = seat(prior);
  const posts: Array<{ kind: unknown; postedAt: unknown; status: number; reply: unknown; observation: unknown }> = [];
  let server: ReturnType<typeof serve> | undefined;
  try {
    const port = await new Promise<number>(resolve => {
      server = serve({
        hostname: "127.0.0.1", port: 0,
        fetch: async request => {
          const payload = await request.clone().json() as Record<string, unknown>;
          const response = await s.t.app.fetch(request);
          posts.push({ kind: payload.eventFamily ?? payload.hookEvent, postedAt: payload.occurredAt,
            status: response.status, reply: await response.clone().json(), observation: await s.read() });
          return response;
        },
      }, info => resolve(info.port));
    });
    const child = spawn(process.execPath, [relayPath], {
      env: s.env({ OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture",
        CLAUDE_CODE_BRIDGE_SESSION_ID: linkB }),
      stdio: ["pipe", "ignore", "inherit"], timeout: 4000,
    });
    const closed = once(child, "close");
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: prior ? "clear" : "startup",
      session_id: otherConversation, transcript_path: `/fixture/${otherConversation}.jsonl` }));
    expect(await closed).toEqual([0, null]);
    expect(posts.map(post => post.kind)).toEqual(["SessionStart", "session_identity"]);
    expect(posts[0]).toMatchObject({ status: 200, observation: null });
    expect(posts[1]).toMatchObject({ status: 200, reply: { tokenPersisted: true },
      observation: { sessionId: linkB, observedAt: posts[1]?.postedAt } });
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    s.db.close();
  }
});

it("the relay reports a well-formed id, null when unset, and nothing for a malformed value or another runtime", () => {
  const base = { OPENRIG_SESSION_NAME: name, OPENRIG_RUNTIME: "claude-code" };
  const of = (env: Record<string, string>) => relay.buildOpenRigPayload({ hook_event_name: "Stop", session_id: conversation }, env);
  expect(of({ ...base, CLAUDE_CODE_BRIDGE_SESSION_ID: linkA })).toMatchObject({ remoteControlSessionId: linkA });
  expect(of(base)).toMatchObject({ remoteControlSessionId: null });
  expect(of({ ...base, CLAUDE_CODE_BRIDGE_SESSION_ID: "   " })).toMatchObject({ remoteControlSessionId: null });
  expect(of({ ...base, CLAUDE_CODE_BRIDGE_SESSION_ID: "not an id" })).not.toHaveProperty("remoteControlSessionId");
  expect(of({ OPENRIG_SESSION_NAME: name, OPENRIG_RUNTIME: "codex", CLAUDE_CODE_BRIDGE_SESSION_ID: linkA }))
    .not.toHaveProperty("remoteControlSessionId");
  expect(parseRemoteControlReport({})).toBeNull();
  expect(parseRemoteControlReport({ remoteControlSessionId: 7 })).toBeNull();
});

it("never observed stays null: an absent report alone proves nothing about the seat's Claude", async () => {
  const s = seat();
  expect(await s.read()).toBeNull();
  await s.hook({ at: "2026-11-19T01:00:00.000Z" });
  expect(await s.read()).toBeNull();
});

it("shows the last session seen with its time, and a later absence of that conversation as observed absent", async () => {
  const s = seat();
  await s.hook({ at: "2026-11-19T01:00:00.000Z", link: linkA });
  expect(await s.read()).toEqual({ sessionId: linkA, observedAt: "2026-11-19T01:00:00.000Z" });
  await s.hook({ at: "2026-11-19T01:05:00.000Z", link: linkB });
  expect(await s.read()).toEqual({ sessionId: linkB, observedAt: "2026-11-19T01:05:00.000Z" });
  await s.hook({ at: "2026-11-19T01:10:00.000Z" });
  expect(await s.read()).toEqual({ sessionId: null, observedAt: "2026-11-19T01:10:00.000Z" });
});

it("a delayed event never replaces a newer observation of the same occupant and conversation", async () => {
  const s = seat();
  await s.hook({ at: "2026-11-19T01:05:00.000Z", link: linkB });
  await s.hook({ at: "2026-11-19T01:00:00.000Z", link: linkA });
  await s.hook({ at: "2026-11-19T01:01:00.000Z" });
  expect(await s.read()).toEqual({ sessionId: linkB, observedAt: "2026-11-19T01:05:00.000Z" });
});

it("an earlier occupant's hook is not recorded, and a replaced occupant's link is never shown as current", async () => {
  const s = seat();
  await s.hook({ at: "2026-11-19T01:00:00.000Z", link: linkA });
  const next = s.t.sessionRegistry.reserveOccupantGeneration()!;
  const successor = s.t.sessionRegistry.registerClaimedSession(s.node.id, name, "handover", next);
  s.t.sessionRegistry.updateStatus(successor.id, "running");
  s.t.sessionRegistry.updateResumeToken(successor.id, "claude_id", conversation, "hook");
  expect(await s.read()).toBeNull();
  await s.hook({ at: "2026-11-19T01:02:00.000Z", link: linkB, generation: s.generation });
  expect(await s.read()).toBeNull();
  await s.hook({ at: "2026-11-19T01:03:00.000Z", link: linkB, generation: next });
  expect(await s.read()).toEqual({ sessionId: linkB, observedAt: "2026-11-19T01:03:00.000Z" });
  // A delayed hook from the earlier occupant, even a newer-stamped one, never replaces the current occupant's row.
  await s.hook({ at: "2026-11-19T01:04:00.000Z", link: linkA, generation: s.generation });
  expect(await s.read()).toEqual({ sessionId: linkB, observedAt: "2026-11-19T01:03:00.000Z" });
});

it("a seat continued by adoption still counts as current; a launch after it does not", async () => {
  const s = seat();
  // A no-launch adoption (reconcile, bind, self-attach) registers the same live process under a new generation, while
  // its hooks keep the launch generation: those hooks are still the seat's, on the write and on the node read.
  await s.hook({ at: "2026-11-19T01:00:00.000Z", link: linkA });
  const adopted = s.t.sessionRegistry.mintOccupantTenure(s.node.id, "adopt");
  expect(adopted.generationUuid).not.toBe(s.generation);
  expect(s.t.sessionRegistry.currentOccupantTenure(s.node.id)?.generationUuid).toBe(adopted.generationUuid);
  expect(await s.read()).toEqual({ sessionId: linkA, observedAt: "2026-11-19T01:00:00.000Z" });
  await s.hook({ at: "2026-11-19T01:02:00.000Z", link: linkB });
  expect(await s.read()).toEqual({ sessionId: linkB, observedAt: "2026-11-19T01:02:00.000Z" });
  // A launch kind after it replaces that occupant: its hooks no longer count, and its row is no longer shown.
  s.t.sessionRegistry.mintOccupantTenure(s.node.id, "fresh");
  expect(await s.read()).toBeNull();
  await s.hook({ at: "2026-11-19T01:03:00.000Z", link: linkA });
  expect(await s.read()).toBeNull();
});

it("a launch generation and its adoption generation are one occupant for ordering and disconnects", async () => {
  // Helios FAIL on 52f5af2: both generations are accepted as current, so the row must not treat them as two occupants.
  const s = seat();
  const adopted = s.t.sessionRegistry.mintOccupantTenure(s.node.id, "adopt").generationUuid;
  // A newer report under the adoption generation is not replaced by a delayed older one under the launch generation.
  await s.hook({ at: "2026-11-19T01:20:00.000Z", link: linkB, generation: adopted });
  await s.hook({ at: "2026-11-19T01:00:00.000Z", link: linkA, generation: s.generation });
  expect(await s.read()).toEqual({ sessionId: linkB, observedAt: "2026-11-19T01:20:00.000Z" });
  // A disconnect reported under the other generation of the same occupant is recorded as observed absent.
  await s.hook({ at: "2026-11-19T01:30:00.000Z", link: linkA, generation: s.generation });
  await s.hook({ at: "2026-11-19T01:40:00.000Z", generation: adopted });
  expect(await s.read()).toEqual({ sessionId: null, observedAt: "2026-11-19T01:40:00.000Z" });
});

it("control: an absence alone, under either generation of the occupant, still proves nothing", async () => {
  const s = seat();
  const adopted = s.t.sessionRegistry.mintOccupantTenure(s.node.id, "adopt").generationUuid;
  await s.hook({ at: "2026-11-19T01:00:00.000Z", generation: adopted });
  await s.hook({ at: "2026-11-19T01:01:00.000Z", generation: s.generation });
  expect(await s.read()).toBeNull();
});

it("a PostToolBatch hook mid-turn records the observation too, not only Stop", async () => {
  const s = seat();
  await s.hook({ at: "2026-11-19T01:00:00.000Z", link: linkA, event: "PostToolBatch" });
  expect(await s.read()).toEqual({ sessionId: linkA, observedAt: "2026-11-19T01:00:00.000Z" });
  await s.hook({ at: "2026-11-19T01:01:00.000Z", event: "PostToolBatch" });
  expect(await s.read()).toEqual({ sessionId: null, observedAt: "2026-11-19T01:01:00.000Z" });
});

it("a helper Claude in another conversation, and a changed conversation, never show as the seat's link", async () => {
  const s = seat();
  await s.hook({ at: "2026-11-19T01:00:00.000Z", link: linkA, session: otherConversation });
  expect(await s.read()).toBeNull();
  await s.hook({ at: "2026-11-19T01:01:00.000Z", link: linkA });
  expect(await s.read()).toEqual({ sessionId: linkA, observedAt: "2026-11-19T01:01:00.000Z" });
  s.t.sessionRegistry.updateResumeToken(s.session.id, "claude_id", otherConversation, "hook");
  expect(await s.read()).toBeNull();
  await s.hook({ at: "2026-11-19T01:02:00.000Z", session: otherConversation });
  expect(await s.read()).toBeNull();
});
