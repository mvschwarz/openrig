import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmuxAdapter(
  sessionExists: Record<string, boolean>,
  errors?: Record<string, Error>
): TmuxAdapter {
  return {
    hasSession: async (name: string) => {
      if (errors?.[name]) {
        throw errors[name];
      }
      return sessionExists[name] ?? false;
    },
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("Reconciler", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function createReconciler(tmux: TmuxAdapter) {
    return new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  }

  function seedRigWithSessions(statuses: { logicalId: string; sessionName: string; status: string }[]) {
    const rig = rigRepo.createRig("r01");
    const nodes: { id: string; logicalId: string }[] = [];
    for (const s of statuses) {
      const node = rigRepo.addNode(rig.id, s.logicalId, { role: "worker" });
      const session = sessionRegistry.registerSession(node.id, s.sessionName);
      sessionRegistry.updateStatus(session.id, s.status);
      nodes.push({ id: node.id, logicalId: s.logicalId });
    }
    return { rig, nodes };
  }

  it("session still alive: tmux confirms, status stays unchanged", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": true }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(0);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  it("session gone: status updated to detached + event emitted", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("detached");

    // Event persisted
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);

    // Subscriber notified
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("session.detached");
  });

  it("no sessions in DB: no changes, no events", async () => {
    const rig = rigRepo.createRig("r01");
    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(0);

    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("already-detached sessions skipped (not re-checked)", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "detached" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    // Not checked — already detached
    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
  });

  it("already-exited sessions skipped (not re-checked)", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "exited" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
  });

  it("multiple nodes: 3 sessions, 2 alive, 1 gone -> only gone one detached", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
      { logicalId: "orch1-lead", sessionName: "r01-orch1-lead", status: "running" },
    ]);

    const reconciler = createReconciler(
      mockTmuxAdapter({
        "r01-dev1-impl": true,
        "r01-dev1-qa": false, // gone
        "r01-orch1-lead": true,
      })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(3);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const qa = sessions.find((s) => s.sessionName === "r01-dev1-qa");
    expect(qa!.status).toBe("detached");
    const impl = sessions.find((s) => s.sessionName === "r01-dev1-impl");
    expect(impl!.status).toBe("running");
  });

  it("idempotent: reconcile twice with same state -> no duplicate events", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));

    await reconciler.reconcile(rig.id);
    const result2 = await reconciler.reconcile(rig.id);

    // Second run: session is already detached, so skipped
    expect(result2.checked).toBe(0);
    expect(result2.detached).toBe(0);

    // Only 1 event total
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);
  });

  it("constructor throws on mismatched db handles", () => {
    const otherDb = createDb();
    migrate(otherDb, [coreSchema, bindingsSessionsSchema, eventsSchema]);
    const otherRegistry = new SessionRegistry(otherDb);

    expect(
      () =>
        new Reconciler({
          db,
          sessionRegistry: otherRegistry,
          eventBus,
          tmuxAdapter: mockTmuxAdapter({}),
        })
    ).toThrow(/same db handle/);

    otherDb.close();
  });

  it("markDetached + event persistence is atomic (sabotage events -> no partial state)", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    // Sabotage events table so persistWithinTransaction fails after markDetached
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    // Should have errored on this session
    expect(result.errors).toHaveLength(1);

    // Session status NOT changed to detached (transaction rolled back)
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  it("unexpected tmux error: session not marked detached, error in result", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(
      mockTmuxAdapter({}, { "r01-dev1-impl": new Error("unexpected tmux failure") })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0); // couldn't check it
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("unexpected tmux failure");

    // Session NOT marked detached
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });
});
