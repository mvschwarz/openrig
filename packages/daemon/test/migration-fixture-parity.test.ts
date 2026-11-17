import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrationsForFullTestDb, migrationsForFullTestDbExclusions } from "./helpers/test-app.js";
import { assertExplicitSubsetOfAllMigrations } from "./helpers/migration-subset-guard.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
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
