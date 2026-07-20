import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
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
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { scopeAuditRoutes } from "../src/routes/scope-audit.js";

function buildApp(indexer: SliceIndexer): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, indexer);
    await next();
  });
  app.route("/api/scope/audit", scopeAuditRoutes());
  return app;
}

const VALID_MISSION_BRIEF = [
  "# test mission — Brief",
  "",
  "## What & why",
  "## Building",
  "## Progress",
  "## Proven",
  "## Needs you",
  "## Pointers",
].join("\n");

function validSliceReadme(frontmatter: string, title = "slice"): string {
  return `${frontmatter}
# ${title}

## Intent

Prove the slice shape projects through the SDLC convention fields.

## Mini-requirements

1. The slice carries a proportional requirements list.

## Proof contract

- [ ] The proof artifact maps to the declared requirement.
`;
}

let db: Database.Database;
let cleanupRoot: string;
let missionsRoot: string;
let indexer: SliceIndexer;
let app: Hono;

beforeEach(() => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
  cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-audit-routes-"));
  missionsRoot = path.join(cleanupRoot, "missions");
  fs.mkdirSync(missionsRoot, { recursive: true });
  indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
  app = buildApp(indexer);
});

afterEach(() => {
  db.close();
  fs.rmSync(cleanupRoot, { recursive: true, force: true });
});

