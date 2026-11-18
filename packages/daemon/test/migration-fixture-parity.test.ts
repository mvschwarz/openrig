import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrationsForFullTestDb, migrationsForFullTestDbExclusions } from "./helpers/test-app.js";
import { assertExplicitSubsetOfAllMigrations } from "./helpers/migration-subset-guard.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { coreAppAccessSchema } from "../src/db/migrations/175_core_app_access.js";
import { nodeInputRouteSchema } from "../src/db/migrations/171_node_input_route.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { readSeatLaunchWrapper } from "../src/domain/launch-wrapper.js";

// P24 — the curated fixture lists must be DECLARED subsets of ALL_MIGRATIONS, not accidental ones.
// A migration added to ALL_MIGRATIONS but forgotten in a curated list now FAILS LOUD with its name +
// the fix, instead of surfacing as a mystery missing column/table deep in an unrelated suite (the
// 064/066/067 tax). Deliberate minimalism is fine — it just has to be declared with a re-evaluable
// reason (the exclusions map lives beside its list in test-app.ts, so an editor of the list sees it).

// A fake Migration is just its `name` for the guard's purposes (it compares by name).
const fake = (name: string) => ({ name } as unknown as import("../src/db/migrate.js").Migration);

describe("P24 — migration-fixture parity (curated lists are DECLARED subsets of ALL_MIGRATIONS)", () => {
  it("migrationsForFullTestDb: every shipped migration is listed or declared-excluded", () => {
    assertExplicitSubsetOfAllMigrations({
      listName: "migrationsForFullTestDb (test/helpers/test-app.ts)",
      curatedList: migrationsForFullTestDb,
      exclusions: migrationsForFullTestDbExclusions,
    });
  });

  // The load-bearing proof: the guard FIRES on a future migration added to ALL_MIGRATIONS but forgotten
  // in the curated list (neither listed nor declared) — and its message names the migration + the fix.
  it("FIRES (named) when a newly-added migration is neither listed nor declared", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql")],
        exclusions: {},
        allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
      }),
    ).toThrowError(/068_brand_new\.sql[\s\S]*ADD it to fixtureX[\s\S]*DECLARE it/);
  });

  it("passes when the new migration is LISTED, and (separately) when it is DECLARED-excluded", () => {
    // listed → fine
    assertExplicitSubsetOfAllMigrations({
      listName: "fixtureX",
      curatedList: [fake("001_a.sql"), fake("068_brand_new.sql")],
      exclusions: {},
      allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
    });
    // declared-excluded → fine
    assertExplicitSubsetOfAllMigrations({
      listName: "fixtureX",
      curatedList: [fake("001_a.sql")],
      exclusions: { "068_brand_new.sql": "subsystem table — not on this fixture's edge" },
      allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
    });
  });

  it("FIRES on a STALE exclusion (names a migration absent from ALL_MIGRATIONS)", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql")],
        exclusions: { "999_ghost.sql": "reason" },
        allMigrations: [fake("001_a.sql")],
      }),
    ).toThrowError(/stale[\s\S]*999_ghost\.sql/);
  });

  it("FIRES on a REDUNDANT exclusion (a migration both listed AND excluded)", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql"), fake("002_b.sql")],
        exclusions: { "002_b.sql": "reason" },
        allMigrations: [fake("001_a.sql"), fake("002_b.sql")],
      }),
    ).toThrowError(/redundant[\s\S]*002_b\.sql/i);
  });

  it("150_node_launch_wrapper adds nullable launch_wrapper column and guards pre-150 databases", () => {
    expect(ALL_MIGRATIONS.some((m) => m.name === "150_node_launch_wrapper.sql")).toBe(true);
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "150_node_launch_wrapper.sql"));
      const repo = new RigRepository(db);
      const rig = repo.createRig("pre-150");
      const legacyNode = repo.addNode(rig.id, "legacy-codex", { runtime: "codex" });
      expect(legacyNode.launchWrapper).toBeUndefined();
      expect("launchWrapper" in legacyNode).toBe(false);
      expect(readSeatLaunchWrapper(db, legacyNode.id)).toBeUndefined();
      expect(repo.setNodeLaunchWrapper(legacyNode.id, null)).toBe(false);
      expect(repo.setNodeLaunchWrapper(legacyNode.id, [])).toBe(false);
      expect(() => repo.setNodeLaunchWrapper(legacyNode.id, ["mtn", "--"])).toThrow(/migration/i);
      expect(() => repo.addNode(rig.id, "unmigrated-wrapped", { runtime: "codex", launchWrapper: ["mtn", "--"] })).toThrow(/migration/i);
      expect(db.prepare("SELECT id FROM nodes WHERE logical_id = 'unmigrated-wrapped'").get()).toBeUndefined();

      migrate(db, ALL_MIGRATIONS);
      const cols = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string; notnull: number }>;
      const col = cols.find((c) => c.name === "launch_wrapper");
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(0);

      const wrapped = repo.addNode(rig.id, "migrated-wrapped", { runtime: "pi", launchWrapper: ["mtn", "sandbox", "--"] });
      expect(wrapped.launchWrapper).toEqual(["mtn", "sandbox", "--"]);
      expect(readSeatLaunchWrapper(db, wrapped.id)).toEqual(["mtn", "sandbox", "--"]);
    } finally {
      db.close();
    }
  });

  it("The new pool migration is listed in the migration fixture parity test.", () => {
    expect(ALL_MIGRATIONS.some((m) => m.name === "178_seat_pool.sql")).toBe(true);
    expect(migrationsForFullTestDb.some((m) => m.name === "178_seat_pool.sql")).toBe(true);
    expect(migrationsForFullTestDbExclusions).not.toHaveProperty("178_seat_pool.sql");
  });

  it("178_seat_pool adds a nullable pool column and the slot table, and guards pre-178 databases", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "178_seat_pool.sql"));
      const repo = new RigRepository(db);
      const rig = repo.createRig("pre-178");
      const legacyNode = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const block = { spec: { max: 2, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, cwdTemplate: null, drain: false } };
      expect(repo.getNodePool(legacyNode.id)).toBeUndefined();
      expect(repo.setNodePool(legacyNode.id, null)).toBe(false);
      expect(() => repo.setNodePool(legacyNode.id, block)).toThrow(/migration/i);
      expect(() => repo.addNode(rig.id, "dev.pooled", { runtime: "claude-code", pool: block })).toThrow(/migration/i);
      expect(db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.pooled'").get()).toBeUndefined();

      migrate(db, ALL_MIGRATIONS);
      const col = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string; notnull: number }>).find((c) => c.name === "pool");
      expect(col?.notnull).toBe(0);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seat_pool_slots'").get()).toBeDefined();
      const pooled = repo.addNode(rig.id, "dev.pooled", { runtime: "claude-code", pool: block });
      expect(repo.getNodePool(pooled.id)).toEqual(block);
      expect(repo.getNodePool(legacyNode.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("176_node_statusline_throttle adds a nullable column and guards pre-176 databases (#3416 item 3)", () => {
    expect(ALL_MIGRATIONS.some((m) => m.name === "176_node_statusline_throttle.sql")).toBe(true);
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "176_node_statusline_throttle.sql"));
      const repo = new RigRepository(db);
      const rig = repo.createRig("pre-176");
      const legacyNode = repo.addNode(rig.id, "legacy", { runtime: "claude-code" });
      expect(repo.getNodeStatuslineThrottle(legacyNode.id)).toBeNull();
      expect(repo.setNodeStatuslineThrottle(legacyNode.id, null)).toBe(false);
      expect(() => repo.setNodeStatuslineThrottle(legacyNode.id, 30)).toThrow(/migration/i);
      expect(() => repo.addNode(rig.id, "unmigrated-throttled", { runtime: "claude-code", statuslineThrottle: 30 })).toThrow(/migration/i);
      expect(db.prepare("SELECT id FROM nodes WHERE logical_id = 'unmigrated-throttled'").get()).toBeUndefined();

      migrate(db, ALL_MIGRATIONS);
      const col = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string; notnull: number }>)
        .find((c) => c.name === "statusline_throttle_seconds");
      expect(col?.notnull).toBe(0);
      const throttled = repo.addNode(rig.id, "throttled", { runtime: "claude-code", statuslineThrottle: 30 });
      expect(repo.getNodeStatuslineThrottle(throttled.id)).toBe(30);
    } finally {
      db.close();
    }
  });

  it("173_node_process_limits adds a nullable process_limits column and guards pre-173 databases", () => {
    expect(ALL_MIGRATIONS.some((m) => m.name === "173_node_process_limits.sql")).toBe(true);
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "173_node_process_limits.sql"));
      const repo = new RigRepository(db);
      const rig = repo.createRig("pre-173");
      const legacyNode = repo.addNode(rig.id, "legacy", { runtime: "codex" });
      expect("processLimits" in legacyNode).toBe(false);
      expect(repo.getNodeProcessLimits(legacyNode.id)).toBeUndefined();
      expect(repo.setNodeProcessLimits(legacyNode.id, null)).toBe(false);
      expect(() => repo.setNodeProcessLimits(legacyNode.id, { tasksMax: 512 })).toThrow(/migration/i);
      expect(() => repo.addNode(rig.id, "unmigrated-limited", { runtime: "codex", processLimits: { tasksMax: 512 } })).toThrow(/migration/i);
      expect(db.prepare("SELECT id FROM nodes WHERE logical_id = 'unmigrated-limited'").get()).toBeUndefined();

      migrate(db, ALL_MIGRATIONS);
      const col = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string; notnull: number }>)
        .find((c) => c.name === "process_limits");
      expect(col?.notnull).toBe(0);
      const limited = repo.addNode(rig.id, "migrated-limited", { runtime: "codex", processLimits: { tasksMax: 512 } });
      expect(limited.processLimits).toEqual({ tasksMax: 512 });
    } finally {
      db.close();
    }
  });

  it("177_node_keep_alive adds an off-by-default keep_alive column and the per-seat budget, and guards pre-177 databases", () => {
    expect(ALL_MIGRATIONS.some((m) => m.name === "177_node_keep_alive.sql")).toBe(true);
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "177_node_keep_alive.sql"));
      const repo = new RigRepository(db);
      const rig = repo.createRig("pre-177");
      const legacyNode = repo.addNode(rig.id, "legacy", { runtime: "codex" });
      expect("keepAlive" in legacyNode).toBe(false);
      expect(repo.setNodeKeepAlive(legacyNode.id, false)).toBe(false);
      expect(() => repo.setNodeKeepAlive(legacyNode.id, true)).toThrow(/migration/i);
      expect(() => repo.addNode(rig.id, "unmigrated-kept", { runtime: "codex", keepAlive: true })).toThrow(/migration/i);
      expect(db.prepare("SELECT id FROM nodes WHERE logical_id = 'unmigrated-kept'").get()).toBeUndefined();

      migrate(db, ALL_MIGRATIONS);
      const col = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
        .find((c) => c.name === "keep_alive");
      expect(col?.notnull).toBe(1);
      expect(col?.dflt_value).toBe("0");
      // The existing node keeps today's behaviour: off.
      expect(db.prepare("SELECT keep_alive FROM nodes WHERE id = ?").get(legacyNode.id)).toEqual({ keep_alive: 0 });
      expect(() => db.prepare("UPDATE nodes SET keep_alive = 2 WHERE id = ?").run(legacyNode.id)).toThrow(/CHECK/i);
      const kept = repo.addNode(rig.id, "migrated-kept", { runtime: "codex", keepAlive: true });
      expect(kept.keepAlive).toBe(true);

      // The budget row belongs to its seat and goes with it.
      db.prepare("INSERT INTO node_keep_alive_budget (node_id, incident_id) VALUES (?, ?)").run(kept.id, "incident-1");
      expect(db.prepare(
        "SELECT attempts, exhausted_at, recovered_at, last_outcome FROM node_keep_alive_budget WHERE node_id = ?",
      ).get(kept.id)).toEqual({ attempts: 0, exhausted_at: null, recovered_at: null, last_outcome: null });
      expect(() => db.prepare("UPDATE node_keep_alive_budget SET last_outcome = 'maybe' WHERE node_id = ?").run(kept.id)).toThrow(/CHECK/i);
      db.prepare("DELETE FROM nodes WHERE id = ?").run(kept.id);
      expect(db.prepare("SELECT COUNT(*) AS n FROM node_keep_alive_budget").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});


