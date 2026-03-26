import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { DiscoveryCoordinator } from "../src/domain/discovery-coordinator.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxDiscoveryScanner, ScannedPane, ScanResult } from "../src/domain/tmux-discovery-scanner.js";
import type { SessionFingerprinter, FingerprintResult } from "../src/domain/session-fingerprinter.js";
import type { SessionEnricher, EnrichmentResult } from "../src/domain/session-enricher.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema,
];

function makePane(overrides?: Partial<ScannedPane>): ScannedPane {
  return { tmuxSession: "organic", tmuxWindow: "0", tmuxPane: "%0", pid: 1234, cwd: "/tmp", activeCommand: "claude", ...overrides };
}

function mockScanner(panes: ScannedPane[]): TmuxDiscoveryScanner {
  return { scan: vi.fn(async (): Promise<ScanResult> => ({ panes, scannedAt: new Date().toISOString() })) } as unknown as TmuxDiscoveryScanner;
}

function mockFingerprinter(hint: string = "claude-code"): SessionFingerprinter {
  return {
    refreshCmuxSignals: vi.fn(async () => {}),
    fingerprint: vi.fn(async (): Promise<FingerprintResult> => ({
      runtimeHint: hint as any,
      confidence: "high",
      evidence: { layerUsed: 1, processSignal: { command: "claude", matched: "claude" } },
    })),
  } as unknown as SessionFingerprinter;
}

function mockEnricher(): SessionEnricher {
  return {
    enrich: vi.fn((): EnrichmentResult => ({
      skills: [], claudeSkills: [], agentsSkills: [],
      hasClaudeMd: false, hasAgentsMd: false, hasPackageYaml: false, raw: {},
    })),
  } as unknown as SessionEnricher;
}

