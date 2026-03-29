import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { PersistedEvent } from "../src/domain/types.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, nodeSpecFieldsSchema]);
  return db;
}

function mockTmuxAdapter(overrides?: {
  createSession?: (name: string, cwd?: string) => Promise<TmuxResult>;
  killSession?: (name: string) => Promise<TmuxResult>;
}): TmuxAdapter {
  return {
    createSession: overrides?.createSession ?? (async () => ({ ok: true as const })),
    killSession: overrides?.killSession ?? (async () => ({ ok: true as const })),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("NodeLauncher", () => {
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

  function createLauncher(tmux?: TmuxAdapter) {
    return new NodeLauncher({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux ?? mockTmuxAdapter(),
    });
  }

  function seedRigWithNode() {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl", {
      role: "worker",
      runtime: "claude-code",
    });
    return { rig, node };
  }

  it("happy path: derives name, creates tmux, persists session+binding+event in one txn, notifies", async () => {
    const { rig, node } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledOnce();

    // DB: session exists
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("running");

    // DB: binding exists
    const fullRig = rigRepo.getRig(rig.id);
    const launchedNode = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(launchedNode!.binding).not.toBeNull();

    // DB: event exists
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(1);

    // Subscriber notified
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("node.launched");
  });

  it("derived session name is correct (rig.name + '-' + logicalId)", async () => {
    const { rig } = seedRigWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(rig.id, "dev1-impl");

    expect(createSpy.mock.calls[0]![0]).toBe("r01-dev1-impl");
  });

  it("explicit sessionName override used when provided", async () => {
    const { rig } = seedRigWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(rig.id, "dev1-impl", { sessionName: "r99-custom1-worker" });

    expect(createSpy.mock.calls[0]![0]).toBe("r99-custom1-worker");
  });

  it("valid logical IDs 'orchestrator' and 'worker' produce launchable names", async () => {
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const r1 = await launcher.launchNode(rig.id, "orchestrator");
    const r2 = await launcher.launchNode(rig.id, "worker");

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r01-orchestrator");
    expect(createSpy.mock.calls[1]![0]).toBe("r01-worker");
  });

  it("non-managed rig name is normalized to a managed session name", async () => {
    const rig = rigRepo.createRig("badname");
    rigRepo.addNode(rig.id, "worker");
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "worker");

    expect(result.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r00-badname-worker");
  });

  it("node not found -> error", async () => {
    const rig = rigRepo.createRig("r01");
    const launcher = createLauncher();

    const result = await launcher.launchNode(rig.id, "nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("node_not_found");
    }
  });

  it("node already bound -> error", async () => {
    const { rig, node } = seedRigWithNode();
    // Pre-bind the node
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl" });
    const launcher = createLauncher();

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("already_bound");
    }
  });

  it("tmux createSession fails -> no DB rows", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({
          ok: false as const,
          code: "duplicate_session",
          message: "duplicate session",
        }),
      })
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);

    // No session/binding/event rows
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(0);
    const fullRig = rigRepo.getRig(rig.id);
    const node = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).toBeNull();
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(0);
  });

  it("DB transaction fails after session+binding but before event -> rollback all, killSession attempted", async () => {
    const { rig } = seedRigWithNode();
    const killSpy = vi.fn<(name: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });

    // Sabotage the events table so persistWithinTransaction fails AFTER
    // session + binding inserts have already executed within the transaction.
    // This proves rollback removes the session and binding rows too.
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
        killSession: killSpy,
      })
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);
    // killSession was attempted (tmux cleanup)
    expect(killSpy).toHaveBeenCalledOnce();
    // No partial session rows (rolled back)
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(0);
    // No partial binding rows (rolled back)
    const bindings = db.prepare("SELECT * FROM bindings").all();
    expect(bindings).toHaveLength(0);
    // No event rows (insert failed)
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("event row exists in DB after launch (atomic with session+binding)", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched' AND rig_id = ?")
      .all(rig.id) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.type).toBe("node.launched");
    expect(payload.rigId).toBe(rig.id);
    expect(payload.logicalId).toBe("dev1-impl");
  });

  it("emitted event has correct rigId, nodeId, logicalId, sessionName", async () => {
    const { rig, node } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    expect(notifications).toHaveLength(1);
    const event = notifications[0]!;
    expect(event.type).toBe("node.launched");
    if (event.type === "node.launched") {
      expect(event.rigId).toBe(rig.id);
      expect(event.nodeId).toBe(node.id);
      expect(event.logicalId).toBe("dev1-impl");
      expect(event.sessionName).toBe("r01-dev1-impl");
    }
  });

  it("after launch, getRig shows binding for node", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const fullRig = rigRepo.getRig(rig.id);
    const node = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).not.toBeNull();
    expect(node!.binding!.tmuxSession).toBe("r01-dev1-impl");
  });

  it("after launch, getSessionsForRig shows session with correct name", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionName).toBe("r01-dev1-impl");
  });

  it("exactly 1 event row and exactly 1 subscriber notification (no duplication)", async () => {
    const { rig } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    // Exactly 1 DB row
    const eventRows = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(eventRows).toHaveLength(1);

    // Exactly 1 subscriber notification
    expect(notifications).toHaveLength(1);
  });

  it("constructor throws if services use mismatched db handles", () => {
    const otherDb = createDb();
    migrate(otherDb, [coreSchema, bindingsSessionsSchema, eventsSchema]);
    const otherRepo = new RigRepository(otherDb);

    expect(
      () =>
        new NodeLauncher({
          db,
          rigRepo: otherRepo, // different handle
          sessionRegistry,
          eventBus,
          tmuxAdapter: mockTmuxAdapter(),
        })
    ).toThrow(/same db handle/);

    otherDb.close();
  });
});
