// Slice Story View v0 — slice indexer focused tests.
//
// Drives the indexer against a temp filesystem fixture (fully isolated
// from the real substrate-side slices folder so the test stays
// deterministic and parallel-safe). Covers:
//
//   - frontmatter parsing + display name fallback
//   - status enum mapping (incl. heuristic fallbacks)
//   - rail-item extraction from frontmatter
//   - qitem matching strategies (slice-name body match + rail-item body match)
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

function insertQitem(db: Database.Database, opts: { qitemId: string; body: string; tsCreated?: string; tsUpdated?: string }): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
     VALUES (?, ?, ?, ?, ?, ?, 'routine', ?)`
  ).run(
    opts.qitemId,
    opts.tsCreated ?? "2026-05-04T00:00:00.000Z",
    opts.tsUpdated ?? "2026-05-04T00:00:00.000Z",
    "src@r",
    "dst@r",
    "in-progress",
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

    it("classifies .mp4/.webm files as videos (founder-named load-bearing)", () => {
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
});
