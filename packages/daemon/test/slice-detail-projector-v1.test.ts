// Slice Story View v1 — end-to-end projector test.
//
// Drives SliceDetailProjector against a temp slice fixture + a wired
// workflow_specs row + a bound workflow_instance with trail rows.
// Pins:
//   - workflowBinding populated when an instance touches slice qitems
//   - story.phaseDefinitions matches the bound spec
//   - acceptance.currentStep populated from the bound instance
//   - topology.specGraph populated when bound
//   - story.events have phase tags from the trail map (not the v0
//     hardcoded legacy enum)
//   - all v1 fields are null when no instance is bound (v0 fallback)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";

const SAMPLE_SPEC = `workflow:
  id: test-loop
  version: "1"
  objective: 4-step test loop
  entry:
    role: a
  invariants:
    allowed_exits: [handoff, waiting, done, failed]
  roles:
    a:
      preferred_targets: [a@r]
    b:
      preferred_targets: [b@r]
    c:
      preferred_targets: [c@r]
    d:
      preferred_targets: [d@r]
  steps:
    - id: step-a
      actor_role: a
      allowed_exits: [handoff]
      next_hop:
        suggested_roles: [b]
    - id: step-b
      actor_role: b
      allowed_exits: [handoff]
      next_hop:
        suggested_roles: [c]
    - id: step-c
      actor_role: c
      allowed_exits: [handoff]
      next_hop:
        suggested_roles: [d]
    - id: step-d
      actor_role: d
      allowed_exits: [done]
`;

function writeSliceFolder(slicesRoot: string, name: string, frontmatter: Record<string, string>): void {
  const dir = join(slicesRoot, name);
  mkdirSync(dir, { recursive: true });
  const fmLines = ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), "---", `# ${name}`].join("\n");
  writeFileSync(join(dir, "README.md"), fmLines);
}

