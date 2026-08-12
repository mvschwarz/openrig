import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { transportRoutes } from "../src/routes/transport.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle\n❯ "),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
  } as unknown as TmuxAdapter;
}

function createApp(deps: { sessionTransport: SessionTransport; outboxHandler?: OutboxHandler }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionTransport" as never, deps.sessionTransport);
    if (deps.outboxHandler) c.set("outboxHandler" as never, deps.outboxHandler);
    await next();
  });
  app.route("/api/transport", transportRoutes());
  return app;
}

describe("transport routes", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("my-rig");
    const node1 = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const sess1 = sessionRegistry.registerSession(node1.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(sess1.id, "running");
    sessionRegistry.updateBinding(node1.id, { tmuxSession: "dev-impl@my-rig" });

    const node2 = rigRepo.addNode(rig.id, "dev.qa", { role: "worker", runtime: "codex" });
    const sess2 = sessionRegistry.registerSession(node2.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(sess2.id, "running");
    sessionRegistry.updateBinding(node2.id, { tmuxSession: "dev-qa@my-rig" });
    return { rig, node1, node2 };
  }

  function seedExternalCliRig() {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", { role: "orchestrator", runtime: "claude-code" });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });
    return { rig, node, session };
  }

  it("POST /send with valid session returns 200 with SendResult", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionName).toBe("dev-impl@my-rig");
  });

  // ── A3 (P22) — auto-record dispatched sends into the sender-side outbox, so a DERIVED send cannot
  //    accept-and-drop at the audit layer (the specimen-5 window: no outbox row, attribution survived
  //    only via provider JSONL). Strictly DOWNSTREAM of the certified header-derivation (uses the
  //    already-derived actor, never re-derives). ──
  function outboxRows(): Array<Record<string, unknown>> {
    return db.prepare("SELECT * FROM outbox_entries ORDER BY rowid").all() as Array<Record<string, unknown>>;
  }
  function sendApp() {
    // createFullTestDb excludes 027 (outbox is not on the shared core edge — P24); migrate it inline,
    // plus the 067 identity_provenance column (outbox part), so the auto-record can stamp the era.
    migrate(db, [outboxEntriesSchema]);
    const hasProv = (db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>)
      .some((c) => c.name === "identity_provenance");
    if (!hasProv) db.exec("ALTER TABLE outbox_entries ADD COLUMN identity_provenance TEXT");
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() });
    return createApp({ sessionTransport: transport, outboxHandler: new OutboxHandler(db) });
  }

  it("A3 — a DERIVED send auto-records exactly ONE outbox row (sender=derived actor, provenance=transport:v1)", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1); // exactly one, not zero, not two
    expect(rows[0]!["sender_session"]).toBe("orch@my-rig"); // the DERIVED actor, never a body claim
    expect(rows[0]!["destination_session"]).toBe("dev-impl@my-rig");
    expect(rows[0]!["body"]).toBe("hello");
    expect(rows[0]!["identity_provenance"]).toBe("transport:v1"); // era-stamp from the run, not hardcoded-lying
  });

  it("A3 — a cross-host send records the ORIGIN triple (the derived header), never the relay's seat", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@rig-a@origin-host" }, // 3-part origin (A2/A4 carry)
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "coordinate" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["sender_session"]).toBe("orch@rig-a@origin-host"); // ORIGIN triple, not the relay
  });

  // Was: "a REFUSED send writes NO outbox row". The refusal class is RULED DELETED
  // (PM (A), 2026-08-11) — a disagreeing body claim is superseded, not refused — so
  // the send now DELIVERS and the row records the wire identity. What this pin is
  // for is unchanged: the body claim must never reach the ledger.
  it("A3 — a send whose body actor differs is DELIVERED, and the outbox row carries the HEADER identity", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hi", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["sender_session"]).toBe("orch@my-rig");
    expect(rows[0]!["sender_session"]).not.toContain("mallory");
  });

  // 5.1 RELEASE BLOCKER (L5 leg A3, reproduced at route level): 51-09 appended the
  // origin host to the transport identity, so the header carries a TRIPLE while the
  // body still carries the PAIR. Those values do NOT disagree — the triple is the
  // same actor with its origin added — but a literal string comparison read it as a
  // mismatch and 409'd the first real cross-host send at the SAME SHA.
  it("L5 A3 — header TRIPLE + body PAIR delivers, and records the WIRE identity (not the body claim)", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch-main@rig-a@host-a16b0df1" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "cross-host probe", actorSession: "orch-main@rig-a" }),
    });
    expect(res.status).toBe(200); // was 409 identity_mismatch — the release blocker
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    // provenance unchanged: the WIRE decides the actor and the body never does. If the
    // body PAIR leaked into the recorded sender, deleting the guard would be wrong.
    expect(rows[0]!["sender_session"]).toBe("orch-main@rig-a@host-a16b0df1");
    expect(rows[0]!["sender_session"]).not.toBe("orch-main@rig-a");
  });

  it("L5 A3 — a body claim naming a DIFFERENT actor is SUPERSEDED, never trusted, and never refuses", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hi", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["sender_session"]).toBe("orch@my-rig"); // wire wins
    expect(rows[0]!["sender_session"]).not.toContain("mallory"); // body DISCARDED, not recorded
  });

  it("A3 — a header-LESS send (no derived actor) auto-records NO row (nothing to attribute; no fabricated sender)", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no X-OpenRig-Session
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hi" }),
    });
    expect(res.status).toBe(200); // delivers (non-interactive send tolerates a null actor)
    expect(outboxRows()).toHaveLength(0); // but no derived sender ⇒ no auto-record, never a null-sender row
  });

  // ── A3b (P22 follow-on, planner-ruled IN scope) — the /broadcast fan-out auto-records N rows, ONE per
  //    RESOLVED recipient (the schema's typed+indexed destination_session + per-row delivery_state is a
  //    per-recipient design; a TargetSpec would poison the typed column). Same downstream-of-derivation
  //    shape as /send. ──
  it("A3b — a broadcast auto-records N rows, one per RESOLVED recipient (sender=derived, provenance=transport:v1, destination=each session, never the TargetSpec)", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ rig: "my-rig", text: "team update" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(2); // one per resolved recipient, NOT one broadcast row
    expect(rows.map((r) => r["destination_session"]).sort()).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    for (const r of rows) {
      expect(r["sender_session"]).toBe("orch@my-rig"); // the DERIVED actor, per row
      expect(r["identity_provenance"]).toBe("transport:v1");
      expect(String(r["destination_session"])).not.toContain("rig:"); // a resolved session, never the TargetSpec
      expect(r["delivery_state"]).toBe("delivered"); // all landed (mockTmux) ⇒ per-row state
    }
  });

  it("A3b — a PARTIAL fan-out records per-row delivery_state (delivered vs failed) — the truth one row could not express", async () => {
    seedRig();
    const transport = new SessionTransport({
      db, rigRepo, sessionRegistry,
      // dev-qa's pane is missing ⇒ its send fails; dev-impl lands. A partial fan-out.
      tmuxAdapter: mockTmux({ hasSession: async (name: string) => name !== "dev-qa@my-rig" }),
    });
    migrate(db, [outboxEntriesSchema]);
    if (!(db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some((c) => c.name === "identity_provenance")) {
      db.exec("ALTER TABLE outbox_entries ADD COLUMN identity_provenance TEXT");
    }
    const app = createApp({ sessionTransport: transport, outboxHandler: new OutboxHandler(db) });
    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ rig: "my-rig", text: "team update" }),
    });
    expect(res.status).toBe(200);
    const byDest = Object.fromEntries(outboxRows().map((r) => [r["destination_session"], r["delivery_state"]]));
    expect(byDest["dev-impl@my-rig"]).toBe("delivered");
    expect(byDest["dev-qa@my-rig"]).toBe("failed"); // per-recipient truth, not a lossy aggregate
  });

  // Same conversion on the fan-out path (the second deleted guard, transport.ts:223).
  it("A3b — a broadcast whose body actor differs is DELIVERED, and every row carries the HEADER identity", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ rig: "my-rig", text: "hi", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row["sender_session"]).toBe("orch@my-rig");
      expect(row["sender_session"]).not.toContain("mallory");
    }
  });

  it("A3b — a header-LESS broadcast auto-records NO rows (no derived sender to attribute)", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig", text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(outboxRows()).toHaveLength(0);
  });

  // OPR.99.0.6.3 — the additive outcome field auto-surfaces through the
  // c.json(result) passthrough; failure HTTP mapping unchanged.
  it("POST /send with verify surfaces the outcome field in the JSON response (passthrough)", async () => {
    seedRig();
    // Pre-existing pane content means the post-capture cannot re-confirm:
    // the redraw-race middle outcome.
    const tmux = {
      ...mockTmux(),
      capturePaneContent: async () => "idle\nhello\n❯ ",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", verify: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.outcome).toBe("rendered-unconfirmed");
  });

  it("POST /send verify failure stays HTTP-error-distinct from the middle outcome (discriminator)", async () => {
    seedRig();
    const tmux = {
      ...mockTmux(),
      sendKeys: async () => ({ ok: false as const, code: "session_not_found", message: "session died" }),
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", verify: true }),
    });
    // submit_failed maps to 502 (unchanged); the middle outcome above is 200.
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("submit_failed");
    expect(body.outcome).toBe("failed");
  });

  it("POST /send to a mid-work pane returns 200 and DELIVERS with a non-blocking advisory (OPR.0.4.3.28 fast-follow — mid_work downgraded)", async () => {
    seedRig();
    const tmux = {
      ...mockTmux(),
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warning).toContain("mid-task");
  });

  // OPR.0.4.1.10 — prompt/permission guard surfaces through the route as 409 target_needs_input.
  it("POST /send to an interactive prompt returns 409 target_needs_input (default, no override)", async () => {
    seedRig();
    const tmux = { ...mockTmux(), capturePaneContent: async () => "❯ 1. Authorize\n  2. Hold" } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });
    const res = await app.request("/api/transport/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "stand down" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("target_needs_input");
  });

  // OPR.0.4.1.10 — the route rejects contradictory / unauditable override requests before transport.
  it("POST /send rejects --dangerously-interact + --wait-for-idle with 400", async () => {
    seedRig();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() });
    const app = createApp({ sessionTransport: transport });
    const res = await app.request("/api/transport/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "x", dangerouslyInteract: true, reason: "y", waitForIdleMs: 1000 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("invalid_dangerously_interact");
  });

  it("POST /send rejects --dangerously-interact without a reason with 400", async () => {
    seedRig();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() });
    const app = createApp({ sessionTransport: transport });
    const res = await app.request("/api/transport/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "x", dangerouslyInteract: true }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("dangerously_interact_requires_reason");
  });

  it("POST /send with waitForIdleMs waits for idle and returns activity evidence", async () => {
    seedRig();
    let captureCount = 0;
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        return captureCount === 1
          ? "Working on task...\n⠋ Processing\nesc to interrupt"
          : "› Use /skills to list available skills\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig";
      },
      sendText: sendTextSpy,
    });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", waitForIdleMs: 50 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(true);
    expect(body.attempts).toBe(2);
    expect(body.activity.state).toBe("idle");
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "hello");
  });

  it("POST /send rejects force with waitForIdleMs before sending", async () => {
    seedRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux({ sendText: sendTextSpy }),
    });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", force: true, waitForIdleMs: 50 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_wait_for_idle");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("POST /send maps wait timeout to 409 without sending text", async () => {
    seedRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux,
      waitForIdlePollMs: 1,
    });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", waitForIdleMs: 1 }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("wait_for_idle_timeout");
    expect(body.sent).toBe(false);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("POST /send with ambiguous session returns 409", async () => {
    // Create two rigs, both with same canonical session name
    const rig1 = rigRepo.createRig("rig-a");
    const node1 = rigRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = rigRepo.createRig("rig-b");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@shared", text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("ambiguous");
  });

  it("POST /send to external_cli target returns 409 with honest transport guidance", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "orch1-lead@rigged-buildout", text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("transport_unavailable");
    expect(body.error).toContain("external CLI");
  });

  it("POST /capture with rig targeting returns multi-session results", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toBeDefined();
    expect(body.results.length).toBe(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it("POST /capture with rig targeting includes external_cli targets as explicit failures", async () => {
    seedRig();
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "rigged-buildout" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.ok).toBe(false);
    expect(body.results[0]!.reason).toBe("transport_unavailable");
  });

  it("POST /capture for external_cli target returns 409 with honest transport guidance", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "orch1-lead@rigged-buildout" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("transport_unavailable");
    expect(body.error).toContain("external CLI");
  });

  it("POST /broadcast without rig/pod broadcasts globally to all running sessions", async () => {
    seedRig(); // creates my-rig with dev-impl@my-rig and dev-qa@my-rig
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "global message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(2);
  });

  it("POST /broadcast with partial failure returns honest per-target outcomes", async () => {
    seedRig();
    let callCount = 0;
    const tmux = {
      ...mockTmux(),
      hasSession: async () => true,
      sendText: async () => {
        callCount++;
        // Second send fails
        if (callCount > 1) return { ok: false as const, code: "err", message: "failed" };
        return { ok: true as const };
      },
      capturePaneContent: async () => "idle\n❯ ",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig", text: "broadcast message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);
  });

  // OPR.0.4.3.30 — `rig send` fan-out via /broadcast: explicit list target + per-recipient envelope.
  // CONTRACT CHANGE (ruling 03c35295, review-visible): a `sessions` multi-send now renders the FULL
  // recipient list on EVERY recipient's To line — the anti-storm behavior (each recipient sees WHO
  // ELSE got it, so it never re-forwards to peers who already have it). This SUPERSEDES the prior
  // per-recipient-isolated To (B1); the wrap is still per-recipient (own From + reply hint), only the
  // To projection changed from <that seat> to <full list>.
  it("POST /broadcast with a sessions list renders the FULL recipient list on every To (anti-storm, B1)", async () => {
    seedRig(); // dev-impl@my-rig + dev-qa@my-rig
    const delivered: string[] = [];
    const tmux = mockTmux({ sendText: async (_target: string, text: string) => { delivered.push(text); return { ok: true as const }; } });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21: From: derives from the header
      body: JSON.stringify({
        sessions: ["dev-impl@my-rig", "dev-qa@my-rig"],
        text: "hello team",
        force: true,
        envelopeSender: "orch@my-rig",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(2);
    expect(delivered).toHaveLength(2);
    // Both recipients get the SAME full-list To (WHO got it) — the anti-storm teeth.
    for (const text of delivered) {
      expect(text).toContain("To: dev-impl@my-rig, dev-qa@my-rig");
      expect(text).toContain("From: orch@my-rig"); // still per-recipient wrapped (own From + reply)
      expect(text).toContain("---\nhello team\n---");
    }
  });

  it("POST /broadcast WITHOUT envelopeSender delivers raw text to all (rig broadcast unchanged)", async () => {
    seedRig();
    const delivered: string[] = [];
    const tmux = mockTmux({ sendText: async (_target: string, text: string) => { delivered.push(text); return { ok: true as const }; } });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig", text: "raw msg", force: true }),
    });
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(2);
    expect(delivered.every((t) => t === "raw msg")).toBe(true);
    expect(delivered.some((t) => t.includes("To:"))).toBe(false);
  });

  it("POST /broadcast with an unknown seat in the list rejects honestly, naming the seat", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: ["dev-impl@my-rig", "ghost@my-rig"], text: "x", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.results[0].error).toContain("ghost@my-rig");
  });

  it("POST /broadcast list: one recipient failing does NOT abort the others (independence)", async () => {
    seedRig();
    let n = 0;
    const tmux = mockTmux({
      sendText: async () => { n++; return n > 1 ? { ok: false as const, code: "e", message: "boom" } : { ok: true as const }; },
    });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21: From: derives from the header
      body: JSON.stringify({ sessions: ["dev-impl@my-rig", "dev-qa@my-rig"], text: "x", force: true, envelopeSender: "orch@my-rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);
  });

  it("POST /broadcast list keeps per-recipient send guard semantics for unknown telemetry and picker refusal", async () => {
    seedRig();
    const delivered: string[] = [];
    const tmux = mockTmux({
      capturePaneContent: async (target: string) => {
        if (target === "dev-impl@my-rig") {
          return "OpenRig pane capture failed before activity could be classified";
        }
        return [
          "Would you like to run the following command?",
          "❯ 1. Yes, continue",
          "  2. No, cancel",
          "Enter to select · Esc to cancel",
        ].join("\n");
      },
      sendText: async (target: string, text: string) => {
        delivered.push(`${target}:${text}`);
        return { ok: true as const };
      },
    });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21: From: derives from the header
      body: JSON.stringify({
        sessions: ["dev-impl@my-rig", "dev-qa@my-rig"],
        text: "union seam",
        envelopeSender: "orch@my-rig",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);

    const impl = body.results.find((r: { sessionName: string }) => r.sessionName === "dev-impl@my-rig");
    const qa = body.results.find((r: { sessionName: string }) => r.sessionName === "dev-qa@my-rig");
    expect(impl).toMatchObject({ ok: true, sessionName: "dev-impl@my-rig" });
    expect(impl.warning).toContain("producer-link:");
    expect(impl.warning).toContain("sent anyway (telemetry is advisory)");
    expect(qa).toMatchObject({ ok: false, sessionName: "dev-qa@my-rig", reason: "target_needs_input" });
    expect(qa.error).toContain("--dangerously-interact --reason");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("dev-impl@my-rig:");
    expect(delivered[0]).toContain("To: dev-impl@my-rig");
  });

  it("POST /broadcast plumbs danger/reason/actorSession to EACH recipient send (per-seat, not per-batch)", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const sendSpy = vi.spyOn(transport, "send");
    const app = createApp({ sessionTransport: transport });

    await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21: From: derives from the header
      body: JSON.stringify({
        sessions: ["dev-impl@my-rig", "dev-qa@my-rig"],
        text: "unblock please",
        dangerouslyInteract: true,
        reason: "drive the stuck prompt",
        actorSession: "orch@my-rig",
      }),
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    for (const call of sendSpy.mock.calls) {
      expect(call[2]).toMatchObject({
        dangerouslyInteract: true,
        reason: "drive the stuck prompt",
        actorSession: "orch@my-rig",
      });
    }
  });

  it("POST /broadcast includes external_cli targets as explicit transport_unavailable failures", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "rigged-buildout", text: "broadcast message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.reason).toBe("transport_unavailable");
  });

  // ── P21 I4: the rendered From: + the override audit actor derive from the transport, never the body ──
  it("P21 I4: the From: line derives from the transport header, IGNORING a forged body.envelopeSender (specimen-5 kill)", async () => {
    seedRig();
    const delivered: string[] = [];
    const tmux = mockTmux({ sendText: async (_t: string, text: string) => { delivered.push(text); return { ok: true as const }; } });
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux }) });
    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // the REAL sender
      body: JSON.stringify({ sessions: ["dev-impl@my-rig"], text: "hi", force: true, envelopeSender: "pm-lead@my-rig" }), // FORGED From:
    });
    expect(res.status).toBe(200);
    for (const text of delivered) {
      expect(text).toContain("From: orch@my-rig"); // the transport identity, NOT the forged pm-lead claim
      expect(text).not.toContain("From: pm-lead@my-rig"); // the false From: the incident acted upon never renders
    }
  });

  it("P21 I4: an enveloped send with NO authenticated identity refuses-loud (never renders an unverified From:)", async () => {
    seedRig();
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() }) });
    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // NO X-OpenRig-Session
      body: JSON.stringify({ sessions: ["dev-impl@my-rig"], text: "hi", force: true, envelopeSender: "anyone@my-rig" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unattributable_sender");
  });

  it("P21 I4: --dangerously-interact with NO identity refuses-loud (the override audit must be attributable)", async () => {
    seedRig();
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() }) });
    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // NO X-OpenRig-Session
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "drive it", dangerouslyInteract: true, reason: "why" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unattributable_sender");
  });

  it("P21 I4: a body actorSession that DIFFERS from the header is SUPERSEDED (no identity_mismatch refusal)", async () => {
    seedRig();
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() }) });
    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "x", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    // the refusal is gone from this path entirely — not merely a different status
    expect(JSON.stringify(await res.json())).not.toContain("identity_mismatch");
  });
});