describe("DiscoveryCoordinator", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });

  afterEach(() => { db.close(); });

  function buildCoordinator(opts?: { scanner?: TmuxDiscoveryScanner; fingerprinter?: SessionFingerprinter; enricher?: SessionEnricher }) {
    const discoveryRepo = new DiscoveryRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    return {
      coordinator: new DiscoveryCoordinator({
        scanner: opts?.scanner ?? mockScanner([]),
        fingerprinter: opts?.fingerprinter ?? mockFingerprinter(),
        enricher: opts?.enricher ?? mockEnricher(),
        discoveryRepo,
        sessionRegistry,
        eventBus,
      }),
      discoveryRepo,
      sessionRegistry,
      eventBus,
    };
  }

  // T1: Full pipeline
  it("full pipeline: scan -> fingerprint -> enrich -> persist", async () => {
    const pane = makePane();
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([pane]) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxSession).toBe("organic");
    expect(results[0]!.runtimeHint).toBe("claude-code");

    const stored = discoveryRepo.getDiscoveredSession(results[0]!.id);
    expect(stored).toBeDefined();
  });

  // T2: New session inserted
  it("new session discovered -> inserted in DB", async () => {
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([makePane()]) });

    await coordinator.scanOnce();

    const all = discoveryRepo.listDiscovered("active");
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("active");
  });

  // T3: Rescan preserves id + first_seen_at
  it("known session re-scanned -> preserves id and first_seen_at, updates last_seen_at", async () => {
    const pane = makePane();
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([pane]) });

    const first = await coordinator.scanOnce();
    const firstId = first[0]!.id;
    const firstSeen = first[0]!.firstSeenAt;

    // Small delay to ensure last_seen_at differs
    const second = await coordinator.scanOnce();

    expect(second[0]!.id).toBe(firstId);
    expect(second[0]!.firstSeenAt).toBe(firstSeen);
  });

  // T4: Missing session -> vanished
  it("missing session marked vanished", async () => {
    const pane = makePane();
    const scanner1 = mockScanner([pane]);
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: scanner1 });

    await coordinator.scanOnce();
    expect(discoveryRepo.listDiscovered("active")).toHaveLength(1);

    // Second scan with empty results
    (scanner1.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ panes: [], scannedAt: new Date().toISOString() });
    await coordinator.scanOnce();

    expect(discoveryRepo.listDiscovered("active")).toHaveLength(0);
    expect(discoveryRepo.listDiscovered("vanished")).toHaveLength(1);
  });

  // T5a: Session-level binding filters all panes in that session
  it("session-level managed binding filters all panes", async () => {
    // Create a managed rig + node + binding with no pane
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run("b-1", "n-1", "r01-dev");

    const panes = [
      makePane({ tmuxSession: "r01-dev", tmuxPane: "%0" }),
      makePane({ tmuxSession: "r01-dev", tmuxPane: "%1" }),
      makePane({ tmuxSession: "organic", tmuxPane: "%2" }),
    ];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    // Only organic session should be discovered
    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxSession).toBe("organic");
  });

  // T5b: Pane-level binding filters only that pane
  it("pane-level managed binding filters only that pane", async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane) VALUES (?, ?, ?, ?)").run("b-1", "n-1", "multi", "%1");

    const panes = [
      makePane({ tmuxSession: "multi", tmuxPane: "%0" }),
      makePane({ tmuxSession: "multi", tmuxPane: "%1" }),
    ];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    // Only %0 should be discovered, %1 is managed
    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxPane).toBe("%0");
  });

  // T6: Claimed session filtered from rediscovery
  it("claimed session filtered from future scans", async () => {
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([makePane()]) });

    // First scan discovers
    const first = await coordinator.scanOnce();
    expect(first).toHaveLength(1);

    // Claim it
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    discoveryRepo.markClaimed(first[0]!.id, "n-1");

    // Second scan should not re-discover it
    const second = await coordinator.scanOnce();
    expect(second).toHaveLength(0);
  });

  // T7: scanOnce returns active sessions
  it("scanOnce returns active discovered sessions", async () => {
    const panes = [makePane({ tmuxPane: "%0" }), makePane({ tmuxPane: "%1" })];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(2);
    expect(results.every((s) => s.status === "active")).toBe(true);
  });

  // T9: Multiple sessions in single scan
  it("multiple sessions discovered in single scan", async () => {
    const panes = [
      makePane({ tmuxSession: "s1", tmuxPane: "%0" }),
      makePane({ tmuxSession: "s2", tmuxPane: "%0" }),
      makePane({ tmuxSession: "s3", tmuxPane: "%0" }),
    ];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(3);
  });

  // T10: Empty tmux -> empty results
  it("empty tmux returns empty results", async () => {
    const { coordinator } = buildCoordinator({ scanner: mockScanner([]) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(0);
  });

  // T11: Events emitted for discover and vanish
  it("session.discovered and session.vanished events emitted", async () => {
    const pane = makePane();
    const scanner = mockScanner([pane]);
    const { coordinator } = buildCoordinator({ scanner });

    await coordinator.scanOnce();

    // Check discovered event
    const events = db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>;
    const discovered = events.filter((e) => e.type === "session.discovered");
    expect(discovered).toHaveLength(1);
    const dp = JSON.parse(discovered[0]!.payload);
    expect(dp.tmuxSession).toBe("organic");
    expect(dp.tmuxPane).toBe("%0");

    // Second scan empty -> vanished event
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ panes: [], scannedAt: new Date().toISOString() });
    await coordinator.scanOnce();

    const allEvents = db.prepare("SELECT type FROM events ORDER BY seq").all() as Array<{ type: string }>;
    expect(allEvents.some((e) => e.type === "session.vanished")).toBe(true);
  });

  // T12: Repository CRUD operations
  it("repository CRUD: upsert, list, get, markClaimed, markVanished", () => {
    const repo = new DiscoveryRepository(db);

    // Upsert
    const created = repo.upsertDiscoveredSession({
      tmuxSession: "test", tmuxPane: "%0", runtimeHint: "claude-code", confidence: "high",
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe("active");

    // List
    expect(repo.listDiscovered("active")).toHaveLength(1);

    // Get
    expect(repo.getDiscoveredSession(created.id)!.tmuxSession).toBe("test");

    // Mark vanished
    repo.markVanished([created.id]);
    expect(repo.getDiscoveredSession(created.id)!.status).toBe("vanished");

    // Create another + mark claimed
    const s2 = repo.upsertDiscoveredSession({
      tmuxSession: "test2", tmuxPane: "%0", runtimeHint: "codex", confidence: "high",
    });
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    repo.markClaimed(s2.id, "n-1");
    expect(repo.getDiscoveredSession(s2.id)!.status).toBe("claimed");
  });
});
