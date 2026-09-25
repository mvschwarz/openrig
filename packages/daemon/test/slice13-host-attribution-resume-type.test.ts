// Slice 13 safe subset (B5): fixes 2 + 3 only — host attribution on node records, and the
// resume_type label derived from the RUNTIME instead of a fixed default. Fix 1 (token value
// surfacing) is deliberately absent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

afterEach(() => setSelfHostId(null));

function seedRig(db: ReturnType<typeof createFullTestDb>) {
  const rigRepo = new RigRepository(db);
  const reg = new SessionRegistry(db);
  const rig = rigRepo.createRig("r");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const sess = reg.registerSession(node.id, "dev-impl@r");
  reg.updateStatus(sess.id, "running");
  return { rigRepo, reg, rig, node, sess };
}

describe("fix 2 — host attribution on node records", () => {
  it("every /nodes row carries the serving daemon's boot-reconciled self-id", async () => {
    const db = createFullTestDb();
    const { rig } = seedRig(db);
    setSelfHostId("host-84c37990");
    const { app } = createTestApp(db);

    const res = await app.request(`/api/rigs/${rig.id}/nodes`);
    expect(res.status).toBe(200);
    const nodes = (await res.json()) as Array<{ hostSelfId?: string | null }>;
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) expect(n.hostSelfId).toBe("host-84c37990");
    db.close();
  });

  it("before the boot reconcile the key is PRESENT with null — unknown is a value, not an absence", async () => {
    const db = createFullTestDb();
    const { rig } = seedRig(db);
    setSelfHostId(null);
    const { app } = createTestApp(db);

    const res = await app.request(`/api/rigs/${rig.id}/nodes`);
    const nodes = (await res.json()) as Array<Record<string, unknown>>;
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect("hostSelfId" in n).toBe(true);
      expect(n.hostSelfId).toBeNull();
    }
    db.close();
  });

  it("node DETAIL carries the same attribution", async () => {
    const db = createFullTestDb();
    const { rig } = seedRig(db);
    setSelfHostId("host-84c37990");
    const { app } = createTestApp(db);

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev.impl`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { hostSelfId?: string | null };
    expect(detail.hostSelfId).toBe("host-84c37990");
    db.close();
  });
});

describe("fix 3 — resume_type derives from the runtime on the identity hook", () => {
  async function postIdentity(app: { request: (p: string, init?: RequestInit) => Promise<Response> }, body: Record<string, unknown>) {
    return app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openrig-activity-token": "tok" },
      body: JSON.stringify({ eventFamily: "session_identity", ...body }),
    });
  }

  it("a claude-code seat's hook stamps claude_id (the lived mislabel: it stamped codex_id)", async () => {
    const db = createFullTestDb();
    seedRig(db);
    const { app } = createTestApp(db, { activityHookToken: "tok" });

    const res = await postIdentity(app, {
      sessionId: "0f6cf1cc-9c4e-4f7e-9d38-1c1f80f9e001",
      sessionName: "dev-impl@r",
      runtime: "claude-code",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tokenPersisted?: boolean }).tokenPersisted).toBe(true);

    const row = db.prepare("SELECT resume_type, resume_token FROM sessions WHERE session_name = ?").get("dev-impl@r") as { resume_type: string; resume_token: string };
    expect(row.resume_type).toBe("claude_id");
    expect(row.resume_token).toBe("0f6cf1cc-9c4e-4f7e-9d38-1c1f80f9e001");
    db.close();
  });

  it("a codex seat's hook still stamps codex_id", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r2");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "codex" });
    const sess = reg.registerSession(node.id, "dev-worker@r2");
    reg.updateStatus(sess.id, "running");
    const { app } = createTestApp(db, { activityHookToken: "tok" });

    const res = await postIdentity(app, { sessionId: "thread-abc-123", sessionName: "dev-worker@r2", runtime: "codex" });
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT resume_type FROM sessions WHERE session_name = ?").get("dev-worker@r2") as { resume_type: string };
    expect(row.resume_type).toBe("codex_id");
    db.close();
  });

  it("rejects a hook claiming a different runtime than the persisted seat", async () => {
    const db = createFullTestDb();
    seedRig(db);
    const { app } = createTestApp(db, { activityHookToken: "tok" });

    const res = await postIdentity(app, { sessionId: "some-id-123", sessionName: "dev-impl@r", runtime: "mystery-runtime" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("runtime_mismatch");

    const row = db.prepare("SELECT resume_type, resume_token FROM sessions WHERE session_name = ?").get("dev-impl@r") as { resume_type: string | null; resume_token: string | null };
    expect(row.resume_type).toBeNull();
    expect(row.resume_token).toBeNull();
    db.close();
  });

  it("does not persist an OMP session-file token against a Pi seat", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r3");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "pi" });
    const sess = reg.registerSession(node.id, "dev-worker@r3");
    reg.updateStatus(sess.id, "running");
    const { app } = createTestApp(db, { activityHookToken: "tok" });

    const res = await postIdentity(app, { sessionId: "rpc-id", sessionName: "dev-worker@r3", runtime: "omp", sessionFile: "/tmp/state/omp/seat/sessions/turn.jsonl" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("runtime_mismatch");
    const row = db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(sess.id) as { resume_type: string | null; resume_token: string | null };
    expect(row.resume_type).toBeNull();
    expect(row.resume_token).toBeNull();
    db.close();
  });

  it("defers an OMP identity token until its session JSONL exists", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r4");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "omp" });
    const sess = reg.registerSession(node.id, "dev-worker@r4");
    reg.updateStatus(sess.id, "running");
    const ownFile = { current: "" };
    const { app } = createTestApp(db, { activityHookToken: "tok", adapters: { omp: { readSessionFile: () => ownFile.current ? { ok: true, sessionFile: ownFile.current } : { ok: false, reason: "missing_sidecar" } } as never } });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-identity-"));
    const sessionFile = path.join(root, "turn.jsonl");
    try {
      const body = { sessionId: "rpc-id", sessionName: "dev-worker@r4", runtime: "omp", sessionFile };
      const before = await postIdentity(app, body);
      expect(await before.json()).toMatchObject({ tokenPersisted: false });
      expect(db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sess.id)).toMatchObject({ resume_token: null });
      fs.writeFileSync(sessionFile, "persisted turn");
      ownFile.current = sessionFile;
      const after = await postIdentity(app, body);
      expect(await after.json()).toMatchObject({ tokenPersisted: true });
      expect(db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(sess.id)).toMatchObject({ resume_type: "omp_session_file", resume_token: sessionFile });
      const otherFile = path.join(root, "other.jsonl");
      fs.writeFileSync(otherFile, "another seat");
      const crossSeat = await postIdentity(app, { ...body, sessionFile: otherFile });
      expect(await crossSeat.json()).toMatchObject({ tokenPersisted: false });
      expect(db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sess.id)).toMatchObject({ resume_token: sessionFile });
      // A different operator token must remain protected and unacknowledged.
      reg.updateResumeToken(sess.id, "omp_session_file", otherFile, "operator");
      const protectedToken = await postIdentity(app, body);
      expect(await protectedToken.json()).toMatchObject({ tokenPersisted: false });
      expect(db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sess.id)).toMatchObject({ resume_token: otherFile });
      // An already matching operator token needs no write or further retry.
      reg.updateResumeToken(sess.id, "omp_session_file", sessionFile, "operator");
      const matchingToken = await postIdentity(app, body);
      expect(await matchingToken.json()).toMatchObject({ tokenPersisted: true });
      expect(db.prepare("SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE id = ?").get(sess.id)).toEqual({ resume_type: "omp_session_file", resume_token: sessionFile, resume_provenance: "operator" });
      // Matching the path alone is insufficient if its stored type differs.
      reg.updateResumeToken(sess.id, "pi_session_file", sessionFile, "operator");
      const wrongType = await postIdentity(app, body);
      expect(await wrongType.json()).toMatchObject({ tokenPersisted: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      db.close();
    }
  });
});
