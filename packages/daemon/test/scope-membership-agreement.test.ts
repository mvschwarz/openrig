// Canonical scope-membership matcher (VM-003 + VM-004) — the AGREEMENT test
// (the class-killer). One seeded queue_items fixture; the four historically
// divergent matchers (matchQitems -> qitemIds, agentsForSlices -> the band,
// hasActiveQitem -> phase signal, attentionForTag -> NeedsYou) must all AGREE
// on membership for: clean tags · comma-embedded legacy tags · a mission-tagged
// qitem on an unindexed slice · and the NEGATIVES (slice:X-suffix over-match,
// sibling-name, body-mention-only). Over-match negatives AND under-match
// positives both hold.

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
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";

const NOW = "2026-07-11T12:00:00.000Z";

function writeSlice(root: string, rel: string, name: string): void {
  const dir = path.join(root, rel, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `---\nstatus: active\n---\n# ${name}\n`);
}

function insertQitem(
  db: Database.Database,
  opts: { id: string; dest: string; tags: string[]; body?: string; tier?: string | null; state?: string },
): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, summary)
     VALUES (?, ?, ?, 'src@rig', ?, ?, 'high', ?, ?, ?, ?)`,
  ).run(
    opts.id,
    NOW,
    NOW,
    opts.dest,
    opts.state ?? "in-progress",
    opts.tier ?? null,
    JSON.stringify(opts.tags),
    opts.body ?? "body",
    opts.id,
  );
}

describe("scope-membership agreement (VM-003 + VM-004 class-killer)", () => {
  let missionsRoot: string;
  let cleanup: string;
  let db: Database.Database;

  beforeEach(() => {
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "scope-agreement-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    // Mission "relx" with two indexed slices: target (under test) + sibling.
    writeSlice(missionsRoot, path.join("relx", "slices"), "target");
    writeSlice(missionsRoot, path.join("relx", "slices"), "sibling");
    writeSlice(missionsRoot, path.join("relx", "slices"), "legacyonly");
    db = createDb(":memory:");
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueItemSummarySchema]);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  function seedFixture(): void {
    // --- members of slice:target ---
    insertQitem(db, { id: "qc", dest: "alice@rig", tags: ["mission:relx", "slice:target"] }); // clean
    insertQitem(db, { id: "ql", dest: "bob@rig", tags: ["mission:relx,slice:target"] }); // comma-legacy (VM-003)
    // --- NEGATIVES (must be excluded everywhere) ---
    insertQitem(db, { id: "qsuf", dest: "carol@rig", tags: ["slice:target-extra"] }); // suffix over-match
    insertQitem(db, { id: "qsib", dest: "dave@rig", tags: ["slice:sibling"] }); // sibling
    insertQitem(db, { id: "qbody", dest: "erin@rig", tags: [], body: "work on target here" }); // body-mention only
    // --- mission-direct (C3) ---
    insertQitem(db, { id: "qmis", dest: "frank@rig", tags: ["mission:relx"] });
    // --- human-gate rows for attentionForTag agreement ---
    insertQitem(db, { id: "qhg_member", dest: "grace@rig", tags: ["mission:relx,slice:target"], tier: "human-gate" });
    insertQitem(db, { id: "qhg_non", dest: "heidi@rig", tags: ["slice:target-extra"], tier: "human-gate" });
    // --- legacy zero-typed corpus (substring tier must still run) ---
    insertQitem(db, { id: "qleg", dest: "ivan@rig", tags: [], body: "legacyonly rollout notes" });
  }

  function makeIndexerAndGatherer() {
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    return { indexer, gatherer };
  }

  it("matchQitems (qitemIds): typed-authoritative, comma-legacy IN, suffix/sibling/body OUT", () => {
    seedFixture();
    const { indexer } = makeIndexerAndGatherer();
    const ids = new Set(indexer.get("target")?.qitemIds ?? []);
    expect(ids.has("qc")).toBe(true); // clean
    expect(ids.has("ql")).toBe(true); // comma-legacy (VM-003)
    expect(ids.has("qhg_member")).toBe(true); // comma-legacy member (human-gate)
    expect(ids.has("qsuf")).toBe(false); // suffix over-match (VM-004)
    expect(ids.has("qsib")).toBe(false); // sibling
    expect(ids.has("qbody")).toBe(false); // body-mention (typed rows exist -> substring tier skipped)
    expect(ids.has("qmis")).toBe(false); // mission-only, not a slice member
  });

  it("agentsForSlices band (slice scope): comma-legacy seat IN, negatives + mission-only OUT", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const band = gatherer.composeAgents("slice:target");
    const sessions = new Set((band?.rows ?? []).map((r) => r.sessionName));
    expect(sessions.has("alice@rig")).toBe(true); // clean
    expect(sessions.has("bob@rig")).toBe(true); // comma-legacy (VM-003 fix)
    expect(sessions.has("carol@rig")).toBe(false); // suffix
    expect(sessions.has("dave@rig")).toBe(false); // sibling
    expect(sessions.has("erin@rig")).toBe(false); // body-mention
    expect(sessions.has("frank@rig")).toBe(false); // mission-only -> not in slice band
  });

  it("hasActiveQitem AGREES with the band (phase/band coherence pin)", () => {
    seedFixture();
    const { indexer, gatherer } = makeIndexerAndGatherer();
    const rec = indexer.get("target")!;
    const active = (gatherer as unknown as { hasActiveQitem(n: string, s: unknown): boolean }).hasActiveQitem("target", rec);
    const band = gatherer.composeAgents("slice:target");
    expect(active).toBe(true);
    // Coherence: active work present => band has >= 1 row (one-compose-two-answers, killed).
    expect((band?.rows.length ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("attentionForTag AGREES: comma-legacy member IN, suffix over-match OUT", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const attn = (gatherer as unknown as { attentionForTag(t: string): Array<{ qitemId: string }> }).attentionForTag("slice:target");
    const ids = new Set(attn.map((a) => a.qitemId));
    expect(ids.has("qhg_member")).toBe(true); // comma-legacy member (under-match fixed)
    expect(ids.has("qhg_non")).toBe(false); // suffix over-match rejected by canonical confirm
  });

  it("mission band (C3): mission-tag-direct seat appears even without an indexed slice tag", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const band = gatherer.composeAgents("mission:relx");
    const sessions = new Set((band?.rows ?? []).map((r) => r.sessionName));
    expect(sessions.has("frank@rig")).toBe(true); // mission:relx-tagged, no slice tag (C3 fix)
    expect(sessions.has("alice@rig")).toBe(true); // slice member still present via union
  });

  it("mission attention excludes rows carrying a slice tag (d2 excludeTagPrefix, comma-legacy aware)", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const attn = (gatherer as unknown as { attentionForTag(t: string, ex?: string): Array<{ qitemId: string }> }).attentionForTag("mission:relx", "slice:");
    const ids = new Set(attn.map((a) => a.qitemId));
    // qhg_member is a comma-legacy row that carries slice:target -> excluded from
    // mission attention (d2: raw startsWith blind to comma-legacy; canonical set is not).
    expect(ids.has("qhg_member")).toBe(false);
  });

  it("tier gating: zero-typed corpus still matches via the preserved substring fallback", () => {
    seedFixture();
    const { indexer } = makeIndexerAndGatherer();
    const ids = new Set(indexer.get("legacyonly")?.qitemIds ?? []);
    // No typed slice:legacyonly rows -> typedTagMatchCount 0 -> substring tier runs
    // over [sliceName, railItem, missionId], matching the body mention.
    expect(ids.has("qleg")).toBe(true);
  });
});

describe("scope-membership byte-identity carve (clean corpus, zero regression)", () => {
  let missionsRoot: string;
  let cleanup: string;
  let db: Database.Database;

  beforeEach(() => {
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "scope-carve-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    writeSlice(missionsRoot, path.join("relx", "slices"), "target");
    db = createDb(":memory:");
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueItemSummarySchema]);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("a clean single-member slice band matches the pinned pre-change literal", () => {
    insertQitem(db, { id: "qc", dest: "alice@rig", tags: ["mission:relx", "slice:target"] });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    const band = gatherer.composeAgents("slice:target");
    // Pinned expectation (pre-change behavior for a well-formed corpus).
    expect(band).toEqual({
      scope: "slice:target",
      rows: [
        {
          agentName: "alice",
          runtime: "unknown",
          stateGlyph: "unknown",
          doing: "qc",
          holdsCount: 1,
          lastTransitionIso: NOW,
          exception: null,
          sessionName: "alice@rig",
          slices: ["target"],
        },
      ],
      provenance: `computed from queue at ${NOW}`,
      coordinationHealth: null,
    });
  });

  it("an empty clean band keeps the confident provenance string byte-identical (C4 no-change)", () => {
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    const band = gatherer.composeAgents("slice:target");
    expect(band?.rows).toEqual([]);
    expect(band?.provenance).toBe(`no agents holding or recently holding work — computed from queue at ${NOW}`);
  });
});