it("upgrades existing nodes to typed input and constrains explicit native selection", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, ALL_MIGRATIONS.filter(m => m.name !== nodeInputRouteSchema.name));
    expect((db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).some(column => column.name === "input_route")).toBe(false);
    const repo = new RigRepository(db), rig = repo.createRig("input-route");
    const node = repo.addNode(rig.id, "dev", { runtime: "pi" });
    migrate(db, ALL_MIGRATIONS);
    expect(repo.getRig(rig.id)?.nodes.find(n => n.id === node.id)?.inputRoute).toBe("typed");
    expect(repo.setNodeInputRoute(node.id, "native")).toBe(true);
    expect(repo.getRig(rig.id)?.nodes.find(n => n.id === node.id)?.inputRoute).toBe("native");
    expect(() => db.prepare("UPDATE nodes SET input_route='auto' WHERE id=?").run(node.id)).toThrow();
  } finally { db.close(); }
});


it("adds app credentials and submissions to an existing database without changing retained nodes", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, ALL_MIGRATIONS.filter(m => m.name !== coreAppAccessSchema.name));
    const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'core_app_%'").all() as Array<{ name: string }>).map(row => row.name).sort();
    expect(tables()).toEqual([]);
    const repo = new RigRepository(db), rig = repo.createRig("pre-app-access");
    const node = repo.addNode(rig.id, "dev", { runtime: "pi" });
    migrate(db, ALL_MIGRATIONS);
    expect(tables()).toEqual(["core_app_credentials", "core_app_submissions"]);
    expect(repo.getRig(rig.id)?.nodes.find(item => item.id === node.id)).toMatchObject({ id: node.id, inputRoute: "typed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM core_app_credentials").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM core_app_submissions").get()).toEqual({ n: 0 });
    migrate(db, ALL_MIGRATIONS);
    expect(tables()).toEqual(["core_app_credentials", "core_app_submissions"]);
  } finally { db.close(); }
});
