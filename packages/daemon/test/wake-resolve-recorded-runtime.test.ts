import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WakeResolveService, WAKE_SESSIONS_SQL } from "../src/domain/wake-resolve-service.js";
import type { WakeSessionRow } from "../src/domain/wake-resolver.js";
import { wakeResolveRoutes } from "../src/routes/wake-resolve.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function claimedUnknown() {
  const db = createFullTestDb();
  databases.push(db);
  const f = createTestApp(db, {
    activityHookToken: "fixture-hook",
    transcriptStore: new TranscriptStore({ transcriptsRoot: "/unused", enabled: false }),
  });
  const rig = f.rigRepo.createRig("wake-claimed");
  db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Dev");
  const seat = "person@wake-claimed";
  const discovered = f.discoveryRepo.upsertDiscoveredSession({
    tmuxSession: seat, tmuxPane: "%1", runtimeHint: "unknown", confidence: "high",
  });
  const claimed = await f.claimService.createAndBindToPod({
    discoveredId: discovered.id, rigId: rig.id, podId: "pod-dev", podNamespace: "dev", memberName: "person",
  });
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw new Error(claimed.error);
  expect(db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(claimed.nodeId)).toEqual({ runtime: null });
  const svc = new WakeResolveService({ listSessionsBySeat: name => db.prepare(WAKE_SESSIONS_SQL).all(name) as WakeSessionRow[] });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("wakeResolveService" as never, svc as never); await next(); });
  app.route("/api/wake-resolve", wakeResolveRoutes);
  const resolve = async () => {
    const response = await app.request("/api/wake-resolve", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seat }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ...f, seat, claimed, resolve };
}

describe("recorded runtime: claimed node and production wake reader", () => {
  it("keeps a real Claude identity hook resumable when the claimed node runtime is NULL", async () => {
    const f = await claimedUnknown();
    const response = await f.app.request("/api/activity/hooks", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-hook" },
      body: JSON.stringify({ eventFamily: "session_identity", runtime: "claude-code", nodeId: f.claimed.nodeId,
        sessionName: f.seat, sessionId: "fixture-claude-recorded" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tokenPersisted: true });
    expect(f.db.prepare("SELECT n.runtime, s.resume_type FROM nodes n JOIN sessions s ON s.node_id = n.id WHERE s.id = ?")
      .get(f.claimed.sessionId)).toEqual({ runtime: null, resume_type: "claude_id" });
    expect(await f.resolve()).toMatchObject({ resolved: true, runtime: "claude", token: "fixture-claude-recorded", sessionId: f.claimed.sessionId });
  });

  it.each([["claude_name", "claude"], ["codex_id", "codex"]])("keeps recorded supported type %s on a NULL node", async (type, runtime) => {
    const f = await claimedUnknown();
    expect(f.sessionRegistry.updateResumeToken(f.claimed.sessionId, type, "fixture-recorded", "operator")).toBe(true);
    expect(await f.resolve()).toMatchObject({ resolved: true, runtime, token: "fixture-recorded" });
  });

  it.each([null, "", "unknown", "pi_session_file", "omp_session_file"])("does not guess Claude from an unsupported recorded type %j", async (type) => {
    const f = await claimedUnknown();
    if (type !== null) f.sessionRegistry.updateResumeToken(f.claimed.sessionId, type, "fixture-unmapped", "operator");
    const result = await f.resolve();
    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/runtime .*not supported/i);
    expect(result).not.toHaveProperty("token");
  });

  it.each(["pi", "custom", ""])("never replaces explicit node runtime %j with a stale Claude record", async (runtime) => {
    const f = await claimedUnknown();
    f.db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, f.claimed.nodeId);
    f.sessionRegistry.updateResumeToken(f.claimed.sessionId, "claude_id", "fixture-stale-claude", "operator");
    const result = await f.resolve();
    expect(result.resolved).toBe(false);
    expect(result).not.toHaveProperty("token");
  });
});
