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
    const sliceDir = path.join(missionDir, "slices", "01-good");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), "---\nid: OPR.99.0.2.1\n---\n# good\n", "utf8");
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=clean-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; totalFindings: number };
    expect(body.ok).toBe(true);
    expect(body.totalFindings).toBe(0);
  });
});