function insertQitem(db: Database.Database, qitemId: string, body: string): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
     VALUES (?, '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', 'src@r', 'dst@r', 'in-progress', 'routine', ?)`
  ).run(qitemId, body);
}

describe("PL-slice-story-view-v1 SliceDetailProjector — bound workflow_instance", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let cleanupRoot: string;
  let indexer: SliceIndexer;
  let cache: WorkflowSpecCache;
  let projector: SliceDetailProjector;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanupRoot = mkdtempSync(join(tmpdir(), "slice-projector-v1-"));
    slicesRoot = join(cleanupRoot, "slices");
    mkdirSync(slicesRoot, { recursive: true });
    indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    cache = new WorkflowSpecCache(db);
    // Seed the spec into the cache via a real workspace path.
    specPath = join(cleanupRoot, "test-loop.yaml");
    writeFileSync(specPath, SAMPLE_SPEC);
    cache.readThrough(specPath);
    projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: cache });
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  function bindInstance(instanceId: string, qitemIds: string[], currentStepId: string | null): void {
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json, current_step_id, hop_count)
       VALUES (?, 'test-loop', '1', 'creator@r', '2026-05-04T00:00:00.000Z', 'active', ?, ?, 2)`
    ).run(instanceId, JSON.stringify(qitemIds.length > 0 ? [qitemIds[qitemIds.length - 1]] : []), currentStepId);
    // Trail: each qitem closed at a sequential step.
    const stepOrder = ["step-a", "step-b", "step-c", "step-d"];
    qitemIds.forEach((qid, idx) => {
      const stepId = stepOrder[Math.min(idx, stepOrder.length - 1)]!;
      const role = stepId.replace("step-", "");
      db.prepare(
        `INSERT INTO workflow_step_trails (trail_id, instance_id, step_id, step_role, closed_at, closure_reason, actor_session, prior_qitem_id, next_qitem_id)
         VALUES (?, ?, ?, ?, ?, 'handoff', 'actor@r', ?, ?)`
      ).run(`trail-${idx}`, instanceId, stepId, role, `2026-05-04T0${idx}:00:00.000Z`, qid, qitemIds[idx + 1] ?? null);
    });
  }

  it("populates workflowBinding + all four v1 dimensions when an instance is bound to the slice", () => {
    writeSliceFolder(slicesRoot, "bound-slice", { slice: "bound-slice", "rail-item": "PL-test", status: "active" });
    insertQitem(db, "q-1", "bound-slice initial");
    insertQitem(db, "q-2", "bound-slice handoff");
    insertQitem(db, "q-3", "bound-slice qa");
    bindInstance("inst-bound", ["q-1", "q-2", "q-3"], "step-c");

    const slice = indexer.get("bound-slice")!;
    const payload = projector.project(slice);

    // workflowBinding present.
    expect(payload.workflowBinding).not.toBeNull();
    expect(payload.workflowBinding!.instanceId).toBe("inst-bound");
    expect(payload.workflowBinding!.workflowName).toBe("test-loop");
    expect(payload.workflowBinding!.currentStepId).toBe("step-c");

    // Dimension #2: spec-driven phase definitions.
    expect(payload.story.phaseDefinitions).not.toBeNull();
    expect(payload.story.phaseDefinitions!.map((p) => p.id)).toEqual(["step-a", "step-b", "step-c", "step-d"]);

    // Dimension #3: current step.
    expect(payload.acceptance.currentStep).not.toBeNull();
    expect(payload.acceptance.currentStep!.stepId).toBe("step-c");
    expect(payload.acceptance.currentStep!.role).toBe("c");
    expect(payload.acceptance.currentStep!.allowedExits).toEqual(["handoff"]);
    expect(payload.acceptance.currentStep!.allowedNextSteps).toEqual([
      { stepId: "step-d", role: "d", reason: "next_hop" },
    ]);

    // Dimension #1: spec graph.
    expect(payload.topology.specGraph).not.toBeNull();
    expect(payload.topology.specGraph!.nodes).toHaveLength(4);
    expect(payload.topology.specGraph!.edges).toHaveLength(3);
    expect(payload.topology.specGraph!.nodes.find((n) => n.stepId === "step-c")?.isCurrent).toBe(true);
  });

  it("story events get phase tags from the trail map (NOT from v0 hardcoded legacy heuristic)", () => {
    writeSliceFolder(slicesRoot, "phased-slice", { slice: "phased-slice", "rail-item": "PL-test" });
    insertQitem(db, "q-A", "phased-slice work A");
    insertQitem(db, "q-B", "phased-slice work B");
    bindInstance("inst-phased", ["q-A", "q-B"], "step-b");

    const slice = indexer.get("phased-slice")!;
    const payload = projector.project(slice);

    const phaseByQitem = new Map<string, string | null>();
    for (const event of payload.story.events) {
      if (event.qitemId) phaseByQitem.set(event.qitemId, event.phase);
    }
    // q-A closed at step-a per the seeded trail; q-B at step-b.
    expect(phaseByQitem.get("q-A")).toBe("step-a");
    expect(phaseByQitem.get("q-B")).toBe("step-b");
  });

  it("non-qitem events (doc edits, proof packets) get phase=null (v1: untagged)", () => {
    writeSliceFolder(slicesRoot, "doc-slice", { slice: "doc-slice", "rail-item": "PL-test" });
    insertQitem(db, "q-x", "doc-slice");
    bindInstance("inst-doc", ["q-x"], "step-a");

    const slice = indexer.get("doc-slice")!;
    const payload = projector.project(slice);

    const docEvent = payload.story.events.find((e) => e.kind === "doc.edited");
    expect(docEvent).toBeDefined();
    expect(docEvent!.phase).toBeNull();
  });

  it("OPR.0.4.1.18 — Story node uses the authored summary, degrades on null", () => {
    // Simulate a post-044 schema (the shared beforeEach migrate list predates
    // 044): add the column, then seed one summarized + one un-summarized qitem.
    db.exec("ALTER TABLE queue_items ADD COLUMN summary TEXT");
    writeSliceFolder(slicesRoot, "summary-slice", { slice: "summary-slice", "rail-item": "PL-sum" });
    // Bodies must contain the slice name so the indexer's matchQitems associates
    // them with the slice (matched by rail-item or slice-name in the body).
    insertQitem(db, "q-sum", "summary-slice work: build the summary column");
    db.prepare("UPDATE queue_items SET summary = ? WHERE qitem_id = ?").run(
      "Human-readable: wire the version row.",
      "q-sum"
    );
    insertQitem(db, "q-nosum", "summary-slice work: no summary provided here");
    bindInstance("inst-sum", ["q-sum", "q-nosum"], "step-b");

    const slice = indexer.get("summary-slice")!;
    const payload = projector.project(slice);
    const created = payload.story.events.filter((e) => e.kind === "queue.created");
    const sum = created.find((e) => e.qitemId === "q-sum");
    const nosum = created.find((e) => e.qitemId === "q-nosum");

    // D-2: the authored human summary wins on the Story node.
    expect(sum!.summary).toBe("Human-readable: wire the version row.");
    // D-1: null → degrade (source→dest + body truncation); StoryEvent.summary
    // stays a non-null string so the slice-19 consumer never breaks.
    expect(nosum!.summary).toBe("src@r → dst@r: summary-slice work: no summary provided here");
  });

  it("all v1 fields are null when NO workflow_instance touches the slice qitems (v0 fallback)", () => {
    writeSliceFolder(slicesRoot, "unbound-slice", { slice: "unbound-slice", "rail-item": "PL-test" });
    insertQitem(db, "q-orphan", "unbound-slice has qitems but no workflow_instance");

    const slice = indexer.get("unbound-slice")!;
    const payload = projector.project(slice);

    expect(payload.workflowBinding).toBeNull();
    expect(payload.story.phaseDefinitions).toBeNull();
    expect(payload.acceptance.currentStep).toBeNull();
    expect(payload.topology.specGraph).toBeNull();

    // v0 functionality intact.
    expect(payload.story.events.length).toBeGreaterThan(0);
    expect(payload.acceptance.totalItems).toBeDefined();
  });

  it("projector silently degrades when constructed without a workflowSpecCache (v0 mode)", () => {
    const v0Projector = new SliceDetailProjector({ db, indexer });
    writeSliceFolder(slicesRoot, "v0-mode-slice", { slice: "v0-mode-slice", "rail-item": "PL-test" });
    insertQitem(db, "q-v0", "v0-mode-slice");
    bindInstance("inst-v0", ["q-v0"], "step-a");

    const slice = indexer.get("v0-mode-slice")!;
    const payload = v0Projector.project(slice);

    // workflowBinding is still populated (binding helper runs without spec cache),
    // but the spec-driven dimensions are null because there's no cache to resolve from.
    expect(payload.workflowBinding).not.toBeNull();
    expect(payload.story.phaseDefinitions).toBeNull();
    expect(payload.acceptance.currentStep).toBeNull();
    expect(payload.topology.specGraph).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 intent-stage/scaffold-projection — T4 (buildAcceptance
// placeholder-filter / dedup / pristine-triple edits, incl. the AR-6
// added-4th-row vector) + T7 (byte-identity carve, acceptance half).
//
// Fixtures are TEMPLATE-DERIVED via the real CLI renderers (dynamic import,
// same pattern as scope-audit-parity.test.ts) — a pristine `rig scope slice
// create` output is the canonical intent-stage fixture, and template drift
// breaks these tests honestly.
// ---------------------------------------------------------------------------

import { beforeAll as beforeAllAccept } from "vitest";
import * as nodePath from "node:path";

const ACCEPT_REPO_ROOT = nodePath.resolve(import.meta.dirname, "..", "..", "..");

let acceptTpl: { readme: string; prd: string; progress: string; proof: string };

beforeAllAccept(async () => {
  const mod = await import(
    nodePath.join(ACCEPT_REPO_ROOT, "packages/cli/src/lib/scope/templates.ts")
  );
  const opts = {
    id: "OPR.T.98",
    slice_number: "98",
    slug: "accept",
    mission: "release-t",
    title: "Accept",
    created_date: "2026-07-11",
  };
  acceptTpl = {
    readme: mod.renderSliceTemplate("placeholder", opts),
    prd: mod.renderImplementationPrdTemplate(opts),
    progress: mod.renderSliceProgressTemplate("Accept"),
    proof: mod.renderSliceProofTemplate({ id: "OPR.T.98", title: "Accept" }),
  };
});

describe("release-0.4.7 intent-stage — buildAcceptance edits (T4) + byte-identity (T7)", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let cleanupRoot: string;
  let indexer: SliceIndexer;
  let projector: SliceDetailProjector;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanupRoot = mkdtempSync(join(tmpdir(), "slice-projector-accept-"));
    slicesRoot = join(cleanupRoot, "slices");
    mkdirSync(slicesRoot, { recursive: true });
    indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  function writeSlice(name: string, files: Record<string, string>): void {
    const dir = join(slicesRoot, name);
    mkdirSync(dir, { recursive: true });
    for (const [fname, content] of Object.entries(files)) {
      writeFileSync(join(dir, fname), content);
    }
  }

  function acceptanceOf(name: string) {
    const slice = indexer.get(name);
    expect(slice, `slice ${name} must index`).toBeTruthy();
    return projector.project(slice!).acceptance;
  }

  it("T4a: a PRISTINE scaffold (fresh slice create) counts ZERO acceptance items — the bogus 0/5 dies", () => {
    writeSlice("98-accept", {
      "README.md": acceptTpl.readme,
      "IMPLEMENTATION-PRD.md": acceptTpl.prd,
      "PROGRESS.md": acceptTpl.progress,
    });
    const a = acceptanceOf("98-accept");
    expect(a.totalItems).toBe(0);
    expect(a.doneItems).toBe(0);
    expect(a.percentage).toBe(0);
    expect(a.items).toEqual([]);
  });

  it("T4b: README+PRD duplicate counts ONCE — first file wins for source AND done-state", () => {
    writeSlice("98-accept", {
      "README.md": acceptTpl.readme + "\n## Acceptance\n\n- [x] Ship the gizmo\n",
      "IMPLEMENTATION-PRD.md": acceptTpl.prd + "\n## Extra\n\n- [ ] ship the gizmo  \n",
    });
    const a = acceptanceOf("98-accept");
    expect(a.totalItems).toBe(1);
    expect(a.items[0]!.text).toBe("Ship the gizmo");
    expect(a.items[0]!.done).toBe(true);
    expect(a.items[0]!.source.file).toBe("README.md");
  });

  it("T4c: ONE checked generic row makes all three real (engagement breaks pristine)", () => {
    writeSlice("98-accept", {
      "README.md": acceptTpl.readme,
      "PROGRESS.md": acceptTpl.progress.replace("- [ ] Implementation complete", "- [x] Implementation complete"),
    });
    const a = acceptanceOf("98-accept");
    const progressItems = a.items.filter((i) => i.source.file === "PROGRESS.md");
    expect(progressItems).toHaveLength(3);
    expect(a.doneItems).toBe(1);
  });

  it("T4d (AR-6): an ADDED PROGRESS row with the triple untouched makes all four real", () => {
    writeSlice("98-accept", {
      "README.md": acceptTpl.readme,
      "PROGRESS.md": acceptTpl.progress.replace(
        "- [ ] Review approved",
        "- [ ] Review approved\n- [ ] Wire the modal",
      ),
    });
    const a = acceptanceOf("98-accept");
    const progressItems = a.items.filter((i) => i.source.file === "PROGRESS.md");
    expect(progressItems).toHaveLength(4);
    expect(progressItems.map((i) => i.text)).toContain("Wire the modal");
  });

  it("T4e: an EDITED generic-row text breaks pristine — all rows count", () => {
    writeSlice("98-accept", {
      "README.md": acceptTpl.readme,
      "PROGRESS.md": acceptTpl.progress.replace("- [ ] Tests passing", "- [ ] Tests passing in CI"),
    });
    const a = acceptanceOf("98-accept");
    expect(a.items.filter((i) => i.source.file === "PROGRESS.md")).toHaveLength(3);
  });

  it("T7 (acceptance half): fully-AUTHORED rows project identically — filter never eats a real item", () => {
    writeSlice("98-accept", {
      "README.md": "---\nslice: 98-accept\n---\n# 98-accept\n\n## Acceptance\n\n- [x] Drawer opens right\n- [ ] [P0] range probe 206\n",
      "IMPLEMENTATION-PRD.md": "## Proof contract\n\n- [ ] phone journey video\n",
      "PROGRESS.md": "# Accept\n\n## Rail\n\n- [x] Landed the fix\n",
    });
    const a = acceptanceOf("98-accept");
    expect(a.totalItems).toBe(4);
    expect(a.doneItems).toBe(2);
    expect(a.percentage).toBe(50);
    expect(a.items.map((i) => i.text)).toEqual([
      "Drawer opens right",
      "[P0] range probe 206",
      "phone journey video",
      "Landed the fix",
    ]);
    expect(a.items[1]!.text).toBe("[P0] range probe 206");
  });
});

// ---------------------------------------------------------------------------
// qitem-render-driver B — the projector must consume the SAME shared
// logical-checkbox relation the composer does. compose's rawText is the VM-006
// join key (textKey = trim+lowercase over rawText); the projector today
// re-parses acceptance rows with its OWN single-line regex. If only the
// composer learns continuations, the two sides key off DIFFERENT bytes and the
// QA-verdict lift silently stops matching.
//
// Pinned: AcceptanceItem.text is rawText UNCHANGED (image-bearing rows keep
// their bytes), `done` comes from the checkbox's checked state, and
// source.line remains the CHECKBOX line — never the continuation.
// ---------------------------------------------------------------------------

describe("qitem-render-driver B — projector acceptance rows share the composer's logical-checkbox bytes", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let cleanupRoot: string;
  let indexer: SliceIndexer;
  let projector: SliceDetailProjector;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanupRoot = mkdtempSync(join(tmpdir(), "slice-projector-continuation-"));
    slicesRoot = join(cleanupRoot, "slices");
    mkdirSync(slicesRoot, { recursive: true });
    indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  /** PRD whose contract has a continuation on line 6 (checkbox on line 5). */
  const PRD = [
    "---",
    "id: OPR.T.90",
    "---",
    "## Proof contract",
    "- [ ] the drawer opens on the right",
    "      and stays open across a reload",
    "- [x] the ticked promise",
  ].join("\n");

  it("RED: an acceptance row carries the FULL joined logical text (same bytes the composer keys on)", () => {
    const dir = join(slicesRoot, "90-continuation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "---\nid: OPR.T.90\nstatus: active\n---\n# c\n");
    writeFileSync(join(dir, "IMPLEMENTATION-PRD.md"), PRD);
    const slice = indexer.get("90-continuation")!;
    const acceptance = projector.project(slice).acceptance;
    const joined = acceptance.items.find((i) => i.text.startsWith("the drawer opens on the right"));
    expect(joined, "the continuation row must be present").toBeTruthy();
    expect(joined!.text, "acceptance text must be the joined rawText, byte-identical to the composer's key")
      .toBe("the drawer opens on the right and stays open across a reload");
  });

  it("RED: source.line points at the CHECKBOX line, never the continuation", () => {
    const dir = join(slicesRoot, "91-line");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "---\nid: OPR.T.91\nstatus: active\n---\n# c\n");
    writeFileSync(join(dir, "IMPLEMENTATION-PRD.md"), PRD);
    const slice = indexer.get("91-line")!;
    const acceptance = projector.project(slice).acceptance;
    const joined = acceptance.items.find((i) => i.text.startsWith("the drawer opens on the right"))!;
    expect(joined.source.file).toBe("IMPLEMENTATION-PRD.md");
    expect(joined.source.line, "the checkbox line (1-based), not the continuation line").toBe(5);
  });

  it("GREEN: checked state still drives `done` per row", () => {
    const dir = join(slicesRoot, "92-checked");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "---\nid: OPR.T.92\nstatus: active\n---\n# c\n");
    writeFileSync(join(dir, "IMPLEMENTATION-PRD.md"), PRD);
    const slice = indexer.get("92-checked")!;
    const acceptance = projector.project(slice).acceptance;
    const ticked = acceptance.items.find((i) => i.text === "the ticked promise")!;
    expect(ticked.done).toBe(true);
  });
});
