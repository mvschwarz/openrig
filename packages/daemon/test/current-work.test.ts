import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCurrentWork } from "../src/domain/current-work.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

// The canonical mission tag is the directory name (mission:release-0.5.8); the id form
// (mission:OPR.0.5.8) is historical compatibility only and must not be authored on new
// rows. These fixtures cover the compat path because rows carrying it are still on the
// board and refusing them would be the guess-refusal firing on good data — not because
// both forms are valid conventions. Per the ruling relayed 2026-09-01 09:43Z.
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function tree(): string {
  root = mkdtempSync(join(tmpdir(), "current-work-"));
  const missions = join(root, "missions");
  const slices = join(missions, "release-0.5.8", "slices");
  mkdirSync(join(slices, "14-refocus-current-work-binding"), { recursive: true });
  mkdirSync(join(slices, "09-single-topology-creation-ingress"), { recursive: true });
  writeFileSync(
    join(missions, "release-0.5.8", "SPEC.md"),
    "---\nid: OPR.0.5.8\nmission: release-0.5.8\n---\n# mission\n",
    "utf8",
  );
  writeFileSync(
    join(slices, "14-refocus-current-work-binding", "SPEC.md"),
    "---\nid: OPR.0.5.8.14\n---\n# slice 14\n",
    "utf8",
  );
  writeFileSync(
    join(slices, "09-single-topology-creation-ingress", "SPEC.md"),
    "---\nid: OPR.0.5.8.9\n---\n# slice 9\n",
    "utf8",
  );
  return missions;
}

const row = (mission: string, slice: string, state = "in-progress") => ({
  state,
  tags: [`mission:${mission}`, `slice:${slice}`],
});

