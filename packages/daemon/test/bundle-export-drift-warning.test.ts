// Build B — the bundle-export drift warning, tested against a REAL database.
//
// The domain comparator is pinned separately; what is unproven there is the WIRING: does the export
// path find the running rig BY NAME, read its live seats, and stay silent in every case where there
// is genuinely nothing to say? A warning that fires on a brand-new rig being authored would be
// noise on every first export, and noise is how a real warning gets skipped.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { describeSpecLiveDrift } from "../src/routes/bundles.js";

const SPEC = {
  name: "drift-rig",
  pods: [{ id: "orch", members: [{ id: "lead" }] }, { id: "dev", members: [{ id: "driver" }] }],
};

describe("bundle export — spec-vs-live drift warning", () => {
  let db: Database.Database;
  let repo: RigRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new RigRepository(db);
  });
  afterEach(() => db.close());

  function seedRig(name: string, logicalIds: string[]): string {
    const rigId = `rig-${name}`;
    db.prepare("INSERT INTO rigs (id, name, created_at, updated_at) VALUES (?,?,datetime('now'),datetime('now'))").run(rigId, name);
    for (const [i, lid] of logicalIds.entries()) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?,?,?)").run(`${rigId}-n${i}`, rigId, lid);
    }
    return rigId;
  }

  it("WARNS, naming the pods the bundle would silently drop", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver", "dev50.driver", "dev50.qa"]);
    const w = describeSpecLiveDrift(SPEC, repo);
    expect(w).toBeTruthy();
    expect(w).toContain("dev50");
    expect(w).toContain("2 pods/2 seats");
    expect(w).toContain("3");   // live pods
    expect(w).toContain("4");   // live seats
    expect(w!.toLowerCase()).toContain("spec");
  });

  it("SILENT when the running rig matches the spec", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver"]);
    expect(describeSpecLiveDrift(SPEC, repo)).toBeNull();
  });

  it("SILENT when no rig of that name is running — authoring a NEW rig is not drift", () => {
    seedRig("some-other-rig", ["orch.lead", "dev.driver", "dev50.driver"]);
    expect(describeSpecLiveDrift(SPEC, repo)).toBeNull();
  });

  // SUPERSEDED 2026-08-12, and the old expectation is kept named here rather than deleted.
  //
  // Build B shipped this as `SILENT for a legacy non-pod-aware spec` — a deliberate scope limit, not
  // a property of legacy specs. It was wrong in the way that matters: a v1 spec exports through the
  // same create endpoint and produces the same confidently-wrong artifact, so silence there was the
  // defect wearing a passing test. Legacy now compares too (flat `nodes:` ids against flat
  // `logical_id`s), and the route refuses a legacy spec that would drop live seats.
  it("WARNS for a legacy non-pod-aware spec — the format never made the drift safe", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver", "dev50.driver"]);
    const warning = describeSpecLiveDrift({ name: "drift-rig", nodes: [{ id: "dev" }] }, repo);
    expect(warning).not.toBeNull();
    expect(warning).toContain("dev.driver");
  });

  // Still silent, and for a reason the legacy change does not touch: with no `name:` there is no rig
  // to look up, so there is nothing to compare against and nothing honest to say.
  it("SILENT for a nameless spec", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver", "dev50.driver"]);
    expect(describeSpecLiveDrift({ pods: SPEC.pods }, repo)).toBeNull();
  });

  it("SILENT rather than throwing when there is no repository at all", () => {
    expect(describeSpecLiveDrift(SPEC, undefined)).toBeNull();
  });

  it("never throws into the export path, even on a hostile spec value", () => {
    seedRig("drift-rig", ["orch.lead"]);
    for (const bad of [null, undefined, 42, "a string", { name: "drift-rig", pods: "not-an-array" }]) {
      expect(() => describeSpecLiveDrift(bad, repo)).not.toThrow();
    }
  });
});
