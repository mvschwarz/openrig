import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";

describe("AppliedLaunchObservationStore", () => {
  let db: DatabaseType;
  let registry: SessionRegistry;
  let store: AppliedLaunchObservationStore;

  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r1");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, ?, ?, ?, ?, ?)")
      .run("node-1", "rig-1", "dev.impl", "worker", "claude-code", "/tmp/project");
    registry = new SessionRegistry(db);
    store = new AppliedLaunchObservationStore(db);
  });

  afterEach(() => db.close());

  it("records against the exact current generation without mutating the append-only tenure row", () => {
    registry.registerSession("node-1", "dev-impl@r1");
    const tenure = registry.currentOccupantTenure("node-1")!;
    expect(store.recordCurrent("node-1", observeClaudePermission("--permission-mode acceptEdits"))).toBe(true);
    expect(store.readCurrent("node-1")).toMatchObject({
      generationUuid: tenure.generationUuid,
      runtime: "claude-code",
      axis: "permission",
      state: "observed",
      value: "acceptEdits",
    });
    expect(registry.currentOccupantTenure("node-1")).toEqual(tenure);
  });

  it("never inherits a predecessor observation after a new occupant generation is minted", () => {
    registry.registerSession("node-1", "dev-impl@r1");
    const first = registry.currentOccupantTenure("node-1")!;
    expect(store.recordCurrent("node-1", observeClaudePermission("--permission-mode acceptEdits"))).toBe(true);

    registry.mintOccupantTenure("node-1", "handover");
    expect(registry.currentOccupantTenure("node-1")!.generationUuid).not.toBe(first.generationUuid);
    expect(store.readCurrent("node-1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations").get()).toEqual({ n: 1 });
  });

  it("keeps adopted/discovered/unlaunched occupants unknown until a successful launch records an effect", () => {
    registry.registerClaimedSession("node-1", "dev-impl@r1", "adopt");
    expect(store.readCurrent("node-1")).toBeNull();
  });

  it("degrades missing migration/read/write failures to unknown without throwing", () => {
    const bare = new Database(":memory:");
    try {
      const missing = new AppliedLaunchObservationStore(bare);
      expect(missing.recordCurrent("node-1", observeClaudePermission("--permission-mode acceptEdits"))).toBe(false);
      expect(missing.readCurrent("node-1")).toBeNull();
    } finally {
      bare.close();
    }
  });
});