describe("GET /api/scope/audit", () => {
  it("returns 400 when mission param is missing", async () => {
    const res = await app.request("/api/scope/audit");
    expect(res.status).toBe(400);
  });

  it("returns 404 when mission does not exist", async () => {
    const res = await app.request("/api/scope/audit?mission=nonexistent");
    expect(res.status).toBe(404);
  });

  it("README-less NN-slug slice dir with no PROGRESS emits missing_id + missing_progress", async () => {
    const missionDir = path.join(missionsRoot, "test-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.1\n---\n# test\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "02-bare");
    fs.mkdirSync(sliceDir, { recursive: true });

    const res = await app.request("/api/scope/audit?mission=test-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; slices: Array<{ name: string; findings: Array<{ kind: string }> }> };
    expect(body.ok).toBe(false);
    const bare = body.slices.find((s) => s.name === "02-bare");
    expect(bare).toBeDefined();
    expect(bare!.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(bare!.findings.some((f) => f.kind === "missing_progress")).toBe(true);
  });

  it("orphan_progress: slice with PROGRESS.md but no README.md", async () => {
    const missionDir = path.join(missionsRoot, "test-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.1\n---\n# test\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "03-orphan");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=test-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; slices: Array<{ name: string; railStatus: string; findings: Array<{ kind: string }> }> };
    expect(body.ok).toBe(false);
    const orphan = body.slices.find((s) => s.name === "03-orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.railStatus).toBe("malformed");
    expect(orphan!.findings.some((f) => f.kind === "orphan_progress")).toBe(true);
  });

  it("clean mission with valid slice returns ok:true", async () => {
    const missionDir = path.join(missionsRoot, "clean-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.2\n---\n# clean\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "01-good");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), validSliceReadme("---\nid: OPR.99.0.2.1\n---", "good"), "utf8");
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=clean-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; totalFindings: number };
    expect(body.ok).toBe(true);
    expect(body.totalFindings).toBe(0);
  });

  it("mission missing brief and notes returns advisory findings without hard-failing", async () => {
    const missionDir = path.join(missionsRoot, "briefless-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.3\n---\n# briefless\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=briefless-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      mission: { findings: Array<{ kind: string; severity: string; path: string; remediation: string }> };
      totalFindings: number;
    };
    expect(body.ok).toBe(true);
    expect(body.totalFindings).toBe(2);
    expect(body.mission.findings.find((f) => f.kind === "missing_mission_brief")).toMatchObject({
      severity: "medium",
      path: path.join(missionDir, "MISSION_BRIEF.md"),
    });
    expect(body.mission.findings.find((f) => f.kind === "missing_mission_notes")).toMatchObject({
      severity: "low",
      path: path.join(missionDir, "MISSION_NOTES.md"),
    });
  });

  it("done slice without PROOF.md or proof packet returns missing_proof guidance", async () => {
    const missionDir = path.join(missionsRoot, "proof-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.4\n---\n# proof\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const doneSlice = path.join(missionDir, "slices", "01-done");
    fs.mkdirSync(path.join(doneSlice, "proof"), { recursive: true });
    fs.writeFileSync(path.join(doneSlice, "README.md"), validSliceReadme("---\nid: OPR.99.0.4.1\nstatus: done\n---", "done"), "utf8");
    fs.writeFileSync(path.join(doneSlice, "PROGRESS.md"), "# Progress\n", "utf8");
    const wipSlice = path.join(missionDir, "slices", "02-wip");
    fs.mkdirSync(wipSlice, { recursive: true });
    fs.writeFileSync(path.join(wipSlice, "README.md"), validSliceReadme("---\nid: OPR.99.0.4.2\nstatus: wip\n---", "wip"), "utf8");
    fs.writeFileSync(path.join(wipSlice, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=proof-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      slices: Array<{ name: string; findings: Array<{ kind: string; severity: string; path: string; remediation: string }> }>;
      totalFindings: number;
    };
    expect(body.ok).toBe(true);
    const done = body.slices.find((s) => s.name === "01-done");
    const wip = body.slices.find((s) => s.name === "02-wip");
    expect(done?.findings.find((f) => f.kind === "missing_proof")).toMatchObject({
      severity: "medium",
      path: path.join(doneSlice, "PROOF.md"),
    });
    expect(done?.findings.find((f) => f.kind === "missing_proof")?.remediation).toMatch(/proof\//);
    expect(done?.findings.some((f) => f.kind === "missing_impl_prd")).toBe(true);
    expect(wip?.findings.some((f) => f.kind === "missing_proof")).toBe(false);
    expect(body.totalFindings).toBe(2);
  });

  it("proof-packet-backed proven slice without root proof returns missing_proof", async () => {
    const dogfoodRoot = path.join(cleanupRoot, "dogfood-evidence");
    fs.mkdirSync(dogfoodRoot, { recursive: true });
    indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
    app = buildApp(indexer);

    const missionDir = path.join(missionsRoot, "proof-packet-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.5\n---\n# proof packet\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "03-proof-backed");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), validSliceReadme("---\nid: OPR.99.0.5.3\nstatus: active\n---", "proof backed"), "utf8");
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const packetDir = path.join(dogfoodRoot, "03-proof-backed-20260625");
    fs.mkdirSync(packetDir, { recursive: true });
    fs.writeFileSync(path.join(packetDir, "capture.md"), "proof packet exists\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=proof-packet-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      slices: Array<{ name: string; findings: Array<{ kind: string; severity: string; path: string; remediation: string }> }>;
      totalFindings: number;
    };
    expect(body.ok).toBe(true);
    const slice = body.slices.find((s) => s.name === "03-proof-backed");
    expect(slice?.findings.find((f) => f.kind === "missing_proof")).toMatchObject({
      severity: "medium",
      path: path.join(sliceDir, "PROOF.md"),
    });
    expect(body.totalFindings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// qitem-43d69e17 — /api/scope/audit composite-operation load contract. The
// route loops mission slice dirs calling indexer.get(entry) per slice
// (routes/scope-audit.ts:148) with NO prior list(): on 5c95a8ee each
// uncached get builds its own membership batch — 2N scans (80 at 40
// slices, guard-measured). Contract: one audit request = a CONSTANT number
// of queue_items scan executions. This route performs no other queue reads
// (verified by source grep), so the count-EVERYTHING rule applies cleanly
// (LIKE and non-LIKE; INSERTs and PK point lookups WHERE qitem_id IN
// excluded).
// ---------------------------------------------------------------------------

describe("qitem-43d69e17 — audit route total queue-scan load contract", () => {
  function instrumentQueueScans(target: Database.Database): () => number {
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

  it("one GET /api/scope/audit over 40 valid slices executes <= 4 total queue_items scans; response semantics fully retained", async () => {
    const missionDir = path.join(missionsRoot, "load-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.9\n---\n# load mission\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const sliceNames: string[] = [];
    for (let i = 0; i < 40; i++) {
      const name = `${String(i + 1).padStart(2, "0")}-load-topic`;
      sliceNames.push(name);
      const sliceDir = path.join(missionDir, "slices", name);
      fs.mkdirSync(sliceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sliceDir, "README.md"),
        validSliceReadme(`---\nid: OPR.99.0.9.${i + 1}\nstatus: active\n---`, name),
        "utf8",
      );
      fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");
    }
    // One queue row matching nothing: membership scans dominate; no
    // per-slice IN lookups fire.
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-lone', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'a@r', 'b@r', 'done', 'routine', 'fixture')`,
    ).run();

    const scans = instrumentQueueScans(db);
    const res = await app.request("/api/scope/audit?mission=load-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      mission: { name: string; railStatus: string };
      slices: Array<{ name: string; railStatus: string; findings: Array<{ kind: string }> }>;
      totalFindings: number;
    };
    // Semantic parity: every slice audited and retained, shapes intact.
    expect(body.mission.name).toBe("load-mission");
    expect(body.slices.map((s) => s.name).sort()).toEqual([...sliceNames].sort());
    expect(body.slices).toHaveLength(40);
    for (const s of body.slices) {
      expect(s.railStatus).toBe("present"); // README + PROGRESS both exist
    }
    // Valid convention slices + populated mission files: no findings at all.
    expect(body.totalFindings).toBe(0);
    expect(body.ok).toBe(true);
    // Pre-fix on 5c95a8ee: 40 uncached gets x 2 membership scans = 80.
    // Contract: constant.
    expect(scans()).toBeLessThanOrEqual(4);
  });
});
