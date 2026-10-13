// OPR.0.4.0.22 FR-1b/FR-2/FR-5 — POST /api/sessions/:sessionName/resume-token.
// Managed/attested/audited resume-token set, with per-runtime validation,
// credential redaction across response/error/event, and terminalAuthGuard.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";

function seedRigNodes(db: Database.Database) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)").run("node-1", "rig-1", "dev1.impl", "worker", "claude-code");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)").run("node-2", "rig-1", "dev1.qa", "qa", "codex");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)").run("node-3", "rig-1", "infra.term", "infra", "terminal");
}

function post(app: { request: (p: string, init?: RequestInit) => Promise<Response> }, name: string, body: unknown, headers?: Record<string, string>) {
  return app.request(`/api/sessions/${encodeURIComponent(name)}/resume-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

function resumeTokenEvents(db: Database.Database): Array<Record<string, unknown>> {
  return (db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_set'").all() as { payload: string }[])
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

describe("POST /api/sessions/:sessionName/resume-token", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
    seedRigNodes(db);
  });
  afterEach(() => { db.close(); });

  it("sets a claude token (operator provenance), redacts the token, emits an audit event", async () => {
    const { app, sessionRegistry } = createTestApp(db);
    sessionRegistry.registerSession("node-1", "dev1-impl@test-rig");

    const res = await post(app, "dev1-impl@test-rig", { token: "claude-sess-abc123", reason: "founder re-authed, confirmed live" });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.resumeType).toBe("claude_id");
    expect(json.provenance).toBe("operator");
    // Redaction: the response NEVER carries the raw token.
    expect(JSON.stringify(json)).not.toContain("claude-sess-abc123");

    // Persisted with operator provenance.
    const ctx = sessionRegistry.findResumeContextByName("dev1-impl@test-rig");
    expect(ctx?.currentProvenance).toBe("operator");
    const row = db.prepare("SELECT resume_token, resume_type FROM sessions WHERE id = ?").get(ctx!.sessionId) as { resume_token: string; resume_type: string };
    expect(row.resume_token).toBe("claude-sess-abc123");
    expect(row.resume_type).toBe("claude_id");

    // Audit event present, with required fields and NO raw token.
    const events = resumeTokenEvents(db);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.source).toBe("operator_set");
    expect(ev.newProvenance).toBe("operator");
    expect(ev.resumeType).toBe("claude_id");
    expect(ev.reason).toBe("founder re-authed, confirmed live");
    expect(ev.redacted).toBe(true);
    expect(JSON.stringify(ev)).not.toContain("claude-sess-abc123");
  });

  it("operator set OUTRANKS an existing hook token", async () => {
    const { app, sessionRegistry } = createTestApp(db);
    const s = sessionRegistry.registerSession("node-1", "dev1-impl@test-rig");
    sessionRegistry.updateResumeToken(s.id, "claude_id", "hook-token", "hook");

    const res = await post(app, "dev1-impl@test-rig", { token: "operator-token", reason: "manual set" });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT resume_token, resume_provenance FROM sessions WHERE id = ?").get(s.id) as { resume_token: string; resume_provenance: string };
    expect(row.resume_token).toBe("operator-token");
    expect(row.resume_provenance).toBe("operator");
  });

  describe("replacement session targeting", () => {
    let clock = Date.UTC(2100, 0, 1);

    beforeEach(() => {
      clock += 60_000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(clock);
      // Control both production clock reads without patching session IDs or rows.
      db.function("datetime", (value: string) => {
        expect(value).toBe("now");
        return new Date().toISOString().replace("T", " ").slice(0, 19);
      });
    });
    afterEach(() => { vi.useRealTimers(); });

    describe.each([
      ["forward", 2_000], ["same millisecond", 0], ["rollback", -2_000],
    ] as const)("after a %s clock", (_name, delta) => {
      it.each(["running", "exited"])("writes only the latest %s registration", async (status) => {
        const { app, sessionRegistry } = createTestApp(db);
        const name = "dev1-impl@test-rig";
        const old = sessionRegistry.registerSession("node-1", name);
        sessionRegistry.updateResumeToken(old.id, "claude_id", "historical-token", "adoption");
        sessionRegistry.markSuperseded(old.id);
        const historical = db.prepare("SELECT * FROM sessions WHERE id = ?").get(old.id);
        vi.setSystemTime(clock + delta);
        const current = sessionRegistry.registerSession("node-1", name);
        sessionRegistry.updateStatus(current.id, status);
        sessionRegistry.updateResumeToken(current.id, "claude_id", "current-hook-token", "hook");
        expect(current.id > old.id).toBe(true);
        if (delta < 0) expect(current.createdAt < old.createdAt).toBe(true);

        const res = await post(app, name, { token: "operator-token", reason: "verified current conversation" });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect.soft(json).toMatchObject({ ok: true, resumeType: "claude_id", previousProvenance: "hook" });
        expect(JSON.stringify(json)).not.toContain("operator-token");
        expect.soft(db.prepare("SELECT resume_token, resume_provenance FROM sessions WHERE id = ?").get(current.id))
          .toEqual({ resume_token: "operator-token", resume_provenance: "operator" });
        expect.soft(db.prepare("SELECT * FROM sessions WHERE id = ?").get(old.id)).toEqual(historical);
        expect.soft(resumeTokenEvents(db)).toEqual([expect.objectContaining({
          sessionId: current.id, previousProvenance: "hook", redacted: true,
        })]);
        expect(JSON.stringify(resumeTokenEvents(db))).not.toContain("operator-token");
      });
    });
  });

  it("rejects a malformed token (422) WITHOUT echoing it, and does not persist", async () => {
    const { app, sessionRegistry } = createTestApp(db);
    const s = sessionRegistry.registerSession("node-1", "dev1-impl@test-rig");

    const evil = "tok; rm -rf / #";
    const res = await post(app, "dev1-impl@test-rig", { token: evil, reason: "x" });
    expect(res.status).toBe(422);
    const json = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toContain("rm -rf");
    expect(JSON.stringify(json)).not.toContain(evil);
    // Not persisted.
    const row = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(s.id) as { resume_token: string | null };
    expect(row.resume_token).toBeNull();
    expect(resumeTokenEvents(db).length).toBe(0);
  });

  it("requires --reason (400 when missing)", async () => {
    const { app, sessionRegistry } = createTestApp(db);
    sessionRegistry.registerSession("node-1", "dev1-impl@test-rig");
    const res = await post(app, "dev1-impl@test-rig", { token: "claude-tok" });
    expect(res.status).toBe(400);
  });

  it("404 when the session is not found", async () => {
    const { app } = createTestApp(db);
    const res = await post(app, "ghost@test-rig", { token: "claude-tok", reason: "x" });
    expect(res.status).toBe(404);
  });

  it("422 for a runtime with no resume token (terminal)", async () => {
    const { app, sessionRegistry } = createTestApp(db);
    sessionRegistry.registerSession("node-3", "infra-term@test-rig");
    const res = await post(app, "infra-term@test-rig", { token: "anything", reason: "x" });
    expect(res.status).toBe(422);
  });

  it("AC-6: the route REQUIRES terminalAuthGuard (401 without the bearer, OK with it)", async () => {
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    sessionRegistry.registerSession("node-1", "dev1-impl@test-rig");

    const authApp = new Hono();
    authApp.use("*", async (c, next) => {
      c.set("terminalBearerToken" as never, "secret-terminal-token");
      c.set("sessionRegistry" as never, sessionRegistry);
      c.set("eventBus" as never, eventBus);
      await next();
    });
    authApp.route("/api/sessions", sessionAdminRoutes);

    const noAuth = await post(authApp, "dev1-impl@test-rig", { token: "claude-tok", reason: "x" });
    expect(noAuth.status).toBe(401);

    const withAuth = await post(authApp, "dev1-impl@test-rig", { token: "claude-tok", reason: "x" }, { Authorization: "Bearer secret-terminal-token" });
    expect(withAuth.status).toBe(200);
  });
});