describe("deriveCurrentWork — tag form tolerance (OPR.0.5.8.14)", () => {
  it("resolves a mission tagged by its DIRECTORY name", () => {
    const missions = tree();
    const result = deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14")], missions);
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("still resolves a legacy id-form mission tag already on the board (compat only)", () => {
    const missions = tree();
    const result = deriveCurrentWork([row("OPR.0.5.8", "OPR.0.5.8.14")], missions);
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("resolves a slice tagged by its DIRECTORY name", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "14-refocus-current-work-binding")],
      missions,
    );
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("teaches the canonical tag pair and marks the legacy form as compat", () => {
    const missions = tree();
    const canonical = deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14")], missions);
    expect(canonical.currentWorkBasis).toContain("mission via canonical directory-name tag");
    expect(canonical.currentWorkBasis).toContain("slice via canonical id tag");
    expect(canonical.currentWorkBasis).not.toContain("compat");

    // A reader who hits the legacy path must be told it is compat, not shown a convention.
    const legacy = deriveCurrentWork([row("OPR.0.5.8", "OPR.0.5.8.14")], missions);
    expect(legacy.currentWorkBasis).toContain("legacy id-form tag (compat)");
  });
});

describe("deriveCurrentWork — ambiguity is counted on RESOLVED nodes", () => {
  // A canonical row and a legacy row can name the same node during the compat window.
  it("treats two rows naming ONE work node via different tag forms as one, not an ambiguity", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "OPR.0.5.8.14"), row("OPR.0.5.8", "14-refocus-current-work-binding")],
      missions,
    );
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("still refuses when two rows resolve to genuinely different work nodes", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "OPR.0.5.8.14"), row("OPR.0.5.8", "OPR.0.5.8.9")],
      missions,
    );
    expect(result.currentWork).toBeNull();
    expect(result.currentWorkBasis).toContain("refusing to guess");
  });

  it("refuses a single row carrying conflicting slice tags, in either array order", () => {
    // The tags column is persisted verbatim with no per-prefix uniqueness rule, so array
    // position is not data. Picking the first match makes the answer depend on insertion
    // order — the same ambiguity-to-confidence conversion, one layer further out.
    const missions = tree();
    const conflicting = (...slices: string[]) => [{
      state: "in-progress",
      tags: ["mission:release-0.5.8", ...slices.map((s) => `slice:${s}`)],
    }];

    const forward = deriveCurrentWork(conflicting("OPR.0.5.8.14", "OPR.0.5.8.9"), missions);
    const reversed = deriveCurrentWork(conflicting("OPR.0.5.8.9", "OPR.0.5.8.14"), missions);
    expect(forward.currentWork).toBeNull();
    expect(reversed.currentWork).toBeNull();
    expect(forward.currentWorkBasis).toContain("slice");
    // Order must not change the verdict; that equality is the actual property under test.
    expect(forward.currentWorkBasis).toBe(reversed.currentWorkBasis);
  });

  it("refuses a single row carrying conflicting mission tags", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [{
        state: "in-progress",
        tags: ["mission:release-0.5.8", "mission:OPR.0.5.8", "slice:OPR.0.5.8.14"],
      }],
      missions,
    );
    // Both values happen to name the SAME mission here, and it still must refuse — not
    // because the module is unable to tell (resolveRow and the byPath dedupe compare
    // spellings across rows, and a test below relies on exactly that), but because a
    // single row naming its mission twice, differently, is MALFORMED. Refusing malformed
    // input is this module's job; resolving it would be repairing the caller's row and
    // then presenting the repair as an answer.
    expect(result.currentWork).toBeNull();
    expect(result.currentWorkBasis).toContain("mission");
  });

  it("collapses exact duplicate tags rather than treating them as a conflict", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [{
        state: "in-progress",
        tags: ["mission:release-0.5.8", "mission:release-0.5.8", "slice:OPR.0.5.8.14"],
      }],
      missions,
    );
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("names the offending ROW in a refusal when the caller supplies row ids", () => {
    // R1 F3: naming only the values leaves the reader to go find which row meant it. The
    // production call site passes full queue items, so the id is available for free.
    const missions = tree();
    const conflict = deriveCurrentWork(
      [{
        qitemId: "qitem-conflict-1",
        state: "in-progress",
        tags: ["mission:release-0.5.8", "slice:OPR.0.5.8.14", "slice:OPR.0.5.8.9"],
      }],
      missions,
    );
    expect(conflict.currentWork).toBeNull();
    expect(conflict.currentWorkBasis).toContain("qitem-conflict-1");

    const unresolved = deriveCurrentWork(
      [{
        qitemId: "qitem-unresolved-2",
        state: "in-progress",
        tags: ["mission:release-0.5.8", "slice:OPR.0.5.8.999"],
      }],
      missions,
    );
    expect(unresolved.currentWork).toBeNull();
    expect(unresolved.currentWorkBasis).toContain("qitem-unresolved-2");

    // And it must degrade cleanly when no id is supplied, since the type allows that.
    const anonymous = deriveCurrentWork(
      [{ state: "in-progress", tags: ["mission:release-0.5.8", "slice:OPR.0.5.8.999"] }],
      missions,
    );
    expect(anonymous.currentWorkBasis).toContain("a row");
    expect(anonymous.currentWorkBasis).not.toContain("undefined");
  });

  it("refuses when a typed row fails to resolve alongside one that succeeds", () => {
    // An unresolved typed baton is UNKNOWN, not irrelevant. Answering from the row that
    // happened to resolve treats "I could not tell what this is" as "this does not count",
    // which is the guess the slice exists to prevent. Disclosing it in the basis is not
    // enough — the caller reads workNodePath, not the prose beside it.
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "OPR.0.5.8.14"), row("release-0.5.8", "OPR.0.5.8.999")],
      missions,
    );
    expect(result.currentWork).toBeNull();
    expect(result.currentWorkBasis).toContain("OPR.0.5.8.999");
  });

  it("dedupes across tag forms ONLY when every typed row resolves", () => {
    const missions = tree();
    // Both resolve, same node -> one work item, still answers.
    expect(
      deriveCurrentWork(
        [row("release-0.5.8", "OPR.0.5.8.14"), row("OPR.0.5.8", "14-refocus-current-work-binding")],
        missions,
      ).currentWork,
    ).not.toBeNull();
    // One resolves, one does not -> the dedupe must not rescue it.
    expect(
      deriveCurrentWork(
        [row("release-0.5.8", "OPR.0.5.8.14"), row("nope-not-a-mission", "OPR.0.5.8.14")],
        missions,
      ).currentWork,
    ).toBeNull();
  });

  it("refuses ambiguity even when the second baton sits beyond the 25-row recent cap", async () => {
    // Guard's reproduction, pinned: whoami.recent is capped at 25 and mixes states, so an
    // older in-progress baton falls outside it while the authoritative count still says 2.
    // Deriving from that projection turned the ambiguity refusal into a confident answer.
    const missions = tree();
    const db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema]);
    const repo = new QueueRepository(db, new EventBus(db));
    const SEAT = "dev-driver@rig";

    const claim = async (mission: string, slice: string) => {
      const item = await repo.create({
        sourceSession: "planner@rig",
        destinationSession: SEAT,
        body: `typed ${slice}`,
        tags: [`mission:${mission}`, `slice:${slice}`],
      });
      repo.claim({ qitemId: item.qitemId, destinationSession: SEAT });
      return item;
    };

    // Oldest typed baton first, then enough newer rows to push it past the cap.
    const older = await claim("release-0.5.8", "OPR.0.5.8.9");
    for (let i = 0; i < 24; i += 1) {
      await repo.create({
        sourceSession: "planner@rig",
        destinationSession: SEAT,
        body: `filler ${i}`,
        tags: ["kind:note"],
      });
    }
    await claim("release-0.5.8", "OPR.0.5.8.14");

    // Claiming bumps ts_updated, and rows created inside one second tie on it — which made
    // the ordering, and therefore this whole fixture, non-deterministic. Pin the older
    // baton behind every filler so "beyond the cap" is a fact rather than a race.
    db.prepare(`UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?`)
      .run("2000-01-01T00:00:00.000Z", older.qitemId);

    // Control: the capped display projection really does hide the older baton, so this
    // test would have failed against the pre-repair input rather than passing vacuously.
    const recent = repo.whoami(SEAT).asDestination.recent;
    expect(recent.length).toBe(25);
    const typedInRecent = recent.filter(
      (r) => r.state === "in-progress" && (r.tags ?? []).some((t) => t.startsWith("slice:")),
    );
    expect(typedInRecent.length).toBe(1);
    expect(deriveCurrentWork(recent, missions).currentWork).not.toBeNull();

    // The authoritative input is unbounded, so the refusal fires as it must.
    const authoritative = repo.listInProgressForDestination(SEAT);
    expect(authoritative.length).toBe(2);
    const derived = deriveCurrentWork(authoritative, missions);
    expect(derived.currentWork).toBeNull();
    expect(derived.currentWorkBasis).toContain("refusing to guess");

    db.close();
  });

  it("refuses with a named basis when nothing resolves, and ignores non-claimed rows", () => {
    const missions = tree();
    expect(deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.999")], missions).currentWorkBasis)
      .toContain("resolves to 0");
    // R1 F1: the refusal must name its SCOPE, not imply an empty desk. A seat whose only
    // typed baton is blocked holds real work, and "you hold nothing" would send it
    // somewhere different from "your work is parked".
    const notClaimed = deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14", "pending")], missions);
    expect(notClaimed.currentWork).toBeNull();
    expect(notClaimed.currentWorkBasis).toContain("only in-progress rows are considered");
    expect(notClaimed.currentWorkBasis).toContain("blocked");
    expect(deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14")], null))
      .toMatchObject({ currentWork: null });
  });
});
