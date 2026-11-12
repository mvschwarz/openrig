// #2796: a no-launch adoption (reconcile, bind, self-attach) registers the seat's live process again and mints an
// 'adopt' tenure, but no new process starts. That occupant's own Claude SessionStart must still move the seat's resume
// target, while a genuinely replaced predecessor's still can't (#2768). The real ClaimService.reconcileSession runs on
// the full test app with SQLite; each hook is built by the shipped relay from a synthetic SessionStart stdin and posted
// to the real activity route.
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const relay = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")) as {
  buildSessionIdentityPayload(p: unknown, env: Record<string, string>): Record<string, unknown> | null;
};
const name = "dev-impl@rig-a";
const conversation = "55555555-5555-4555-8555-555555555555";

let db: Database.Database;
let sessionEnv: Record<string, string | null>;
let setup: ReturnType<typeof createTestApp>;

beforeEach(() => {
  db = createFullTestDb();
  sessionEnv = {};
  // No launch path is stubbed to succeed silently: a reconcile that typed or launched would show in these spies.
  const tmux = {
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => { throw new Error("adoption must not launch"); }),
    killSession: vi.fn(async () => { throw new Error("adoption must not kill"); }),
    sendText: vi.fn(async () => { throw new Error("adoption must not type"); }),
    sendKeys: vi.fn(async () => { throw new Error("adoption must not type"); }),
    listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []),
    startPipePane: vi.fn(async () => ({ ok: true as const })), stopPipePane: vi.fn(async () => ({ ok: true as const })),
    setSessionOption: vi.fn(async () => ({ ok: true as const })), getSessionOption: vi.fn(async () => null),
    // The tmux session environment can still name a predecessor after a handover respawn.
    getSessionEnv: vi.fn(async (_session: string, key: string) => sessionEnv[key] ?? null),
    getPanePid: vi.fn(async () => 4242), getPaneCommand: vi.fn(async () => "claude"),
  } as unknown as TmuxAdapter;
  setup = createTestApp(db, { tmux, activityHookToken: "fixture" });
});
afterEach(() => { db.close(); });

/** A Claude seat whose first occupant A was replaced by a handover to B (B is the live process). */
function handedOver() {
  const { rigRepo, sessionRegistry: registry } = setup;
  const rig = rigRepo.createRig("rig-a");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/repo" });
  const first = registry.registerSession(node.id, name);
  registry.updateStatus(first.id, "running");
  const generationA = registry.currentOccupantTenure(node.id)!.generationUuid;
  const generationB = registry.reserveOccupantGeneration()!;
  const successor = registry.registerClaimedSession(node.id, name, "handover", generationB);
  registry.updateStatus(successor.id, "running");
  registry.updateResumeToken(successor.id, "claude_id", "11111111-1111-4111-8111-111111111111", "hook");
  return { rig, node, generationA, generationB };
}

/** One Claude SessionStart naming `sessionId` from a process carrying `generation`, through the relay and the route. */
async function sessionStart(nodeId: string, generation: string, sessionId = conversation) {
  const env = { OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: nodeId, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation };
  const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: sessionId, source: "resume" }, env);
  const res = await setup.app.request("/api/activity/hooks", { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** The resume target of the seat's newest session row, which the next resume reads. */
function resumeTarget(nodeId: string): string | null {
  return (db.prepare("SELECT resume_token FROM sessions WHERE node_id = ? ORDER BY rowid DESC LIMIT 1").get(nodeId) as { resume_token: string | null }).resume_token;
}

/** The daemon lost the live session row, as after a crash; the live tmux session keeps the seat's name. */
async function reconcile(rigId: string, nodeId: string) {
  for (const row of setup.sessionRegistry.getSessionsForRig(rigId)) if (row.nodeId === nodeId) setup.sessionRegistry.markDetached(row.id);
  const result = await setup.claimService.reconcileSession({ sessionName: name });
  expect(result.ok).toBe(true);
  expect(setup.sessionRegistry.currentOccupantTenure(nodeId)!.kind).toBe("adopt");
}

it("after a no-launch reconcile, the live occupant's own SessionStart still moves the resume target", async () => {
  const s = handedOver();
  await reconcile(s.rig.id, s.node.id);
  const r = await sessionStart(s.node.id, s.generationB);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, tokenPersisted: true });
  expect(resumeTarget(s.node.id)).toBe(conversation);
});

it("after the same reconcile, the replaced predecessor's SessionStart is still refused", async () => {
  const s = handedOver();
  await reconcile(s.rig.id, s.node.id);
  const before = resumeTarget(s.node.id);
  const r = await sessionStart(s.node.id, s.generationA);
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ ok: false, code: "generation_mismatch", tokenPersisted: false });
  expect(resumeTarget(s.node.id)).toBe(before);
});

it("a tmux session environment that still names the predecessor changes neither answer", async () => {
  const s = handedOver();
  sessionEnv = { OPENRIG_NODE_ID: s.node.id, OPENRIG_SESSION_NAME: name, OPENRIG_OCCUPANT_GENERATION: s.generationA };
  await reconcile(s.rig.id, s.node.id);
  expect((await sessionStart(s.node.id, s.generationA)).status).toBe(409);
  expect((await sessionStart(s.node.id, s.generationB)).body).toMatchObject({ ok: true, tokenPersisted: true });
  expect(resumeTarget(s.node.id)).toBe(conversation);
});

it("a relaunch after an adoption makes the adopted occupant an earlier one again", async () => {
  const s = handedOver();
  await reconcile(s.rig.id, s.node.id);
  const generationC = setup.sessionRegistry.reserveOccupantGeneration()!;
  const relaunched = setup.sessionRegistry.registerSession(s.node.id, name, "fresh", generationC);
  setup.sessionRegistry.updateStatus(relaunched.id, "running");
  expect((await sessionStart(s.node.id, s.generationB)).body).toMatchObject({ ok: false, code: "generation_mismatch" });
  expect((await sessionStart(s.node.id, generationC)).body).toMatchObject({ ok: true, tokenPersisted: true });
});

it("bind and self-attach register the same 'adopt' tenure, and the live occupant stays current through it", async () => {
  // Both call registerClaimedSession with its default kind (claim-service bind, self-attach-service), as reconcile does.
  const s = handedOver();
  const adopted = setup.sessionRegistry.registerClaimedSession(s.node.id, name);
  expect(setup.sessionRegistry.currentOccupantTenure(s.node.id)!.kind).toBe("adopt");
  expect(adopted.status).toBe("running");
  expect((await sessionStart(s.node.id, s.generationB)).body).toMatchObject({ ok: true, tokenPersisted: true });
  expect((await sessionStart(s.node.id, s.generationA)).body).toMatchObject({ ok: false, code: "generation_mismatch" });
});
