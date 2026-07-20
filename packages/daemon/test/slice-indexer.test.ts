// Slice Story View v0 — slice indexer focused tests.
//
// Drives the indexer against a temp filesystem fixture (fully isolated
// from the real substrate-side slices folder so the test stays
// deterministic and parallel-safe). Covers:
//
//   - frontmatter parsing + display name fallback
//   - status enum mapping (incl. heuristic fallbacks)
//   - rail-item extraction from frontmatter
//   - qitem matching strategies (slice-name/mission body + tags)
//   - dogfood-evidence proof packet detection (with screenshots / videos / traces)
//   - cache TTL invalidation
//   - graceful degradation when slicesRoot is unset / queue_items missing

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer, parseFrontmatter } from "../src/domain/slices/slice-indexer.js";

function makeTempDirs(): { slicesRoot: string; dogfoodRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-test-"));
  const slicesRoot = path.join(base, "slices");
  const dogfoodRoot = path.join(base, "dogfood-evidence");
  fs.mkdirSync(slicesRoot, { recursive: true });
  fs.mkdirSync(dogfoodRoot, { recursive: true });
  return { slicesRoot, dogfoodRoot };
}

function writeSlice(slicesRoot: string, name: string, files: Record<string, string>): void {
  const dir = path.join(slicesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function insertQitem(db: Database.Database, opts: { qitemId: string; body: string; tags?: string[]; tsCreated?: string; tsUpdated?: string }): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tags, body)
     VALUES (?, ?, ?, ?, ?, ?, 'routine', ?, ?)`
  ).run(
    opts.qitemId,
    opts.tsCreated ?? "2026-05-04T00:00:00.000Z",
    opts.tsUpdated ?? "2026-05-04T00:00:00.000Z",
    "src@r",
    "dst@r",
    "in-progress",
    opts.tags ? JSON.stringify(opts.tags) : null,
    opts.body,
  );
}

describe("PL-slice-story-view-v0 SliceIndexer", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let dogfoodRoot: string;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const dirs = makeTempDirs();
    slicesRoot = dirs.slicesRoot;
    dogfoodRoot = dirs.dogfoodRoot;
    cleanup = path.dirname(slicesRoot);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  describe("frontmatter parsing", () => {
    it("parses simple key: value pairs between --- markers", () => {
      const fm = parseFrontmatter("---\nname: foo\nstatus: active\n---\nbody");
      expect(fm).toEqual({ name: "foo", status: "active" });
    });

    it("strips wrapping single + double quotes from values", () => {
      const fm = parseFrontmatter(`---\nslice: 'pl-019-x'\ntitle: "Quoted"\n---\nbody`);
      expect(fm.slice).toBe("pl-019-x");
      expect(fm.title).toBe("Quoted");
    });

    it("returns empty object when no frontmatter delimiter present", () => {
      expect(parseFrontmatter("# Just markdown")).toEqual({});
    });

    it("returns empty object on unterminated frontmatter", () => {
      expect(parseFrontmatter("---\nslice: x\nno-end-marker")).toEqual({});
    });
  });

  describe("isReady + graceful degradation", () => {
    it("isReady() returns false when slicesRoot is empty string", () => {
      const indexer = new SliceIndexer({ slicesRoot: "", dogfoodEvidenceRoot: null, db });
      expect(indexer.isReady()).toBe(false);
      expect(indexer.list()).toEqual([]);
      expect(indexer.get("anything")).toBeNull();
    });

    it("isReady() returns false when slicesRoot path doesn't exist", () => {
      const indexer = new SliceIndexer({ slicesRoot: "/nonexistent/path/foo", dogfoodEvidenceRoot: null, db });
      expect(indexer.isReady()).toBe(false);
    });

    it("isReady() returns true when slicesRoot exists as a directory", () => {
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.isReady()).toBe(true);
    });
  });

  describe("listing + display name + status mapping", () => {
    it("enumerates slice directories and skips dotfiles", () => {
      writeSlice(slicesRoot, "alpha-slice", { "README.md": "---\nstatus: active\n---\n# Alpha" });
      writeSlice(slicesRoot, "beta-slice", { "README.md": "---\nstatus: shipped\n---\n# Beta" });
      fs.mkdirSync(path.join(slicesRoot, ".hidden"));
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries.map((e) => e.name).sort()).toEqual(["alpha-slice", "beta-slice"]);
    });

    it("enumerates mission-aware workspace layout under missions/<mission>/slices/<slice>", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "idea-ledger", "slices"), "capture-product-ideas", {
        "README.md": "---\ntitle: Capture Product Ideas\nstatus: active\n---\n# Capture\n",
      });
      writeSlice(path.join(missionsRoot, "handoff-loop", "slices"), "route-work-packets", {
        "README.md": "---\nstatus: draft\n---\n# Route\n",
      });

      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries.map((e) => [e.name, e.missionId])).toEqual([
        ["capture-product-ideas", "idea-ledger"],
        ["route-work-packets", "handoff-loop"],
      ]);
      expect(indexer.get("capture-product-ideas")?.slicePath).toBe(
        path.join(missionsRoot, "idea-ledger", "slices", "capture-product-ideas"),
      );
    });

    it("can index legacy flat slices and mission-aware slices from compatibility roots", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(slicesRoot, "legacy-flat-slice", {
        "README.md": "---\nstatus: active\n---\n# Legacy\n",
      });
      writeSlice(path.join(missionsRoot, "demo-seed", "slices"), "idea-ledger-find-ideas-cycle-4", {
        "README.md": "---\ntitle: Find Ideas Cycle 4\nstatus: active\n---\n# Cycle 4\n",
      });

      const indexer = new SliceIndexer({
        slicesRoot,
        additionalSliceRoots: [missionsRoot],
        dogfoodEvidenceRoot: null,
        db,
      });
      const byName = new Map(indexer.list().map((entry) => [entry.name, entry]));
      expect(byName.get("legacy-flat-slice")?.missionId).toBeNull();
      expect(byName.get("idea-ledger-find-ideas-cycle-4")?.missionId).toBe("demo-seed");
      expect(indexer.get("idea-ledger-find-ideas-cycle-4")?.slicePath).toBe(
        path.join(missionsRoot, "demo-seed", "slices", "idea-ledger-find-ideas-cycle-4"),
      );
    });

    it("derives displayName from frontmatter title, then first H1, then folder name", () => {
      writeSlice(slicesRoot, "from-title", { "README.md": "---\ntitle: Custom Title\n---\n# Heading" });
      writeSlice(slicesRoot, "from-h1", { "README.md": "---\nstatus: draft\n---\n# H1 Heading\nbody" });
      writeSlice(slicesRoot, "no-doc", {});
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const byName = new Map(indexer.list().map((e) => [e.name, e.displayName]));
      expect(byName.get("from-title")).toBe("Custom Title");
      expect(byName.get("from-h1")).toBe("H1 Heading");
      expect(byName.get("no-doc")).toBe("no-doc");
    });

    it("maps frontmatter status to canonical buckets", () => {
      writeSlice(slicesRoot, "s1", { "README.md": "---\nstatus: active\n---\n" });
      writeSlice(slicesRoot, "s2", { "README.md": "---\nstatus: shipped\n---\n" });
      writeSlice(slicesRoot, "s3", { "README.md": "---\nstatus: parked-with-evidence\n---\n" });
      writeSlice(slicesRoot, "s4", { "README.md": "---\nstatus: draft-pending-orch-ratification\n---\n" });
      writeSlice(slicesRoot, "s5", { "README.md": "---\n---\n" }); // no status
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const byName = new Map(indexer.list().map((e) => [e.name, e.status]));
      expect(byName.get("s1")).toBe("active");
      expect(byName.get("s2")).toBe("done");
      expect(byName.get("s3")).toBe("blocked");
      expect(byName.get("s4")).toBe("draft");
      expect(byName.get("s5")).toBe("draft");
    });

    it("uses PROGRESS.md status as the current slice cursor over stale README dispatch status", () => {
      writeSlice(slicesRoot, "mission-control-queue-observability-phase-a", {
        "README.md": "---\nslice: mission-control-queue-observability-phase-a\nstatus: ready-for-delivery-dispatch\nrail-item: PL-005\n---\n# Mission Control Phase A\n",
        "PROGRESS.md": "---\ndoc: mission-control-progress\nstatus: phase-a-closed-locally-promoted\nrail-item: PL-005\n---\n# Progress\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entry = indexer.list()[0]!;
      const detail = indexer.get("mission-control-queue-observability-phase-a")!;

      expect(entry.rawStatus).toBe("phase-a-closed-locally-promoted");
      expect(entry.status).toBe("done");
      expect(entry.displayName).toBe("mission-control-queue-observability-phase-a");
      expect(detail.rawStatus).toBe("phase-a-closed-locally-promoted");
      expect(detail.status).toBe("done");
    });
  });

  describe("rail-item extraction", () => {
    it("pulls rail-item from frontmatter scalar", () => {
      writeSlice(slicesRoot, "x", { "IMPLEMENTATION-PRD.md": "---\nrail-item: PL-019\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.list()[0]!.railItem).toBe("PL-019");
    });

    it("strips bracket array notation that YAML parser left as string", () => {
      writeSlice(slicesRoot, "x", { "IMPLEMENTATION-PRD.md": "---\nrelated-rail-items: [PL-008]\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.list()[0]!.railItem).toBe("PL-008");
    });
  });

  // V0.3.1 slice 13 walk-item 7 — workflow_spec frontmatter parsing.
  // The mission Topology tab (and slice Topology fallback) projects
  // a spec graph from this declaration even when no live workflow
  // instance is bound. Format: `workflow_spec: <name>@<version>`.
  describe("workflow_spec frontmatter", () => {
    it("parses workflow_spec: <name>@<version> from frontmatter onto SliceRecord + SliceListEntry", () => {
      writeSlice(slicesRoot, "topo-slice", {
        "README.md": "---\nstatus: active\nworkflow_spec: openrig-velocity@1.0\n---\n# Topo\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const list = indexer.list();
      expect(list[0]!.workflowSpec).toEqual({ name: "openrig-velocity", version: "1.0" });
      const record = indexer.get("topo-slice")!;
      expect(record.workflowSpec).toEqual({ name: "openrig-velocity", version: "1.0" });
    });

    it("returns workflowSpec: null when the frontmatter field is absent", () => {
      writeSlice(slicesRoot, "no-topo-slice", {
        "README.md": "---\nstatus: active\n---\n# Plain\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const list = indexer.list();
      expect(list[0]!.workflowSpec).toBeNull();
      expect(indexer.get("no-topo-slice")!.workflowSpec).toBeNull();
    });

    it("ignores malformed workflow_spec values that do not match <name>@<version>", () => {
      writeSlice(slicesRoot, "bad-topo-slice", {
        "README.md": "---\nstatus: active\nworkflow_spec: not-a-valid-spec-ref\n---\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.list()[0]!.workflowSpec).toBeNull();
    });
  });

  describe("qitem matching", () => {
    it("matches qitems by slice-name body substring", () => {
      writeSlice(slicesRoot, "mission-control-phase-a", { "README.md": "---\nstatus: shipped\n---\n" });
      insertQitem(db, { qitemId: "q-match-1", body: "PL-005 Phase A mission-control-phase-a dispatch" });
      insertQitem(db, { qitemId: "q-match-2", body: "Re: mission-control-phase-a Q&A" });
      insertQitem(db, { qitemId: "q-no-match", body: "Some other slice work" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("mission-control-phase-a")!;
      expect(slice.qitemIds.sort()).toEqual(["q-match-1", "q-match-2"]);
    });

    it("also matches qitems by rail-item body substring (union with slice-name matches)", () => {
      writeSlice(slicesRoot, "topology-activity-indicators-v0", {
        "IMPLEMENTATION-PRD.md": "---\nrail-item: PL-019\nstatus: active\n---\n",
      });
      insertQitem(db, { qitemId: "q-by-name", body: "topology-activity-indicators-v0 dispatch" });
      insertQitem(db, { qitemId: "q-by-rail", body: "PL-019 follow-up" });
      insertQitem(db, { qitemId: "q-none", body: "something else" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("topology-activity-indicators-v0")!;
      expect(slice.qitemIds.sort()).toEqual(["q-by-name", "q-by-rail"]);
    });

    it("matches nested mission slices by mission id and tags", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "idea-ledger", "slices"), "triage-product-ideas", {
        "README.md": "---\nstatus: active\n---\n# Triage\n",
      });
      insertQitem(db, {
        qitemId: "q-by-mission-body",
        body: "Advance the idea-ledger mission.",
      });
      insertQitem(db, {
        qitemId: "q-by-slice-tag",
        body: "No visible slice name here.",
        tags: ["triage-product-ideas"],
      });
      insertQitem(db, {
        qitemId: "q-none",
        body: "Other project",
        tags: ["unrelated"],
      });

      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("triage-product-ideas")!;
      expect(slice.missionId).toBe("idea-ledger");
      expect(slice.railItem).toBe("idea-ledger");
      expect(slice.qitemIds.sort()).toEqual(["q-by-mission-body", "q-by-slice-tag"]);
    });

    // V0.3.1 slice 17 founder-walk-workspace-state-correctness — walk item 3.
    // The over-match bug: a qitem tagged ONLY mission:<missionId>
    // (no `slice:` tag, no slice-name body mention) was returning
    // under EVERY slice in that mission because matchQitems unioned
    // the missionId substring term across all slices. Fix: when at
    // least one qitem has the typed `slice:<sliceName>` tag, the
    // missionId substring term is dropped from the union so
    // mission-tagged-only qitems no longer pollute the slice's queue.
    // Substring fallback is preserved for slices without typed-tag
    // qitems (legacy corpus compatibility — HG-2).
    it("when typed slice:<name> tag matches exist, typed tags are authoritative: mission-only AND body-substring-only qitems are NOT included (VM-004)", () => {
      // Production shape: slices/missions root with a mission folder
      // containing the slice. missionId resolves to the mission folder
      // name; railItem defaults to missionId when frontmatter doesn't
      // specify one.
      //
      // VM-004 (canonical scope-membership matcher): typed tags are
      // AUTHORITATIVE. When ANY confirmed `slice:<name>` typed row exists,
      // the substring fallback tier is gated OFF entirely — so neither the
      // mission-only qitem NOR the body-substring-only qitem leaks into the
      // slice queue. (Pre-VM-004 the substring tier always ran and kept the
      // sliceName body-substring match; that leak is exactly what VM-004
      // closes. Legacy zero-typed corpora keep the full substring fallback —
      // see the sibling "preserves legacy substring fallback" test.)
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "release-fake", "slices"), "fake-slice-17", {
        "README.md": "---\nstatus: active\nrail-item: WALK-17\n---\n# Fake 17\n",
      });
      insertQitem(db, {
        qitemId: "q-typed-slice-tag",
        body: "Body without slice name.",
        tags: ["slice:fake-slice-17"],
      });
      insertQitem(db, {
        qitemId: "q-mission-tag-only",
        body: "Body without slice name.",
        tags: ["mission:release-fake"],
      });
      insertQitem(db, {
        qitemId: "q-by-slice-name-body",
        body: "fake-slice-17 mention in body.",
        tags: [],
      });
      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("fake-slice-17")!;
      expect(slice.qitemIds).toEqual(["q-typed-slice-tag"]);
      expect(slice.qitemIds).not.toContain("q-mission-tag-only");
      expect(slice.qitemIds).not.toContain("q-by-slice-name-body");
    });

    it("does not re-include mission-only qitems when railItem defaults to missionId", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "release-fake-default-rail", "slices"), "fake-slice-default-rail", {
        "README.md": "---\nstatus: active\n---\n# Fake default rail\n",
      });
      insertQitem(db, {
        qitemId: "q-default-rail-typed-slice-tag",
        body: "Body without slice name.",
        tags: ["slice:fake-slice-default-rail"],
      });
      insertQitem(db, {
        qitemId: "q-default-rail-mission-tag-only",
        body: "Body without slice name.",
        tags: ["mission:release-fake-default-rail"],
      });

      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("fake-slice-default-rail")!;
      expect(slice.railItem).toBe("release-fake-default-rail");
      expect(slice.qitemIds).toEqual(["q-default-rail-typed-slice-tag"]);
      expect(slice.qitemIds).not.toContain("q-default-rail-mission-tag-only");
    });

    it("preserves legacy substring fallback (including mission body) when NO typed slice: tag exists", () => {
      // When no qitem has the typed `slice:<name>` tag, the indexer
      // falls back to the pre-fix three-term substring union so older
      // dogfood corpora keep matching the way they did before this
      // slice landed.
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "legacy-mission", "slices"), "legacy-slice", {
        "README.md": "---\nstatus: active\nrail-item: LEGACY-RAIL\n---\n",
      });
      insertQitem(db, { qitemId: "q-legacy-by-mission", body: "advance the legacy-mission mission", tags: [] });
      insertQitem(db, { qitemId: "q-legacy-by-name", body: "legacy-slice work item", tags: [] });
      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("legacy-slice")!;
      // Both match: mission body via missionId substring, name body via sliceName substring.
      expect(slice.qitemIds.sort()).toEqual(["q-legacy-by-mission", "q-legacy-by-name"]);
    });

    // V0.3.1 slice 17 walk item 10 — forward-fix #1. The slice-detail
    // Queue tab consumes `detail.qitemIds` unchanged from the backend,
    // so the DESC-by-ts_created order has to be applied by the indexer
    // itself (the Phase A frontend rollup sort only covers the
    // workspace/mission rollup view). Three distinct ts_created values
    // discriminate the ordering per banked
    // feedback_poc_regression_must_discriminate.
    it("matchQitems returns qitemIds sorted DESC by ts_created (slice tab consumes this order unchanged)", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "fwx-mission", "slices"), "fwx-slice", {
        "README.md": "---\nstatus: active\nrail-item: FWX-RAIL\n---\n",
      });
      insertQitem(db, {
        qitemId: "q-oldest",
        body: "tagged for fwx-slice",
        tags: ["slice:fwx-slice"],
        tsCreated: "2026-05-11T09:00:00.000Z",
      });
      insertQitem(db, {
        qitemId: "q-middle",
        body: "tagged for fwx-slice",
        tags: ["slice:fwx-slice"],
        tsCreated: "2026-05-11T10:00:00.000Z",
      });
      insertQitem(db, {
        qitemId: "q-newest",
        body: "tagged for fwx-slice",
        tags: ["slice:fwx-slice"],
        tsCreated: "2026-05-11T11:00:00.000Z",
      });
      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("fwx-slice")!;
      // Strict order: newest first, oldest last. NOT alphabetic by id.
      expect(slice.qitemIds).toEqual(["q-newest", "q-middle", "q-oldest"]);
    });

    it("returns empty qitem set when queue_items table is absent", () => {
      // Re-create db without queue_items to simulate the test-harness gap.
      const bareDb = createDb();
      migrate(bareDb, [coreSchema]);
      writeSlice(slicesRoot, "x", { "README.md": "---\nrail-item: PL-005\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db: bareDb });
      expect(indexer.list()[0]!.qitemCount).toBe(0);
      bareDb.close();
    });
  });

  describe("proof packet detection", () => {
    it("matches dogfood-evidence dir whose name contains the slice name", () => {
      writeSlice(slicesRoot, "mission-control-queue-observability-phase-a", { "README.md": "---\n---\n" });
      const proofDir = path.join(dogfoodRoot, "pl005-phase-a-mission-control-queue-observability-20260504");
      fs.mkdirSync(proofDir);
      fs.writeFileSync(path.join(proofDir, "PL005-phase-a-headed-browser-dogfood.md"), "All green");
      fs.mkdirSync(path.join(proofDir, "screenshots"));
      fs.writeFileSync(path.join(proofDir, "screenshots", "mc-active-work.png"), "fake-png");
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      const slice = indexer.get("mission-control-queue-observability-phase-a")!;
      expect(slice.proofPacket).not.toBeNull();
      expect(slice.proofPacket!.dirName).toBe("pl005-phase-a-mission-control-queue-observability-20260504");
      expect(slice.proofPacket!.markdownFiles).toContain("PL005-phase-a-headed-browser-dogfood.md");
      expect(slice.proofPacket!.screenshots).toEqual(["screenshots/mc-active-work.png"]);
      expect(slice.proofPacket!.videos).toEqual([]); // none captured (matches reality at dispatch time)
      expect(slice.proofPacket!.traces).toEqual([]);
    });

    it("strips trailing -v0 / -v1 suffix when matching proof packet directories", () => {
      writeSlice(slicesRoot, "topology-activity-indicators-v0", { "README.md": "---\n---\n" });
      const proofDir = path.join(dogfoodRoot, "pl019-topology-activity-indicators-20260504");
      fs.mkdirSync(proofDir);
      fs.writeFileSync(path.join(proofDir, "evidence.md"), "");
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      expect(indexer.get("topology-activity-indicators-v0")!.proofPacket?.dirName)
        .toBe("pl019-topology-activity-indicators-20260504");
    });

    it("picks the latest-mtime directory when multiple proof packets match", () => {
      writeSlice(slicesRoot, "x-slice", { "README.md": "---\n---\n" });
      const oldDir = path.join(dogfoodRoot, "x-slice-20260101");
      const newDir = path.join(dogfoodRoot, "x-slice-20260601");
      fs.mkdirSync(oldDir);
      fs.mkdirSync(newDir);
      // Force mtime ordering.
      fs.utimesSync(oldDir, new Date("2026-01-01"), new Date("2026-01-01"));
      fs.utimesSync(newDir, new Date("2026-06-01"), new Date("2026-06-01"));
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      expect(indexer.get("x-slice")!.proofPacket?.dirName).toBe("x-slice-20260601");
    });

    it("classifies .mp4/.webm files as videos", () => {
      writeSlice(slicesRoot, "video-slice", { "README.md": "---\n---\n" });
      const proofDir = path.join(dogfoodRoot, "video-slice-20260504");
      fs.mkdirSync(proofDir);
      fs.mkdirSync(path.join(proofDir, "videos"));
      fs.writeFileSync(path.join(proofDir, "videos", "demo.mp4"), "fake");
      fs.writeFileSync(path.join(proofDir, "videos", "demo2.webm"), "fake");
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      expect(indexer.get("video-slice")!.proofPacket!.videos.sort()).toEqual([
        "videos/demo.mp4",
        "videos/demo2.webm",
      ]);
    });

    it("returns null proofPacket when dogfoodRoot is unset", () => {
      writeSlice(slicesRoot, "x", { "README.md": "---\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.get("x")!.proofPacket).toBeNull();
    });
  });

  describe("cache invalidation", () => {
    it("invalidate() drops both list + detail caches", () => {
      writeSlice(slicesRoot, "x", { "README.md": "---\n---\n# X" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const first = indexer.list();
      expect(first).toHaveLength(1);
      writeSlice(slicesRoot, "y", { "README.md": "---\n---\n# Y" });
      // Cached — still 1.
      expect(indexer.list()).toHaveLength(1);
      indexer.invalidate();
      expect(indexer.list()).toHaveLength(2);
    });
  });

  // OPR.0.3.2.17 — SliceListEntry surfaces frontmatter `description`
  // so the storytelling adapter can use it as ConceptCard.oneLiner
  // for `rawStatus === "candidate"` slices. Mapping: description first,
  // summary fallback, null when both absent.
  describe("OPR.0.3.2.17 — frontmatter description exposed on SliceListEntry", () => {
    it("description: <text> populates SliceListEntry.description", () => {
      writeSlice(slicesRoot, "concept-restore", {
        "README.md": "---\nstatus: candidate\ndescription: First-class restore packet.\n---\n# Restore",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.description).toBe("First-class restore packet.");
      expect(entries[0]!.rawStatus).toBe("candidate");
    });

    it("summary: <text> is the fallback when description is absent", () => {
      writeSlice(slicesRoot, "concept-with-summary", {
        "README.md": "---\nstatus: candidate\nsummary: Falls back to summary.\n---\n# Slice",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.description).toBe("Falls back to summary.");
    });

    it("description=null when both description and summary are absent", () => {
      writeSlice(slicesRoot, "no-desc", {
        "README.md": "---\nstatus: candidate\n---\n# No desc",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries[0]!.description).toBeNull();
    });

    it("empty/whitespace-only description value is normalized to null (graceful-empty input)", () => {
      writeSlice(slicesRoot, "empty-desc", {
        "README.md": "---\nstatus: candidate\ndescription: '   '\n---\n# Slice",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries[0]!.description).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// qitem-ccf87c0d — Project mission-index LOAD CONTRACT (guard-amended RED).
// Forensic root cause: matchQitems runs O(slices) full-table queue_items LIKE
// scans per cold rebuild (tier-1 wildcard+ORDER BY always; up to 3 more
// body-LIKE scans per zero-typed slice) — 353 slices at host scale = ~10s
// cold, synchronously blocking the daemon event loop. The contract below
// counts EXECUTIONS of queue_items LIKE statements (not prepare calls):
// a cold rebuild must run a CONSTANT number of scan-shaped statements,
// independent of slice count. Behavior pins ride alongside so the batch
// rewrite cannot drift membership semantics.
// ---------------------------------------------------------------------------

describe("qitem-ccf87c0d — mission-index load contract + membership pins", () => {
  let db: Database.Database;
  let cleanup: string;
  let missionsRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-load-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  /** Count EXECUTIONS (.all/.iterate/.get calls) of statements that both
   *  name queue_items and carry a LIKE — the scan-shaped statements. run()
   *  passes through uncounted (INSERT seeding). Non-LIKE statements are
   *  returned unwrapped. */
  function instrumentLikeExecutions(target: Database.Database): () => number {
    let n = 0;
    const origPrepare = target.prepare.bind(target);
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (!/queue_items/i.test(sql) || !/\bLIKE\b/i.test(sql)) return stmt;
      return {
        all: (...a: unknown[]) => { n++; return stmt.all!(...a); },
        iterate: (...a: unknown[]) => { n++; return stmt.iterate!(...a); },
        get: (...a: unknown[]) => { n++; return stmt.get!(...a); },
        run: (...a: unknown[]) => stmt.run!(...a),
      };
    };
    return () => n;
  }

  /** Exact seed: 2 missions x 20 slices = 40 slices; the first 12 (30%) are
   *  typed (one confirmed `slice:` row each); 60 qitems total (12 typed rows
   *  + 48 zero-typed rows with 200-byte bodies). */
  function seedFixture(): { typedSlices: string[]; untypedSlices: string[] } {
    const typedSlices: string[] = [];
    const untypedSlices: string[] = [];
    const filler = "b".repeat(200);
    let idx = 0;
    for (let m = 0; m < 2; m++) {
      const mission = `load-mission-${m}`;
      for (let s = 0; s < 20; s++, idx++) {
        const slice = `ld-${String(idx).padStart(2, "0")}-topic`;
        writeSlice(path.join(missionsRoot, mission, "slices"), slice, {
          "README.md": `---\nstatus: active\n---\n# ${slice}\n`,
        });
        if (idx < 12) typedSlices.push(slice);
        else untypedSlices.push(slice);
      }
    }
    for (let i = 0; i < 12; i++) {
      insertQitem(db, {
        qitemId: `q-typed-${String(i).padStart(2, "0")}`,
        body: `typed packet ${i} ${filler}`,
        tags: [`slice:${typedSlices[i]!}`],
        tsCreated: `2026-07-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }
    for (let i = 0; i < 48; i++) {
      insertQitem(db, {
        qitemId: `q-plain-${String(i).padStart(2, "0")}`,
        body: `generic packet ${i} ${filler}`,
        tags: ["release:0.4.7"],
        tsCreated: `2026-07-02T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
      });
    }
    return { typedSlices, untypedSlices };
  }

  it("LOAD CONTRACT (RED): one cold list() over 40 slices executes a CONSTANT number of queue_items LIKE statements (<= 4), independent of slice count", () => {
    const { typedSlices } = seedFixture();
    const likeCount = instrumentLikeExecutions(db);
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const entries = indexer.list();
    expect(entries).toHaveLength(40);
    // Membership sanity inside the same rebuild: a typed slice carries its row.
    const typed0 = entries.find((e) => e.name === typedSlices[0])!;
    expect(typed0.qitemCount).toBe(1);
    // The contract: constant scan count. Pre-fix this executes
    // 40 tier-1 LIKE iterations + 2 dedup'd fallback LIKEs for each of the
    // 28 zero-typed slices (= 96 total). Post-fix: bounded constant.
    expect(likeCount()).toBeLessThanOrEqual(4);
  });

  it("PIN: invalidate() picks up a fresh slice folder AND its typed membership (Explorer auto-show read-after-write)", () => {
    seedFixture();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.list()).toHaveLength(40);
    writeSlice(path.join(missionsRoot, "load-mission-0", "slices"), "ld-fresh-folder", {
      "README.md": "---\nstatus: active\n---\n# Fresh\n",
    });
    insertQitem(db, {
      qitemId: "q-fresh-typed",
      body: "fresh dispatch",
      tags: ["slice:ld-fresh-folder"],
    });
    indexer.invalidate();
    const after = indexer.list();
    expect(after).toHaveLength(41);
    expect(after.find((e) => e.name === "ld-fresh-folder")!.qitemCount).toBe(1);
    expect(indexer.get("ld-fresh-folder")!.qitemIds).toEqual(["q-fresh-typed"]);
  });

  it("PIN: cold direct get() BEFORE any list() resolves correct typed membership", () => {
    const { typedSlices } = seedFixture();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    // No list() call first — the detail path must build whatever index it
    // needs lazily.
    const record = indexer.get(typedSlices[3]!)!;
    expect(record.qitemIds).toEqual(["q-typed-03"]);
  });

  it("PIN: TTL expiry refreshes membership WITHOUT an explicit invalidate", async () => {
    const { typedSlices } = seedFixture();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db, cacheTtlMs: 40 });
    expect(indexer.get(typedSlices[0]!)!.qitemIds).toEqual(["q-typed-00"]);
    insertQitem(db, {
      qitemId: "q-typed-00-later",
      body: "late dispatch",
      tags: [`slice:${typedSlices[0]!}`],
      tsCreated: "2026-07-03T00:00:00.000Z",
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(indexer.get(typedSlices[0]!)!.qitemIds).toEqual(["q-typed-00-later", "q-typed-00"]);
  });

  it("PIN: overlapping zero-typed fallback terms credit ONE row to EVERY matching slice (no consuming-alternation loss)", () => {
    // Flat root: railItem/missionId are null, so each slice's only fallback
    // term is its name. The two names OVERLAP inside one body string —
    // "alpha-beta-gamma" contains both "alpha-beta" and "beta-gamma" with a
    // shared "beta" segment. A naive single consuming alternation would
    // credit only the first.
    const flatRoot = path.join(cleanup, "flat-slices");
    writeSlice(flatRoot, "alpha-beta", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(flatRoot, "beta-gamma", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-overlap", body: "work on alpha-beta-gamma today", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("alpha-beta")!.qitemIds).toEqual(["q-overlap"]);
    expect(indexer.get("beta-gamma")!.qitemIds).toEqual(["q-overlap"]);
  });

  it("PIN: SQL-LIKE ASCII case-insensitivity is preserved in the fallback tier", () => {
    const flatRoot = path.join(cleanup, "flat-ci");
    writeSlice(flatRoot, "case-probe", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-upper", body: "Ref: CASE-PROBE follow-up", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("case-probe")!.qitemIds).toEqual(["q-upper"]);
  });

  it("PIN: SQL-LIKE wildcard semantics preserved — an underscore in a slice name matches any single body character (current behavior, byte-for-byte)", () => {
    // Fallback terms come from folder names / frontmatter, which CAN carry
    // `_` (and in principle `%`). Today those bytes are LIKE wildcards:
    // body LIKE '%under_score-slice%' matches "underXscore-slice". The
    // batch rewrite must translate, not literalize, these bytes.
    const flatRoot = path.join(cleanup, "flat-wildcard");
    writeSlice(flatRoot, "under_score-slice", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-wild-x", body: "see underXscore-slice notes", tags: [] });
    insertQitem(db, { qitemId: "q-wild-lit", body: "see under_score-slice notes", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("under_score-slice")!.qitemIds.sort()).toEqual(["q-wild-lit", "q-wild-x"]);
  });

  it("PIN: tags-column-missing degradation — fallback still matches by body (tier-1 failure is caught)", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema]);
    bareDb.exec(`CREATE TABLE queue_items (
      qitem_id TEXT PRIMARY KEY, ts_created TEXT NOT NULL, ts_updated TEXT NOT NULL,
      source_session TEXT NOT NULL, destination_session TEXT NOT NULL, state TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'routine', body TEXT NOT NULL)`);
    bareDb.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
       VALUES ('q-no-tags-col', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'a@r', 'b@r', 'done', 'notagcol-slice work')`,
    ).run();
    const flatRoot = path.join(cleanup, "flat-notags");
    writeSlice(flatRoot, "notagcol-slice", { "README.md": "---\nstatus: active\n---\n" });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db: bareDb });
    expect(indexer.get("notagcol-slice")!.qitemIds).toEqual(["q-no-tags-col"]);
    bareDb.close();
  });
});

// qitem-ccf87c0d guard RED-verdict delta — two byte-equivalence blockers
// pinned against the CURRENT engine before any batch matcher lands.
describe("qitem-ccf87c0d — LIKE byte-equivalence + fallback-order pins (guard delta)", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-eqv-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("PIN: SQLite LIKE folds ASCII ONLY — non-ASCII case variants (æ vs Æ) do NOT match; ASCII letters still fold", () => {
    const flatRoot = path.join(cleanup, "flat-ascii-fold");
    writeSlice(flatRoot, "graey-æ-slice", { "README.md": "---\nstatus: active\n---\n" });
    // Æ (U+00C6) is the Unicode uppercase of æ (U+00E6): a JS /i regex would
    // match it; SQLite LIKE must NOT (ASCII-only fold).
    insertQitem(db, { qitemId: "q-unicode-upper", body: "ref GRAEY-Æ-SLICE here", tags: [] });
    // Same æ byte, ASCII letters case-varied: LIKE matches.
    insertQitem(db, { qitemId: "q-ascii-fold", body: "ref GRAEY-æ-SLICE here", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("graey-æ-slice")!.qitemIds).toEqual(["q-ascii-fold"]);
  });

  it("PIN: LIKE wildcards match across NEWLINE — an underscore in a slice name matches '\\n' in the body (dotAll-equivalent behavior required)", () => {
    const flatRoot = path.join(cleanup, "flat-nl-wild");
    writeSlice(flatRoot, "nl_probe", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-newline-wild", body: "prefix nl\nprobe suffix", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("nl_probe")!.qitemIds).toEqual(["q-newline-wild"]);
  });

  it("PIN: equal-ts fallback rows keep TERM-FIRST order ([sliceName, railItem]), not DB row order", () => {
    // Row matching ONLY the railItem term is inserted FIRST in the DB; the
    // row matching ONLY the sliceName term second; identical ts_created.
    // Current engine: terms iterate [sliceName, railItem], ids enter the Set
    // in term order, and the final ts-DESC sort is stable on equals — so the
    // sliceName-matched row renders first. A row-first batch scan would
    // emit DB order and flip them.
    const flatRoot = path.join(cleanup, "flat-term-order");
    writeSlice(flatRoot, "term-order-slice", {
      "README.md": "---\nstatus: active\nrail-item: TORD-RAIL\n---\n",
    });
    const ts = "2026-07-05T12:00:00.000Z";
    insertQitem(db, { qitemId: "q-a-railitem", body: "TORD-RAIL work", tags: [], tsCreated: ts });
    insertQitem(db, { qitemId: "q-b-slicename", body: "term-order-slice work", tags: [], tsCreated: ts });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("term-order-slice")!.qitemIds).toEqual(["q-b-slicename", "q-a-railitem"]);
  });
});

// qitem-ccf87c0d guard POST-EDIT blocker — code-point parity for LIKE '_'.
describe("qitem-ccf87c0d — LIKE '_' Unicode code-point parity (guard blocker pin)", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-cp-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("PIN: '_' matches ONE CHARACTER (code point) — an astral emoji (surrogate pair in UTF-16) satisfies a single '_', exactly like SQLite", () => {
    // SQLite LIKE '%emoji_probe%' matches body 'emoji😀probe' — 😀 (U+1F600)
    // is one character. A UTF-16 code-unit matcher ([\s\S]) consumes only
    // half the surrogate pair and misses; the translation must be
    // code-point-correct (dotAll + u).
    const flatRoot = path.join(cleanup, "flat-cp");
    writeSlice(flatRoot, "emoji_probe", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-astral", body: "see emoji\u{1F600}probe notes", tags: [] });
    // Two-code-unit ASCII sequence must still NOT match a single '_':
    insertQitem(db, { qitemId: "q-two-chars", body: "see emojiXYprobe notes", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("emoji_probe")!.qitemIds).toEqual(["q-astral"]);
  });
});

// qitem-18f3300d — guard's two candidate-blocking regressions vs parent
// 7b19b73e, RED against sealed candidate c8f85802 (test-only gate).
describe("qitem-18f3300d — NUL parity + cross-operation membership freshness (RED vs candidate)", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-gate2-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("RED: SQLite LIKE truncates the haystack at raw U+0000 — a fallback term occurring ONLY AFTER a NUL must be EXCLUDED (parent behavior); before-NUL control stays included", () => {
    // Production-reachable: POST /api/queue/create JSON-decodes
    // "before\u0000slice-after" to a JS string with a raw NUL and stores it
    // in queue_items.body unrejected. Parent per-slice SQL (body LIKE
    // '%<term>%') returns NO row when the term sits after the NUL; the
    // candidate's JS regex scans through NUL and wrongly includes it.
    const flatRoot = path.join(cleanup, "flat-nul");
    writeSlice(flatRoot, "nul-term-slice", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-after-nul", body: "prefix\u0000nul-term-slice suffix", tags: [] });
    insertQitem(db, { qitemId: "q-before-nul", body: "nul-term-slice mentioned\u0000trailing junk", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("nul-term-slice")!.qitemIds).toEqual(["q-before-nul"]);
  });

  it("RED: NUL in the PATTERN side — rail-item 'RAIL\\u0000TAIL' binds %RAIL\\u0000TAIL%; SQLite truncates the PATTERN to %RAIL, LOSING the trailing wildcard: body ENDING in RAIL matches, RAIL mid-body does NOT", () => {
    // Parent SQL binds the full pattern '%RAIL\u0000TAIL%'; SQLite truncates
    // it at the NUL to '%RAIL' — now END-ANCHORED because the trailing '%'
    // was lost. The railItem reaches the bound pattern through the minimal
    // frontmatter parser with no NUL rejection (production-reachable).
    const flatRoot = path.join(cleanup, "flat-nul-pattern");
    writeSlice(flatRoot, "plain-slice", {
      "README.md": "---\nstatus: active\nrail-item: RAIL\u0000TAIL\n---\n",
    });
    insertQitem(db, { qitemId: "q-parent-match", body: "ends with RAIL", tags: [] });
    insertQitem(db, { qitemId: "q-mid-rail", body: "RAIL in middle stuff", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    // Parent: q-parent-match via truncated '%RAIL' (ends-with); q-mid-rail
    // excluded (the lost trailing wildcard matters).
    expect(indexer.get("plain-slice")!.qitemIds).toEqual(["q-parent-match"]);
  });

  it("RED: cross-operation freshness (TYPED) — a typed qitem written for ALREADY-KNOWN B is visible on B's FIRST uncached get(), no invalidate/TTL", () => {
    // Parent ran per-slice SQL on every uncached get(), so a row written
    // after get(A) was immediately visible to the first get(B). The
    // candidate's generation-scoped index (B already in knownSlices) serves
    // stale empty membership until invalidate/TTL.
    const flatRoot = path.join(cleanup, "flat-fresh-typed");
    writeSlice(flatRoot, "fresh-a", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(flatRoot, "fresh-b-typed", { "README.md": "---\nstatus: active\n---\n" });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("fresh-a")!.qitemIds).toEqual([]); // builds the index generation
    insertQitem(db, { qitemId: "q-b-typed", body: "no name mention", tags: ["slice:fresh-b-typed"] });
    expect(indexer.get("fresh-b-typed")!.qitemIds).toEqual(["q-b-typed"]);
  });

  it("RED: cross-operation freshness (FALLBACK) — a body-mention qitem written for ALREADY-KNOWN C is visible on C's FIRST uncached get(), no invalidate/TTL", () => {
    // Isolated from the typed vector (own indexer + fixture) so this
    // assertion executes and fails independently on c8f85802 — a
    // typed-triggered rebuild elsewhere must not mask the fallback tier.
    const flatRoot = path.join(cleanup, "flat-fresh-fallback");
    writeSlice(flatRoot, "fresh-a2", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(flatRoot, "fresh-c-fallback", { "README.md": "---\nstatus: active\n---\n" });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("fresh-a2")!.qitemIds).toEqual([]); // builds the index generation
    insertQitem(db, { qitemId: "q-c-fallback", body: "fresh-c-fallback body mention", tags: [] });
    expect(indexer.get("fresh-c-fallback")!.qitemIds).toEqual(["q-c-fallback"]);
  });
});

// qitem-ccf87c0d amended gate — the explicit composite-operation scope API
// (withMembershipBatch). RED pre-fix via missing export; pins define the
// contract: outermost-fresh open, in-scope sharing, nested reuse,
// exception-safe close, and unchanged standalone semantics.
describe("qitem-ccf87c0d — withMembershipBatch scope API (RED: API missing)", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-scope-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  type Scoped = SliceIndexer & { withMembershipBatch<T>(fn: () => T): T };
  function scoped(indexer: SliceIndexer): Scoped {
    const s = indexer as Scoped;
    expect(typeof s.withMembershipBatch, "withMembershipBatch must be a public SliceIndexer method").toBe("function");
    return s;
  }

  /** Same membership-scan counter as the route/Review contracts (all
   *  queue_items scans; PK IN lookups + INSERTs excluded — no gather reads
   *  exist at the indexer seam so total == membership here). */
  function instrumentScans(target: Database.Database): () => number {
    let n = 0;
    const origPrepare = target.prepare.bind(target);
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const isScan = /from\s+queue_items/i.test(sql)
        && !/^\s*insert/i.test(sql)
        && !/where\s+qitem_id\s+in/i.test(sql);
      if (!isScan) return stmt;
      return {
        all: (...a: unknown[]) => { n++; return stmt.all!(...a); },
        iterate: (...a: unknown[]) => { n++; return stmt.iterate!(...a); },
        get: (...a: unknown[]) => { n++; return stmt.get!(...a); },
        run: (...a: unknown[]) => stmt.run!(...a),
      };
    };
    return () => n;
  }

  function seedSlices(n: number): string {
    const root = path.join(cleanup, "missions");
    for (let i = 0; i < n; i++) {
      writeSlice(path.join(root, "scope-mission", "slices"), `sc-${String(i).padStart(2, "0")}-topic`, {
        "README.md": "---\nstatus: active\n---\n",
      });
    }
    return root;
  }

  it("in-scope list() + N gets share ONE batch: <= 4 total queue scans across the whole scope", () => {
    const root = seedSlices(12);
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    const scans = instrumentScans(db);
    s.withMembershipBatch(() => {
      const entries = indexer.list();
      for (const e of entries) indexer.get(e.name);
    });
    expect(scans()).toBeLessThanOrEqual(4);
  });

  it("REQUEST-BOUNDARY FRESHNESS: scope1 builds a batch via get(A); insert membership for already-known uncached B; scope2 get(B) sees it (scope-open is always fresh)", () => {
    const root = seedSlices(2); // sc-00 (A) + sc-01 (B), both known from the start
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    s.withMembershipBatch(() => {
      expect(indexer.get("sc-00-topic")!.qitemIds).toEqual([]); // scope1 builds the generation
    });
    insertQitem(db, { qitemId: "q-scope-b", body: "no mention", tags: ["slice:sc-01-topic"] });
    s.withMembershipBatch(() => {
      // B was already known to scope1's batch — a stale-generation reuse
      // would serve []; the fresh scope2 open must see the new row.
      expect(indexer.get("sc-01-topic")!.qitemIds).toEqual(["q-scope-b"]);
    });
  });

  it("NESTED scopes share the outermost batch and clear only at outermost exit", () => {
    const root = seedSlices(4);
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    const scans = instrumentScans(db);
    s.withMembershipBatch(() => {
      indexer.get("sc-00-topic");
      s.withMembershipBatch(() => {
        indexer.get("sc-01-topic");
      });
      // Inner exit must NOT have cleared the shared batch.
      indexer.get("sc-02-topic");
    });
    expect(scans()).toBeLessThanOrEqual(4);
    // After outermost exit the batch is gone: a later write is visible.
    insertQitem(db, { qitemId: "q-after-scope", body: "no mention", tags: ["slice:sc-03-topic"] });
    expect(indexer.get("sc-03-topic")!.qitemIds).toEqual(["q-after-scope"]);
  });

  it("EXCEPTION inside a scope still clears at exit (finally): the next operation is fresh", () => {
    const root = seedSlices(2);
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    expect(() => s.withMembershipBatch(() => {
      indexer.get("sc-00-topic");
      throw new Error("boom");
    })).toThrow("boom");
    insertQitem(db, { qitemId: "q-post-throw", body: "no mention", tags: ["slice:sc-01-topic"] });
    expect(indexer.get("sc-01-topic")!.qitemIds).toEqual(["q-post-throw"]);
  });
});

// ---------------------------------------------------------------------------
// qitem-render-driver #3 — mission-wide qitemCount leak on a MODERN mission.
//
// Host evidence: /api/slices emits qitemCount=355 for placeholder slices 02/03
// while siblings report 1/1/2. Root: for a ZERO-TYPED slice, matchQitems falls
// back to a substring union over [sliceName, railItem, missionId], and
// extractRailItem DEFAULTS railItem to missionId when no rail item is authored
// — so a placeholder slice in a canonical multi-slice mission substring-matches
// every mission-tagged qitem in the corpus.
//
// The legacy doctrine is NOT deleted: on a mission whose corpus predates typed
// membership, the mission-body fallback still applies (pinned by the existing
// "preserves legacy substring fallback (including mission body)" test above).
// The discriminator here is a MODERN mission — a sibling slice carries typed
// `slice:` membership — where a mission-only row must NOT be credited to a
// zero-typed target, while that target's own NAME and an EXPLICIT rail-item
// still match.
// ---------------------------------------------------------------------------

describe("qitem-render-driver #3 — modern mission: mission-only rows must not leak into a zero-typed slice", () => {
  let db: Database.Database;
  let cleanup: string;
  let missionsRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-leak-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  /** A canonical MODERN mission: a typed sibling proves the corpus has adopted
   *  typed membership; the target slice authors no rail item (so railItem
   *  defaults to missionId) and carries no typed rows. */
  function seedModernMission(): void {
    const slices = path.join(missionsRoot, "release-x", "slices");
    writeSlice(slices, "01-typed-sibling", { "README.md": "---\nstatus: active\n---\n# sibling\n" });
    writeSlice(slices, "02-placeholder", { "README.md": "---\nstatus: placeholder\n---\n# placeholder\n" });
    // Typed membership exists in this mission (the modern signal).
    insertQitem(db, { qitemId: "q-typed-sibling", body: "no name mention", tags: ["slice:01-typed-sibling"] });
    // Mission-scope rows: tagged/mentioning the MISSION only — these are the
    // 355-class rows that must not be credited to 02-placeholder.
    insertQitem(db, { qitemId: "q-mission-tag", body: "no slice mention", tags: ["mission:release-x"] });
    insertQitem(db, { qitemId: "q-mission-body", body: "advance the release-x mission", tags: [] });
  }

  it("RED: a zero-typed slice in a modern mission does NOT absorb mission-only rows", () => {
    seedModernMission();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const target = indexer.get("02-placeholder")!;
    expect(target.qitemIds, "mission-only rows must not be credited to a zero-typed slice").toEqual([]);
  });

  it("RED (route-observable): the /api/slices qitemCount for that slice is 0, not the mission aggregate", () => {
    seedModernMission();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const entry = indexer.list().find((e) => e.name === "02-placeholder")!;
    expect(entry.qitemCount, "the count the sidebar badge renders").toBe(0);
  });

  it("GREEN pin: the target's OWN NAME in a body still matches (name-legacy match preserved)", () => {
    seedModernMission();
    insertQitem(db, { qitemId: "q-by-target-name", body: "work on 02-placeholder today", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("02-placeholder")!.qitemIds).toContain("q-by-target-name");
  });

  it("GREEN pin: an EXPLICIT authored rail-item still matches (explicit-rail legacy match preserved)", () => {
    const slices = path.join(missionsRoot, "release-y", "slices");
    writeSlice(slices, "01-typed-sib", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(slices, "02-railed", { "README.md": "---\nstatus: active\nrail-item: PL-777\n---\n" });
    insertQitem(db, { qitemId: "q-typed-y", body: "x", tags: ["slice:01-typed-sib"] });
    insertQitem(db, { qitemId: "q-by-explicit-rail", body: "PL-777 follow-up", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("02-railed")!.qitemIds).toContain("q-by-explicit-rail");
  });

  it("GREEN pin: the typed sibling keeps its own typed membership unchanged", () => {
    seedModernMission();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("01-typed-sibling")!.qitemIds).toEqual(["q-typed-sibling"]);
  });
});
