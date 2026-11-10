// #2761: on the default flow (sdlc-conventions Part A) a team records a slice's `status:`, not plan lock, `candidate:`
// rows, review artifacts or an EC-3 worktree row. The execution view must say what it couldn't read instead of reading
// finished work as not done: each slice shows its recorded status beside the ladder (the team's word, never a rung), and
// the mission says once that no build records exist. The rungs and next-up stay exactly as their own records give them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionWakesSchema } from "../src/db/migrations/073_queue_transition_wakes.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";

const MISSION = "simple-flow";
type Doc = Record<string, unknown>;
type Entry = Record<string, Record<string, unknown>> & { slice_id: string };

describe("#2761 execution view on the default flow", () => {
  let db: Database.Database;
  let projector: ViewProjector;
  let tmp: string;
  let missionsRoot: string;

  const slice = (dir: string, frontmatter: string[]) => {
    const d = path.join(missionsRoot, MISSION, "slices", dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SPEC.md"), `---\n${frontmatter.join("\n")}\n---\n\n## Intent\n${dir}\n`);
  };
  const row = (id: string, tags: string[], body = "Work.") =>
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
                VALUES (?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'lead@t', 'builder@t', 'done', 'normal', 'light', ?, ?)`)
      .run(id, JSON.stringify(tags), body);
  const show = async (): Promise<Doc> => (await projector.show("execution", { mission: MISSION })).rows[0] as Doc;
  const ladder = (doc: Doc) => doc.q4_ladder as Entry[];
  const entry = (doc: Doc, id: string) => ladder(doc).find((e) => e.slice_id === id)!;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exec-default-flow-"));
    missionsRoot = path.join(tmp, "missions");
    fs.mkdirSync(path.join(missionsRoot, MISSION), { recursive: true });
    fs.writeFileSync(path.join(missionsRoot, MISSION, "SPEC.md"), `---\nid: SF\nmission: ${MISSION}\n---\n# Simple flow\n`);
    // Finished on the default flow: the team's own words, as `rig scope slice ship`/`close` and hand edits write them.
    slice("01-done", ["id: SF.1", "status: done", "depends_on: []"]);
    slice("02-shipped", ["id: SF.2", "status: shipped-to-release-1", 'depends_on: ["SF.1"]']);
    slice("03-closed", ["id: SF.3", "status: Closed", "depends_on: []"]);
    // Scaffolded after the work, with no status at all (the reporter's 9-slice mission).
    slice("04-unrecorded", ["id: SF.4", "depends_on: []"]);
    db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueItemSummarySchema,
      queueTransitionsSchema, queueTransitionWakesSchema, viewsCustomSchema]);
    projector = new ViewProjector(db, new EventBus(db));
    projector.setExecutionDeps({
      db,
      slicesRoot: () => missionsRoot,
      rigsRoot: () => path.join(tmp, "rigs"),
      buildInfo: { semver: null, commit: null, dirty: null, builtAt: null },
      now: () => new Date("2026-11-10T00:00:00.000Z"),
      seatActivity: { getSeatStateBySession: () => null },
    } as never);
    // The team's rows name the mission, as Part A asks; none carries candidate: or worktree_path=.
    row("qitem-sf-1", [`mission:${MISSION}`, "slice:01-done"]);
    row("qitem-sf-2", [`mission:${MISSION}`, "slice:build-two"]);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  it("shows each slice's recorded status and its bucket beside the ladder, as testimony", async () => {
    const doc = await show();
    expect(entry(doc, "SF.1").recorded_status).toMatchObject({ word: "done", bucket: "done" });
    expect(entry(doc, "SF.2").recorded_status).toMatchObject({ word: "shipped-to-release-1", bucket: "done" });
    expect(entry(doc, "SF.3").recorded_status).toMatchObject({ word: "Closed", bucket: "done" });
    expect(entry(doc, "SF.1").recorded_status!.basis).toBe("SPEC.md frontmatter status:, recorded by the team, not verified; it never sets a rung");
    // No status recorded is said as such, not read as draft or as not done.
    expect(entry(doc, "SF.4").recorded_status).toEqual({ word: null, bucket: null, basis: "no status: in SPEC.md frontmatter" });
  });

  it("reads the slice's own node file, as the scopes views do: a status kept only in PROGRESS.md isn't the slice's", async () => {
    fs.writeFileSync(path.join(missionsRoot, MISSION, "slices", "04-unrecorded", "PROGRESS.md"), "---\nstatus: done\n---\n# Progress\n");
    expect(entry(await show(), "SF.4").recorded_status).toMatchObject({ word: null, bucket: null });
  });

  it("says once for the mission that nothing records a build, so built and merged read not recorded", async () => {
    const records = (await show()).q4_records as Record<string, unknown>;
    expect(records).toMatchObject({ slices: 4, with_candidate: 0, with_merge_report: 0, repo_context: "INDETERMINATE" });
    expect(records.basis).toMatch(/^no slice in this mission has a candidate:<sha> row/);
    expect(records.basis).toMatch(/not recorded, which is not the same as not done/);
  });

  it("keeps every rung and next-up as their own records give them: a recorded status never turns one", async () => {
    const doc = await show();
    for (const e of ladder(doc)) {
      expect(e.built!.candidate_sha).toBe("INDETERMINATE");
      expect(e.reviewed!.value).toBe("INDETERMINATE");
      expect(e.folded!.value).toBe("INDETERMINATE");
    }
    // Plan lock is a Part B step: false stays false, and the basis says why it reads false on this flow.
    expect(entry(doc, "SF.1").locked).toEqual({
      value: false,
      basis: "no approved-spec-at in frontmatter; plan lock is a Part B step (rig scope slice approve --scope spec), so the default flow reads false here whatever the recorded status",
    });
    // Next-up reads the folded rung, not the status: a done-recorded slice stays INDETERMINATE, never dispatchable.
    const q2 = doc.q2_sequencing as Array<Record<string, unknown>>;
    expect(q2.find((s) => s.slice_id === "SF.1")).toMatchObject({ next_up: "INDETERMINATE" });
    expect(q2.find((s) => s.slice_id === "SF.4")).toMatchObject({ next_up: "INDETERMINATE" });
  });

  it("counts recorded builds and merge reports when a team does record them", async () => {
    row("qitem-sf-built", [`mission:${MISSION}`, "slice:01-done", "candidate:0123456789abcdef0123456789abcdef01234567"]);
    row("qitem-sf-merged", [`mission:${MISSION}`, "slice:03-closed", "merged:41"]);
    const records = (await show()).q4_records as Record<string, unknown>;
    expect(records).toMatchObject({ slices: 4, with_candidate: 1, with_merge_report: 1, repo_context: "INDETERMINATE" });
    expect(records.basis).toMatch(/^1 of 4 slices have a candidate:<sha> row; no row carries worktree_path= \(EC-3\), so merged can't be tested/);
  });
});
