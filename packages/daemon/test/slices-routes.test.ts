// Slice Story View v0 — slices route end-to-end tests.
//
// Drives the routes against a hand-mounted Hono app with the indexer +
// projector wired through context middleware (mirrors how the real
// server.ts wires them via createApp). Covers:
//
//   - GET /api/slices?filter=...  filter validation + status-bucket projection
//   - GET /api/slices/:name        full per-tab payload shape
//   - GET /api/slices/:name/proof-asset/...  binary serving + path-traversal guard
//   - GET /api/slices/:name/doc/...           markdown content
//   - Route-order discipline: literal `/` not shadowed by `/:name`
//   - 503 on slices_root_not_configured (graceful when env unset)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const catalogReadObservation = vi.hoisted(() => ({ activePath: null as string | null, reads: 0 }));
const nodeMetadataFault = vi.hoisted(() => ({
  readPath: null as string | null,
  readCode: "EACCES",
  readHits: 0,
  selectionPath: null as string | null,
  selectionCode: "EACCES",
  selectionHits: 0,
}));
const evidenceRootFault = vi.hoisted(() => ({
  targetPath: null as string | null,
  stage: null as "resolve" | "access" | "readdir" | "unexpected" | null,
  code: "EACCES",
  hits: 0,
}));
const realpathSyncFault = vi.hoisted(() => ({
  targetPath: null as string | null,
  code: "EACCES",
  hits: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const injectedError = (code: string) => Object.assign(new Error("injected node metadata failure"), { code });
  const matchesEvidenceFaultTarget = (candidate: unknown): boolean =>
    evidenceRootFault.targetPath !== null && typeof candidate === "string" && candidate === evidenceRootFault.targetPath;
  const maybeThrowEvidenceResolveFault = (candidate: unknown): void => {
    if (!matchesEvidenceFaultTarget(candidate)) return;
    if (evidenceRootFault.stage === "resolve") {
      evidenceRootFault.hits++;
      throw injectedError(evidenceRootFault.code);
    }
    if (evidenceRootFault.stage === "unexpected") {
      evidenceRootFault.hits++;
      throw Object.assign(new TypeError("unexpected caller type error"), { code: "ERR_INVALID_ARG_TYPE" });
    }
  };
  const existsSync = ((...args: Parameters<typeof actual.existsSync>) => {
    if (String(args[0]) === nodeMetadataFault.selectionPath && nodeMetadataFault.selectionPath !== null) {
      nodeMetadataFault.selectionHits++;
      // existsSync hides access errors as false; a later README can then mask SPEC.
      return false;
    }
    return actual.existsSync(...args);
  }) as typeof actual.existsSync;
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    maybeThrowEvidenceResolveFault(args[0]);
    return actual.lstatSync(...args);
  }) as typeof actual.lstatSync;
  const realpathSync = Object.assign(((...args: Parameters<typeof actual.realpathSync>) => {
    maybeThrowEvidenceResolveFault(args[0]);
    if (realpathSyncFault.targetPath !== null && String(args[0]) === realpathSyncFault.targetPath) {
      realpathSyncFault.hits++;
      throw injectedError(realpathSyncFault.code);
    }
    return actual.realpathSync(...args);
  }) as typeof actual.realpathSync, { native: actual.realpathSync.native });
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    if (String(args[0]) === nodeMetadataFault.selectionPath && nodeMetadataFault.selectionPath !== null) {
      nodeMetadataFault.selectionHits++;
      throw injectedError(nodeMetadataFault.selectionCode);
    }
    return actual.statSync(...args);
  }) as typeof actual.statSync;
  const accessSync = ((...args: Parameters<typeof actual.accessSync>) => {
    if (String(args[0]) === nodeMetadataFault.selectionPath && nodeMetadataFault.selectionPath !== null) {
      nodeMetadataFault.selectionHits++;
      throw injectedError(nodeMetadataFault.selectionCode);
    }
    if (matchesEvidenceFaultTarget(args[0]) && evidenceRootFault.stage === "access") {
      evidenceRootFault.hits++;
      throw injectedError(evidenceRootFault.code);
    }
    return actual.accessSync(...args);
  }) as typeof actual.accessSync;
  const readdirSync = vi.fn(((...args: Parameters<typeof actual.readdirSync>) => {
    if (matchesEvidenceFaultTarget(args[0]) && evidenceRootFault.stage === "readdir") {
      evidenceRootFault.hits++;
      throw injectedError(evidenceRootFault.code);
    }
    return actual.readdirSync(...args);
  }) as typeof actual.readdirSync) as unknown as typeof actual.readdirSync;
  const readFileSync = vi.fn(((...args: Parameters<typeof actual.readFileSync>) => {
    const requestedPath = String(args[0]);
    if (catalogReadObservation.activePath !== null && requestedPath === catalogReadObservation.activePath) {
      catalogReadObservation.reads++;
    }
    if (requestedPath === nodeMetadataFault.readPath && nodeMetadataFault.readPath !== null) {
      nodeMetadataFault.readHits++;
      throw injectedError(nodeMetadataFault.readCode);
    }
    if (requestedPath === nodeMetadataFault.selectionPath && nodeMetadataFault.selectionPath !== null) {
      nodeMetadataFault.selectionHits++;
      throw injectedError(nodeMetadataFault.selectionCode);
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync) as unknown as typeof actual.readFileSync;
  const actualDefault = (actual as unknown as { default?: object }).default ?? actual;
  const defaultFs = Object.assign(Object.create(actualDefault), {
    existsSync,
    lstatSync,
    realpathSync,
    statSync,
    accessSync,
    readdirSync,
    readFileSync,
  });
  return { ...actual, existsSync, lstatSync, realpathSync, statSync, accessSync, readdirSync, readFileSync, default: defaultFs };
});

import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { once } from "node:events";
import { createServer } from "node:http";
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
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer, deriveSliceQueueState, type QueueCountRow } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { slicesRoutes } from "../src/routes/slices.js";
import * as slicesRoutesModule from "../src/routes/slices.js";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { eraseQueue } from "../src/domain/queue-erasure.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

function buildApp(opts: { indexer: SliceIndexer; projector: SliceDetailProjector; workspaceRoot?: string; guardBrowser?: boolean }): Hono {
  const app = new Hono();
  if (opts.guardBrowser) {
    app.use("/api/*", browserBoundary({
      webUiEnabled: false, bearerTokens: ["fixture-read-token"],
      hostName: () => "fixture.local", discoverSelfNames: async () => [], warn: () => {},
    }));
  }
  app.use("*", async (c, next) => {
    if (opts.workspaceRoot) {
      c.set("settingsStore" as never, { resolveOne: (key: string) => ({
        value: key === "workspace.root" ? opts.workspaceRoot : path.join(opts.workspaceRoot!, "workspace.yaml"),
      }) });
    }
    c.set("sliceIndexer" as never, opts.indexer);
    c.set("sliceDetailProjector" as never, opts.projector);
    await next();
  });
  app.route("/api/slices", slicesRoutes());
  return app;
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

function insertQitem(db: Database.Database, opts: {
  qitemId: string; body: string; sourceSession?: string; destinationSession?: string; state?: string; tier?: string | null;
}): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, tier)
     VALUES (?, '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', ?, ?, ?, 'routine', ?, ?)`
  ).run(
    opts.qitemId,
    opts.sourceSession ?? "src@r",
    opts.destinationSession ?? "dst@r",
    opts.state ?? "in-progress",
    opts.body,
    opts.tier ?? null,
  );
}

describe("PL-slice-story-view-v0 slices routes", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let dogfoodRoot: string;
  let cleanupDir: string;
  let indexer: SliceIndexer;
  let projector: SliceDetailProjector;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "slices-routes-test-"));
    cleanupDir = base;
    slicesRoot = path.join(base, "slices");
    dogfoodRoot = path.join(base, "dogfood-evidence");
    fs.mkdirSync(slicesRoot, { recursive: true });
    fs.mkdirSync(dogfoodRoot, { recursive: true });
    indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
    projector = new SliceDetailProjector({ db, indexer });
    app = buildApp({ indexer, projector });
  });

  afterEach(() => {
    evidenceRootFault.targetPath = null;
    evidenceRootFault.stage = null;
    evidenceRootFault.code = "EACCES";
    evidenceRootFault.hits = 0;
    db.close();
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    (fs.readdirSync as unknown as { mockClear: () => void }).mockClear();
    (fs.readFileSync as unknown as { mockClear: () => void }).mockClear();
  });

  describe("GET /api/slices (list)", () => {
    it("exposes child missions on their indexed parent slice", async () => {
      writeSlice(slicesRoot, "parent", { "SPEC.md": "---\nid: M.1\n---\n# Parent\n" });
      writeSlice(slicesRoot, "parent/slices/01-work", { "SPEC.md": "---\nid: M.1.1\nstatus: active\n---\n# Work\n" });
      writeSlice(slicesRoot, "child", { "SPEC.md": "---\nid: M.2\n---\n# Child\n", "mission.yaml": "metadata:\n  parent: M.1.1\n" });
      const res = await app.request("/api/slices?filter=all");
      const body = await res.json() as { slices: Array<{ name: string; childMissions: Array<{ id: string }> }> };
      expect(body.slices.find((slice) => slice.name === "01-work")?.childMissions).toMatchObject([{ id: "M.2" }]);
    });
    it("reports scan gaps alongside partial child missions", async () => {
      writeSlice(slicesRoot, "parent", { "SPEC.md": "---\nid: M.1\n---\n" });
      writeSlice(slicesRoot, "parent/slices/01-work", { "SPEC.md": "---\nid: M.1.1\nstatus: active\n---\n" });
      writeSlice(slicesRoot, "child", { "SPEC.md": "---\nid: M.2\nparent: M.1.1\n---\n" });
      writeSlice(slicesRoot, "broken", { "SPEC.md": "---\nid: [bad\n---\n" });
      const res = await app.request("/api/slices?filter=all");
      expect(res.status).toBe(200);
      const body = await res.json() as { parentWarnings: string[]; slices: Array<{ name: string; childMissions: Array<{ id: string }> }> };
      expect(body.parentWarnings.join(" ")).toContain("broken");
      expect(body.slices.find((slice) => slice.name === "01-work")?.childMissions).toMatchObject([{ id: "M.2" }]);
    });
    it("returns 503 with config-hint when slicesRoot is not configured", async () => {
      const emptyIndexer = new SliceIndexer({ slicesRoot: "", dogfoodEvidenceRoot: null, db });
      const emptyProjector = new SliceDetailProjector({ db, indexer: emptyIndexer });
      const emptyApp = buildApp({ indexer: emptyIndexer, projector: emptyProjector });
      const res = await emptyApp.request("/api/slices");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("slices_root_not_configured");
      expect(body.hint).toContain("workspace/missions");
    });

    it("returns slices array sorted by lastActivityAt DESC with totalCount + filter echo", async () => {
      writeSlice(slicesRoot, "alpha", { "README.md": "---\nstatus: active\n---\n# A" });
      writeSlice(slicesRoot, "beta", { "README.md": "---\nstatus: shipped\n---\n# B" });
      const res = await app.request("/api/slices");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { slices: Array<{ name: string; status: string }>; totalCount: number; filter: string };
      expect(body.totalCount).toBe(2);
      expect(body.filter).toBe("all");
      expect(body.slices.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    });

    it("?filter=active includes only active slices", async () => {
      writeSlice(slicesRoot, "active-1", { "README.md": "---\nstatus: active\n---\n" });
      writeSlice(slicesRoot, "shipped-1", { "README.md": "---\nstatus: shipped\n---\n" });
      const res = await app.request("/api/slices?filter=active");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { slices: Array<{ name: string }> };
      expect(body.slices.map((s) => s.name)).toEqual(["active-1"]);
    });

    it("?filter=blocked includes parked + blocked statuses", async () => {
      writeSlice(slicesRoot, "parked", { "README.md": "---\nstatus: parked-with-evidence\n---\n" });
      writeSlice(slicesRoot, "active", { "README.md": "---\nstatus: active\n---\n" });
      const res = await app.request("/api/slices?filter=blocked");
      const body = (await res.json()) as { slices: Array<{ name: string }> };
      expect(body.slices.map((s) => s.name)).toEqual(["parked"]);
    });

    it("rejects unknown filter values with 400 + actionable hint", async () => {
      const res = await app.request("/api/slices?filter=bogus");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("filter_invalid");
      expect(body.hint).toContain("active");
      expect(body.hint).toContain("done");
    });
  });

  describe("GET /api/slices/:name (detail)", () => {
    it("returns full payload with all six tab sections", async () => {
      writeSlice(slicesRoot, "x", { "README.md": "---\nstatus: active\n---\n# X\n- [ ] Item 1\n- [x] Item 2\n" });
      const res = await app.request("/api/slices/x");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "acceptance", "commitRefs", "decisions", "displayName", "docs",
        "lastActivityAt", "missionId", "name", "qitemIds", "railItem", "rawStatus", "readiness",
        "slicePath", "status", "story", "tests", "topology", "workflowBinding",
      ]);
      const acc = (body.acceptance as { totalItems: number; doneItems: number; percentage: number });
      expect(acc.totalItems).toBe(2);
      expect(acc.doneItems).toBe(1);
      expect(acc.percentage).toBe(50);
    });

    it("returns 404 for unknown slice", async () => {
      const res = await app.request("/api/slices/nope-not-real");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; name: string };
      expect(body.error).toBe("slice_not_found");
      expect(body.name).toBe("nope-not-real");
    });

    it("decisions tab pulls mission_control_actions filtered by qitem chain", async () => {
      writeSlice(slicesRoot, "mc-action-test", { "README.md": "---\nstatus: active\n---\n" });
      insertQitem(db, { qitemId: "q-mc-1", body: "mc-action-test work" });
      db.prepare(
        `INSERT INTO mission_control_actions
           (action_id, action_verb, qitem_id, actor_session, acted_at, before_state_json, after_state_json, reason, annotation)
         VALUES (?, 'approve', 'q-mc-1', 'human@r', '2026-05-04T01:00:00.000Z', '{"state":"pending"}', '{"state":"closed"}', NULL, 'looks good')`
      ).run("01HXX0000000000000000ACTID");
      const res = await app.request("/api/slices/mc-action-test");
      const body = (await res.json()) as { decisions: { rows: Array<{ verb: string; actor: string; reason: string }> } };
      expect(body.decisions.rows).toHaveLength(1);
      expect(body.decisions.rows[0]!.verb).toBe("approve");
      expect(body.decisions.rows[0]!.actor).toBe("human@r");
      expect(body.decisions.rows[0]!.reason).toBe("looks good");
    });

    it("topology tab groups slice seats by rig with totalSeats aggregate", async () => {
      writeSlice(slicesRoot, "topo-test", { "README.md": "---\nstatus: active\n---\n" });
      insertQitem(db, { qitemId: "q-1", body: "topo-test", sourceSession: "alpha@rig-a", destinationSession: "beta@rig-a" });
      insertQitem(db, { qitemId: "q-2", body: "topo-test", sourceSession: "alpha@rig-a", destinationSession: "gamma@rig-b" });
      const res = await app.request("/api/slices/topo-test");
      const body = (await res.json()) as { topology: { affectedRigs: Array<{ rigName: string; sessionNames: string[] }>; totalSeats: number } };
      expect(body.topology.totalSeats).toBe(3);
      const byRig = new Map(body.topology.affectedRigs.map((r) => [r.rigName, r.sessionNames]));
      expect(byRig.get("rig-a")?.sort()).toEqual(["alpha@rig-a", "beta@rig-a"]);
      expect(byRig.get("rig-b")).toEqual(["gamma@rig-b"]);
    });

    it("badges accepted dogfood reports as pass even when the narrative mentions blocked/failed repro history", async () => {
      writeSlice(slicesRoot, "proof-badge-slice", { "README.md": "---\nstatus: shipped\n---\n" });
      const dir = path.join(dogfoodRoot, "proof-badge-slice-20260504");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "accepted-dogfood.md"), [
        "# Proof",
        "",
        "## Result",
        "",
        "ACCEPT after local dogfood fix commit.",
        "",
        "The headed dogfood passed after fixing one console issue.",
        "",
        "Repro notes mention a hold verb that became blocked and a red-first test that failed before the fix.",
      ].join("\n"));

      const res = await app.request("/api/slices/proof-badge-slice");
      const body = (await res.json()) as {
        tests: {
          proofPackets: Array<{ passFailBadge: string }>;
          aggregate: { passCount: number; failCount: number };
        };
      };

      expect(body.tests.proofPackets[0]!.passFailBadge).toBe("pass");
      expect(body.tests.aggregate).toEqual({ passCount: 1, failCount: 0 });
    });
  });

  describe("GET /api/slices/:name/proof-asset/* (named proof assets)", () => {
    it("serves a screenshot file with image/png Content-Type", async () => {
      writeSlice(slicesRoot, "proof-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "proof-slice-20260504");
      fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(dir, "screenshots", "shot.png"), "fake-png-bytes");
      const res = await app.request("/api/slices/proof-slice/proof-asset/screenshots/shot.png");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("max-age");
    });

    it("serves an mp4 video with video/mp4 Content-Type", async () => {
      writeSlice(slicesRoot, "video-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "video-slice-20260504");
      fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
      fs.writeFileSync(path.join(dir, "videos", "demo.mp4"), "fake-mp4");
      const res = await app.request("/api/slices/video-slice/proof-asset/videos/demo.mp4");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
    });

    it("serves 206 + Accept-Ranges + exactly 100 bytes for proof video assets", async () => {
      writeSlice(slicesRoot, "range-video-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "range-video-slice-20260504");
      fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
      fs.writeFileSync(path.join(dir, "videos", "demo.mp4"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)));

      const res = await app.request("/api/slices/range-video-slice/proof-asset/videos/demo.mp4", {
        headers: { Range: "bytes=0-99" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("content-range")).toBe("bytes 0-99/1000");
      expect(res.headers.get("content-length")).toBe("100");
      expect(res.headers.get("content-type")).toBe("video/mp4");

      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.length).toBe(100);
      expect(body[0]).toBe(0);
      expect(body[99]).toBe(99);
    });

    it.each(["bytes=-0", "bytes=1000-"])("rejects unsatisfiable proof asset range %s", async (range) => {
      writeSlice(slicesRoot, "invalid-range-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "invalid-range-slice-20260504", "videos");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "demo.mp4"), Buffer.alloc(1000));
      const res = await app.request("/api/slices/invalid-range-slice/proof-asset/videos/demo.mp4", {
        headers: { Range: range },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */1000");
    });

    it.each(["bytes=-1000", "bytes=-2000"])("serves a whole proof asset for long suffix %s", async (range) => {
      writeSlice(slicesRoot, "suffix-video-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "suffix-video-slice-20260504", "videos");
      fs.mkdirSync(dir, { recursive: true });
      const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
      fs.writeFileSync(path.join(dir, "demo.mp4"), bytes);
      const res = await app.request("/api/slices/suffix-video-slice/proof-asset/videos/demo.mp4", {
        headers: { Range: range },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe("bytes 0-999/1000");
      expect(res.headers.get("Content-Length")).toBe("1000");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(bytes));
    });

    it("rejects path-traversal attempts with 400", async () => {
      writeSlice(slicesRoot, "trav-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "trav-slice-20260504");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "ok.md"), "");
      const res = await app.request("/api/slices/trav-slice/proof-asset/..%2F..%2Fetc%2Fpasswd");
      expect(res.status).toBe(400);
    });

    it("returns 404 when proof packet exists but the relPath isn't inside it", async () => {
      writeSlice(slicesRoot, "p404-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "p404-slice-20260504");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "real.md"), "");
      const res = await app.request("/api/slices/p404-slice/proof-asset/missing.png");
      expect(res.status).toBe(404);
    });

    it("returns 404 when slice has no proof packet at all", async () => {
      writeSlice(slicesRoot, "no-proof", { "README.md": "---\n---\n" });
      const res = await app.request("/api/slices/no-proof/proof-asset/anything.png");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("proof_packet_not_found");
    });
  });

  describe("GET /api/slices/:name/doc/* (Docs tab)", () => {
    it("returns markdown content for a slice doc", async () => {
      writeSlice(slicesRoot, "doc-slice", { "README.md": "---\n---\n# Hello\nbody" });
      const res = await app.request("/api/slices/doc-slice/doc/README.md");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { relPath: string; content: string };
      expect(body.relPath).toBe("README.md");
      expect(body.content).toContain("# Hello");
    });

    it("rejects path-traversal attempts", async () => {
      writeSlice(slicesRoot, "doc-trav", { "README.md": "---\n---\n" });
      const res = await app.request("/api/slices/doc-trav/doc/..%2F..%2Fetc%2Fpasswd");
      expect(res.status).toBe(400);
    });
  });

  describe("#2487 document and proof reads use the detail route's project selection", () => {
    let workspaceRoot: string;

    beforeEach(() => {
      workspaceRoot = path.join(cleanupDir, "catalog");
      fs.mkdirSync(workspaceRoot);
      fs.writeFileSync(path.join(workspaceRoot, "workspace.yaml"), "projects:\n  - id: alpha\n    root: alpha\n  - id: beta\n    root: beta\n");
      for (const project of ["alpha", "beta"]) {
        const projectRoot = path.join(workspaceRoot, project);
        writeSlice(workspaceRoot, project, {
          "project.yaml": `metadata:\n  id: ${project}\n`, "SPEC.md": `# ${project} project\n`,
        });
        for (const mission of ["a-first", "z-later"]) {
          writeSlice(path.join(projectRoot, "missions"), mission, { "SPEC.md": `# ${mission}\n` });
          writeSlice(path.join(projectRoot, "missions", mission, "slices"), "same-slice", {
            "SPEC.md": `# ${project}/${mission}\n`, "notes/a b.md": `${project}/${mission} nested document\n`,
          });
        }
        const projectEvidenceRoot = path.join(projectRoot, "dogfood-evidence");
        for (const mission of ["a-first", "z-later"]) {
          const scopedProofDir = path.join(projectEvidenceRoot, `${mission}-same-slice`);
          fs.mkdirSync(path.join(scopedProofDir, "screenshots"), { recursive: true });
          fs.writeFileSync(path.join(scopedProofDir, "proof.md"), `# ${project}/${mission} proof\n`);
          fs.writeFileSync(
            path.join(scopedProofDir, "screenshots/scope.png"),
            `${project.toUpperCase()}-${mission.toUpperCase()}-PROOF\n`,
          );
          const mtime = mission === "a-first" ? 1600000003 : 1600000002;
          fs.utimesSync(scopedProofDir, mtime, mtime);
        }
        const proofDir = path.join(dogfoodRoot, `same-slice-${project}`);
        fs.mkdirSync(path.join(proofDir, "screenshots"), { recursive: true });
        fs.writeFileSync(path.join(proofDir, "screenshots/scope.png"), `${project.toUpperCase()}-PROOF\n`);
        fs.utimesSync(proofDir, project === "alpha" ? 1600000001 : 1600000000, project === "alpha" ? 1600000001 : 1600000000);
      }
      slicesRoot = path.join(workspaceRoot, "alpha/missions");
      indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      projector = new SliceDetailProjector({ db, indexer });
      app = buildApp({ indexer, projector, workspaceRoot });
    });

    const addAlphaMissionWithProof = (mission: string, mtime: number): void => {
      const projectRoot = path.join(workspaceRoot, "alpha");
      const missionsRoot = path.join(projectRoot, "missions");
      writeSlice(missionsRoot, mission, { "SPEC.md": `# ${mission}\n` });
      writeSlice(path.join(missionsRoot, mission, "slices"), "same-slice", {
        "SPEC.md": `# alpha/${mission}\n`,
        "notes/a b.md": `alpha/${mission} nested document\n`,
      });
      const proofDir = path.join(projectRoot, "dogfood-evidence", `${mission}-same-slice`);
      fs.mkdirSync(path.join(proofDir, "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(proofDir, "proof.md"), `# alpha/${mission} proof\n`);
      fs.writeFileSync(path.join(proofDir, "screenshots/scope.png"), `ALPHA-${mission.toUpperCase()}-PROOF\n`);
      fs.utimesSync(proofDir, mtime, mtime);
    };

    it.each([
      { project: "alpha", mission: "a-first", literal: "# alpha/a-first\n" },
      { project: "beta", mission: "a-first", literal: "# beta/a-first\n" },
    ])("detail selects project $project/$mission and discovers project-scoped proof", async ({ project, mission, literal }) => {
      const detail = await app.request(`/api/slices/same-slice?project=${project}&mission=${mission}`);
      expect(detail.status).toBe(200);
      const body = await detail.json();
      expect(body.slicePath).toBe(path.join(workspaceRoot, project, "missions", mission, "slices", "same-slice"));
      expect(fs.readFileSync(path.join(body.slicePath, "SPEC.md"), "utf8")).toBe(literal);
      expect(body.missionId).toBe(mission);
      expect(body.tests.proofPackets).toMatchObject([{
        dirName: `${mission}-same-slice`,
        primaryMarkdown: { relPath: "proof.md", content: `# ${project}/${mission} proof\n` },
        screenshots: ["screenshots/scope.png"],
      }]);
      expect(body.tests.aggregate).toEqual({ passCount: 0, failCount: 0 });
    });

    it.each([
      { query: "project=alpha&mission=a-first", rel: "SPEC.md", literal: "# alpha/a-first\n" },
      { query: "project=beta&mission=a-first", rel: "SPEC.md", literal: "# beta/a-first\n" },
      { query: "project=%62eta&mission=a-first", rel: "notes/a%20b.md", literal: "beta/a-first nested document\n" },
    ])("doc returns the selected literal bytes for $query and $rel", async ({ query, rel, literal }) => {
      const response = await app.request(`/api/slices/same-slice/doc/${rel}?${query}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ relPath: decodeURIComponent(rel), content: literal });
    });

    it.each([
      { project: "alpha", mission: "a-first" },
      { project: "beta", mission: "a-first" },
      { project: "alpha", mission: "z-later" },
      { project: "beta", mission: "z-later" },
    ])("qualified proof for $project/$mission serves its scoped packet, not the injected legacy packet", async ({ project, mission }) => {
      const response = await app.request(`/api/slices/same-slice/proof-asset/screenshots/scope.png?project=${project}&mission=${mission}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(await response.text()).toBe(`${project.toUpperCase()}-${mission.toUpperCase()}-PROOF\n`);
    });

    it("qualified detail and proof assets distinguish prefix-overlapping mission names", async () => {
      addAlphaMissionWithProof("a-first-extra", 1600000004);
      const shortDetail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first");
      const shortBody = await shortDetail.json();
      const shortPacket = shortBody.tests.proofPackets[0];
      const shortAsset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
      const shortAssetBytes = await shortAsset.text();

      const longDetail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first-extra");
      const longBody = await longDetail.json();
      const longPacket = longBody.tests.proofPackets[0];
      const longAsset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first-extra");
      const longAssetBytes = await longAsset.text();

      expect({
        short: {
          detailStatus: shortDetail.status,
          missionId: shortBody.missionId,
          proofDir: shortPacket?.dirName,
          proofMarkdown: shortPacket?.primaryMarkdown?.content,
          assetStatus: shortAsset.status,
          assetBytes: shortAssetBytes,
        },
        long: {
          detailStatus: longDetail.status,
          missionId: longBody.missionId,
          proofDir: longPacket?.dirName,
          proofMarkdown: longPacket?.primaryMarkdown?.content,
          assetStatus: longAsset.status,
          assetBytes: longAssetBytes,
        },
      }).toEqual({
        short: {
          detailStatus: 200,
          missionId: "a-first",
          proofDir: "a-first-same-slice",
          proofMarkdown: "# alpha/a-first proof\n",
          assetStatus: 200,
          assetBytes: "ALPHA-A-FIRST-PROOF\n",
        },
        long: {
          detailStatus: 200,
          missionId: "a-first-extra",
          proofDir: "a-first-extra-same-slice",
          proofMarkdown: "# alpha/a-first-extra proof\n",
          assetStatus: 200,
          assetBytes: "ALPHA-A-FIRST-EXTRA-PROOF\n",
        },
      });
    });

    it("does not fall back to an overlapping mission's packet when the requested mission has none", async () => {
      addAlphaMissionWithProof("a-first-extra", 1600000004);
      fs.rmSync(path.join(workspaceRoot, "alpha", "dogfood-evidence", "a-first-same-slice"), { recursive: true });

      const detail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first");
      const detailBody = await detail.json();
      const asset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
      const assetBody = await asset.text();
      expect({
        detailStatus: detail.status,
        proofPackets: detailBody.tests.proofPackets,
        assetStatus: asset.status,
        assetNotFound: assetBody.includes("proof_packet_not_found"),
        otherMissionBytesLeaked: assetBody.includes("ALPHA-A-FIRST-EXTRA-PROOF\n"),
      }).toEqual({
        detailStatus: 200,
        proofPackets: [],
        assetStatus: 404,
        assetNotFound: true,
        otherMissionBytesLeaked: false,
      });
    });

    it.each([
      { siblingKind: "in-project symlinked mission" },
      { siblingKind: "plain mission without slices" },
    ])("does not use an overlapping sibling packet when the sibling is a $siblingKind", async ({ siblingKind }) => {
      addAlphaMissionWithProof("a-first-extra", 1600000004);
      const projectRoot = path.join(workspaceRoot, "alpha");
      const siblingMission = path.join(projectRoot, "missions", "a-first-extra");
      if (siblingKind === "in-project symlinked mission") {
        const archiveMission = path.join(projectRoot, "archive", "a-first-extra");
        fs.mkdirSync(path.dirname(archiveMission), { recursive: true });
        fs.renameSync(siblingMission, archiveMission);
        fs.symlinkSync(path.relative(path.dirname(siblingMission), archiveMission), siblingMission, "dir");
      } else {
        fs.rmSync(path.join(siblingMission, "slices"), { recursive: true, force: true });
      }
      fs.rmSync(path.join(projectRoot, "dogfood-evidence", "a-first-same-slice"), { recursive: true, force: true });

      const detail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first");
      const detailText = await detail.text();
      const detailBody = JSON.parse(detailText) as { missionId?: string; tests?: { proofPackets?: unknown[] } };
      const asset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
      const assetText = await asset.text();
      const returnedText = `${detailText}\n${assetText}`;
      expect({
        detailStatus: detail.status,
        missionId: detailBody.missionId,
        proofPackets: detailBody.tests?.proofPackets,
        assetStatus: asset.status,
        assetNotFound: assetText.includes("proof_packet_not_found"),
        siblingBytesLeaked: returnedText.includes("# alpha/a-first-extra proof") || returnedText.includes("ALPHA-A-FIRST-EXTRA-PROOF"),
      }).toEqual({
        detailStatus: 200,
        missionId: "a-first",
        proofPackets: [],
        assetStatus: 404,
        assetNotFound: true,
        siblingBytesLeaked: false,
      });
    });

    it("preserves mission token order when proof names contain the mission id", async () => {
      addAlphaMissionWithProof("first-a", 1600000004);
      const detail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first");
      const body = await detail.json();
      const packet = body.tests.proofPackets[0];
      const asset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");

      expect({
        proofDir: packet?.dirName,
        proofMarkdown: packet?.primaryMarkdown?.content,
        assetBytes: await asset.text(),
      }).toEqual({
        proofDir: "a-first-same-slice",
        proofMarkdown: "# alpha/a-first proof\n",
        assetBytes: "ALPHA-A-FIRST-PROOF\n",
      });
    });

    const packetPrefixSeparators = [
      { label: "hyphen", separator: "-" },
      { label: "dot", separator: "." },
      { label: "underscore", separator: "_" },
    ] as const;

    it.each(packetPrefixSeparators)(
      "qualified detail and proof assets select an older slice packet over a newer same-mission packet whose only matching token is in the mission prefix ($label separator)",
      async ({ separator }) => {
        addAlphaMissionWithProof("a-first-extra", 1600000040);
        const alphaRoot = path.join(workspaceRoot, "alpha");
        const betaRoot = path.join(workspaceRoot, "beta");
        writeSlice(path.join(alphaRoot, "missions", "a-first", "slices"), "first", {
          "SPEC.md": "# alpha/a-first/first\n",
        });
        writeSlice(path.join(alphaRoot, "missions", "a-first", "slices"), "second", {
          "SPEC.md": "# alpha/a-first/second\n",
        });

        const writeScopedPacket = (
          evidenceRoot: string,
          dirName: string,
          markdown: string,
          assetBytes: string,
          mtime: number,
        ): void => {
          const packetDir = path.join(evidenceRoot, dirName);
          fs.mkdirSync(path.join(packetDir, "screenshots"), { recursive: true });
          fs.writeFileSync(path.join(packetDir, "proof.md"), markdown);
          fs.writeFileSync(path.join(packetDir, "screenshots", "scope.png"), assetBytes);
          fs.utimesSync(packetDir, mtime, mtime);
        };

        const alphaEvidence = path.join(alphaRoot, "dogfood-evidence");
        writeScopedPacket(
          alphaEvidence,
          `a-first${separator}first`,
          "# alpha/a-first/first proof\n",
          "ALPHA-A-FIRST-SLICE-FIRST-PROOF\n",
          1600000010,
        );
        writeScopedPacket(
          alphaEvidence,
          `a-first${separator}second`,
          "# alpha/a-first/second proof\n",
          "ALPHA-A-FIRST-SLICE-SECOND-PROOF\n",
          1600000020,
        );
        writeScopedPacket(
          alphaEvidence,
          `a-first-extra${separator}first`,
          "# alpha/a-first-extra/first proof\n",
          "ALPHA-A-FIRST-EXTRA-SLICE-FIRST-PROOF\n",
          1600000040,
        );
        writeScopedPacket(
          path.join(betaRoot, "dogfood-evidence"),
          `a-first${separator}first`,
          "# beta/a-first/first proof\n",
          "BETA-A-FIRST-SLICE-FIRST-PROOF\n",
          1600000050,
        );

        const firstDetail = await app.request("/api/slices/first?project=alpha&mission=a-first");
        const firstBody = await firstDetail.json();
        const firstPacket = firstBody.tests.proofPackets[0];
        const firstAsset = await app.request("/api/slices/first/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
        const firstAssetBytes = await firstAsset.text();

        const secondDetail = await app.request("/api/slices/second?project=alpha&mission=a-first");
        const secondBody = await secondDetail.json();
        const secondPacket = secondBody.tests.proofPackets[0];
        const secondAsset = await app.request("/api/slices/second/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
        const secondAssetBytes = await secondAsset.text();

        expect({
          first: {
            detailStatus: firstDetail.status,
            missionId: firstBody.missionId,
            proofDir: firstPacket?.dirName,
            proofMarkdown: firstPacket?.primaryMarkdown?.content,
            assetStatus: firstAsset.status,
            assetBytes: firstAssetBytes,
          },
          second: {
            detailStatus: secondDetail.status,
            missionId: secondBody.missionId,
            proofDir: secondPacket?.dirName,
            proofMarkdown: secondPacket?.primaryMarkdown?.content,
            assetStatus: secondAsset.status,
            assetBytes: secondAssetBytes,
          },
        }).toEqual({
          first: {
            detailStatus: 200,
            missionId: "a-first",
            proofDir: `a-first${separator}first`,
            proofMarkdown: "# alpha/a-first/first proof\n",
            assetStatus: 200,
            assetBytes: "ALPHA-A-FIRST-SLICE-FIRST-PROOF\n",
          },
          second: {
            detailStatus: 200,
            missionId: "a-first",
            proofDir: `a-first${separator}second`,
            proofMarkdown: "# alpha/a-first/second proof\n",
            assetStatus: 200,
            assetBytes: "ALPHA-A-FIRST-SLICE-SECOND-PROOF\n",
          },
        });
      },
    );

    it.each(packetPrefixSeparators)(
      "qualified detail and proof assets do not fall back to a same-mission packet whose only matching token is in the mission prefix ($label separator)",
      async ({ separator }) => {
        const alphaRoot = path.join(workspaceRoot, "alpha");
        writeSlice(path.join(alphaRoot, "missions", "a-first", "slices"), "first", {
          "SPEC.md": "# alpha/a-first/first\n",
        });
        const wrongSiblingPacket = path.join(alphaRoot, "dogfood-evidence", `a-first${separator}second`);
        fs.mkdirSync(path.join(wrongSiblingPacket, "screenshots"), { recursive: true });
        fs.writeFileSync(path.join(wrongSiblingPacket, "proof.md"), "# alpha/a-first/second proof\n");
        fs.writeFileSync(path.join(wrongSiblingPacket, "screenshots", "scope.png"), "ALPHA-A-FIRST-SLICE-SECOND-PROOF\n");
        fs.utimesSync(wrongSiblingPacket, 1600000020, 1600000020);

        const detail = await app.request("/api/slices/first?project=alpha&mission=a-first");
        const detailText = await detail.text();
        const detailBody = JSON.parse(detailText) as { missionId?: string; tests?: { proofPackets?: unknown[] } };
        const asset = await app.request("/api/slices/first/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
        const assetText = await asset.text();

        expect({
          detailStatus: detail.status,
          missionId: detailBody.missionId,
          proofPackets: detailBody.tests?.proofPackets,
          assetStatus: asset.status,
          assetNotFound: assetText.includes("proof_packet_not_found"),
          wrongPacketLeaked:
            detailText.includes("# alpha/a-first/second proof")
            || assetText.includes("ALPHA-A-FIRST-SLICE-SECOND-PROOF"),
        }).toEqual({
          detailStatus: 200,
          missionId: "a-first",
          proofPackets: [],
          assetStatus: 404,
          assetNotFound: true,
          wrongPacketLeaked: false,
        });
      },
    );

    const clearEvidenceReadRecord = (): void => {
      (fs.readdirSync as unknown as { mockClear: () => void }).mockClear();
      (fs.readFileSync as unknown as { mockClear: () => void }).mockClear();
    };

    const recordedReadsUnder = (roots: string[]): string[] => {
      const prefixes = Array.from(new Set(roots.flatMap((root) => {
        const resolved = path.resolve(root);
        const parentReal = fs.existsSync(path.dirname(resolved))
          ? path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved))
          : resolved;
        const targetReal = fs.existsSync(resolved) ? fs.realpathSync(resolved) : parentReal;
        return [resolved, parentReal, targetReal];
      })));
      const matchesRoot = (target: unknown): boolean => {
        if (typeof target === "number" || target == null) return false;
        const resolved = path.resolve(String(target));
        return prefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`));
      };
      const readdirCalls = (fs.readdirSync as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((args) => matchesRoot(args[0]))
        .map((args) => `readdir:${String(args[0])}`);
      const readFileCalls = (fs.readFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((args) => matchesRoot(args[0]))
        .map((args) => `readFile:${String(args[0])}`);
      return [...readdirCalls, ...readFileCalls];
    };

    const withEvidenceRootFault = async <T>(
      targetPath: string,
      stage: "resolve" | "access" | "readdir" | "unexpected",
      code: string,
      action: () => Promise<T> | T,
    ): Promise<{ result: T; hits: number }> => {
      evidenceRootFault.targetPath = targetPath;
      evidenceRootFault.stage = stage;
      evidenceRootFault.code = code;
      evidenceRootFault.hits = 0;
      try {
        const result = await action();
        return { result, hits: evidenceRootFault.hits };
      } finally {
        evidenceRootFault.targetPath = null;
        evidenceRootFault.stage = null;
        evidenceRootFault.code = "EACCES";
        evidenceRootFault.hits = 0;
      }
    };

    // Maintainer-directed PR #2960 contract change: an evidence root symlink
    // resolving outside the selected project is treated as an absent evidence
    // root (detail 200 with empty proofPackets; proof-asset 404
    // proof_packet_not_found) without reading outside the project, while an
    // escaping asset symlink inside a valid evidence root still returns 409.
    it("treats a qualified evidence root symlink outside the selected project as absent", async () => {
      const outsideRoot = path.join(cleanupDir, "outside-proof-root");
      const outsidePacket = path.join(outsideRoot, "a-first-same-slice");
      const outsideMarkdown = "OUTSIDE-ROOT-MARKDOWN";
      const outsideAsset = "OUTSIDE-ROOT-ASSET";
      fs.mkdirSync(path.join(outsidePacket, "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(outsidePacket, "proof.md"), `${outsideMarkdown}\n`);
      fs.writeFileSync(path.join(outsidePacket, "screenshots/scope.png"), `${outsideAsset}\n`);
      const selectedEvidenceRoot = path.join(workspaceRoot, "alpha", "dogfood-evidence");
      fs.rmSync(selectedEvidenceRoot, { recursive: true, force: true });
      fs.symlinkSync(outsideRoot, selectedEvidenceRoot, "dir");

      clearEvidenceReadRecord();
      const detail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first");
      const detailText = await detail.text();
      const detailBody = JSON.parse(detailText) as {
        slicePath?: string;
        missionId?: string;
        tests?: { proofPackets?: unknown[] };
      };
      const asset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
      const assetText = await asset.text();
      const assetBody = JSON.parse(assetText) as unknown;
      expect({
        detailStatus: detail.status,
        slicePath: detailBody.slicePath,
        missionId: detailBody.missionId,
        proofPackets: detailBody.tests?.proofPackets,
        detailLeaksOutsideProof: detailText.includes(outsideMarkdown),
        assetStatus: asset.status,
        assetBody,
        assetLeaksOutsideProof: assetText.includes(outsideAsset),
        evidenceReads: recordedReadsUnder([selectedEvidenceRoot, outsideRoot]),
      }).toEqual({
        detailStatus: 200,
        slicePath: path.join(workspaceRoot, "alpha", "missions", "a-first", "slices", "same-slice"),
        missionId: "a-first",
        proofPackets: [],
        detailLeaksOutsideProof: false,
        assetStatus: 404,
        assetBody: { error: "proof_packet_not_found" },
        assetLeaksOutsideProof: false,
        evidenceReads: [],
      });
    });

    it("keeps a missing qualified evidence root optional", async () => {
      fs.rmSync(path.join(workspaceRoot, "alpha", "dogfood-evidence"), { recursive: true });

      const detail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first");
      const detailBody = await detail.json();
      const asset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
      expect({
        detailStatus: detail.status,
        proofPackets: detailBody.tests.proofPackets,
        assetStatus: asset.status,
        assetError: await asset.json(),
      }).toEqual({
        detailStatus: 200,
        proofPackets: [],
        assetStatus: 404,
        assetError: { error: "proof_packet_not_found" },
      });
    });

    it("serves a qualified slice document when the selected project's evidence root symlink escapes the project", async () => {
      const outsideRoot = path.join(cleanupDir, "outside-doc-proof-root");
      const outsidePacket = path.join(outsideRoot, "z-later-same-slice");
      const outsideMarkdown = "OUTSIDE-DOC-ROOT-MARKDOWN";
      const outsideNote = "OUTSIDE-DOC-ROOT-NOTE";
      fs.mkdirSync(path.join(outsidePacket, "notes"), { recursive: true });
      fs.writeFileSync(path.join(outsidePacket, "proof.md"), `${outsideMarkdown}\n`);
      fs.writeFileSync(path.join(outsidePacket, "notes", "a b.md"), `${outsideNote}\n`);
      const selectedEvidenceRoot = path.join(workspaceRoot, "alpha", "dogfood-evidence");
      fs.rmSync(selectedEvidenceRoot, { recursive: true, force: true });
      fs.symlinkSync(outsideRoot, selectedEvidenceRoot, "dir");

      clearEvidenceReadRecord();
      const response = await app.request("/api/slices/same-slice/doc/notes/a%20b.md?project=alpha&mission=z-later");
      const responseText = await response.text();
      const body = JSON.parse(responseText) as unknown;
      expect({
        status: response.status,
        body,
        evidenceReads: recordedReadsUnder([selectedEvidenceRoot, outsideRoot]),
        leaksOutsideEvidence: responseText.includes(outsideMarkdown) || responseText.includes(outsideNote),
      }).toEqual({
        status: 200,
        body: { relPath: "notes/a b.md", content: "alpha/z-later nested document\n" },
        evidenceReads: [],
        leaksOutsideEvidence: false,
      });
    });

    describe("when the selected project's evidence root symlink is dangling", () => {
      let missingTarget: string;
      let selectedEvidenceRoot: string;

      beforeEach(() => {
        missingTarget = path.join(cleanupDir, "missing-doc-proof-root");
        selectedEvidenceRoot = path.join(workspaceRoot, "alpha", "dogfood-evidence");
        fs.rmSync(selectedEvidenceRoot, { recursive: true, force: true });
        fs.symlinkSync(missingTarget, selectedEvidenceRoot, "dir");
        expect(fs.existsSync(missingTarget)).toBe(false);
        expect(fs.lstatSync(selectedEvidenceRoot).isSymbolicLink()).toBe(true);
      });

      it("serves a qualified slice document when the selected project's evidence root symlink is dangling", async () => {
        clearEvidenceReadRecord();
        const response = await app.request("/api/slices/same-slice/doc/notes/a%20b.md?project=alpha&mission=z-later");
        const responseText = await response.text();
        const body = JSON.parse(responseText) as unknown;
        expect({
          status: response.status,
          body,
          evidenceReads: recordedReadsUnder([selectedEvidenceRoot, missingTarget]),
        }).toEqual({
          status: 200,
          body: { relPath: "notes/a b.md", content: "alpha/z-later nested document\n" },
          evidenceReads: [],
        });
      });

      // Maintainer-directed PR #2960 contract change: a dangling evidence root
      // symlink is treated as an absent evidence root rather than 409
      // project_source_unavailable, matching missing-root behavior on detail
      // (200 with empty proofPackets) and proof-asset (404 proof_packet_not_found).
      it("treats a dangling qualified evidence root symlink as absent on detail and proof-asset", async () => {
        clearEvidenceReadRecord();
        const detail = await app.request("/api/slices/same-slice?project=alpha&mission=z-later");
        const detailBody = await detail.json() as {
          slicePath?: string;
          missionId?: string;
          tests?: { proofPackets?: unknown[] };
        };
        const asset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=z-later");
        const assetBody = await asset.json() as unknown;
        expect({
          detailStatus: detail.status,
          slicePath: detailBody.slicePath,
          missionId: detailBody.missionId,
          proofPackets: detailBody.tests?.proofPackets,
          assetStatus: asset.status,
          assetBody,
          evidenceReads: recordedReadsUnder([selectedEvidenceRoot, missingTarget]),
        }).toEqual({
          detailStatus: 200,
          slicePath: path.join(workspaceRoot, "alpha", "missions", "z-later", "slices", "same-slice"),
          missionId: "z-later",
          proofPackets: [],
          assetStatus: 404,
          assetBody: { error: "proof_packet_not_found" },
          evidenceReads: [],
        });
      });
    });

    it.each(["resolve", "access"] as const)(
      "treats an unreadable qualified evidence root (%s EACCES) as absent on detail and proof-asset",
      async (stage) => {
        const selectedEvidenceRoot = fs.realpathSync(path.join(workspaceRoot, "alpha", "dogfood-evidence"));
        const { result, hits } = await withEvidenceRootFault(selectedEvidenceRoot, stage, "EACCES", async () => {
          const detail = await app.request("/api/slices/same-slice?project=alpha&mission=a-first");
          const detailText = await detail.text();
          const detailBody = JSON.parse(detailText) as {
            slicePath?: string;
            missionId?: string;
            tests?: { proofPackets?: unknown[] };
          };
          const asset = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
          const assetText = await asset.text();
          const assetBody = JSON.parse(assetText) as unknown;
          const doc = await app.request("/api/slices/same-slice/doc/SPEC.md?project=alpha&mission=a-first");
          const docBody = await doc.json() as unknown;
          return {
            detailStatus: detail.status,
            slicePath: detailBody.slicePath,
            missionId: detailBody.missionId,
            proofPackets: detailBody.tests?.proofPackets,
            detailLeaksProof: detailText.includes("alpha/a-first proof"),
            assetStatus: asset.status,
            assetBody,
            assetLeaksProof: assetText.includes("ALPHA-PROOF"),
            docStatus: doc.status,
            docBody,
          };
        });
        expect({ ...result, faultTriggered: hits > 0 }).toEqual({
          detailStatus: 200,
          slicePath: path.join(workspaceRoot, "alpha", "missions", "a-first", "slices", "same-slice"),
          missionId: "a-first",
          proofPackets: [],
          detailLeaksProof: false,
          assetStatus: 404,
          assetBody: { error: "proof_packet_not_found" },
          assetLeaksProof: false,
          docStatus: 200,
          docBody: { relPath: "SPEC.md", content: "# alpha/a-first\n" },
          faultTriggered: true,
        });
      },
    );

    it("qualifiedEvidenceRoot returns null for unavailable or escaping roots without swallowing unrelated caller errors", async () => {
      const helper = (slicesRoutesModule as {
        qualifiedEvidenceRoot?: (projectRoot: string, missionsRoot: string) => string | null;
      }).qualifiedEvidenceRoot;
      expect(helper).toBeTypeOf("function");

      const alphaRoot = fs.realpathSync(path.join(workspaceRoot, "alpha"));
      const alphaMissionsRoot = path.join(alphaRoot, "missions");
      const selectedEvidenceRoot = path.join(alphaRoot, "dogfood-evidence");
      expect(helper!(alphaRoot, alphaMissionsRoot)).toBe(selectedEvidenceRoot);

      for (const stage of ["resolve", "access", "readdir"] as const) {
        const { result, hits } = await withEvidenceRootFault(selectedEvidenceRoot, stage, "EACCES", () =>
          helper!(alphaRoot, alphaMissionsRoot),
        );
        expect({ stage, result, faultTriggered: hits > 0 }).toEqual({
          stage,
          result: null,
          faultTriggered: true,
        });
      }

      await expect(
        withEvidenceRootFault(selectedEvidenceRoot, "unexpected", "EACCES", () =>
          helper!(alphaRoot, alphaMissionsRoot),
        ),
      ).rejects.toThrow(TypeError);

      fs.rmSync(selectedEvidenceRoot, { recursive: true, force: true });
      expect(helper!(alphaRoot, alphaMissionsRoot)).toBeNull();

      const missingTarget = path.join(cleanupDir, "missing-helper-evidence-root");
      fs.symlinkSync(missingTarget, selectedEvidenceRoot, "dir");
      expect(helper!(alphaRoot, alphaMissionsRoot)).toBeNull();

      fs.rmSync(selectedEvidenceRoot, { recursive: true, force: true });
      const outsideRoot = path.join(cleanupDir, "outside-helper-evidence-root");
      fs.mkdirSync(outsideRoot, { recursive: true });
      fs.symlinkSync(outsideRoot, selectedEvidenceRoot, "dir");
      expect(helper!(alphaRoot, alphaMissionsRoot)).toBeNull();

      fs.rmSync(selectedEvidenceRoot, { recursive: true, force: true });
      fs.writeFileSync(selectedEvidenceRoot, "not-a-directory\n");
      expect(helper!(alphaRoot, alphaMissionsRoot)).toBeNull();
    });

    it("rejects a qualified proof asset symlink outside the selected project", async () => {
      const outsideAsset = "OUTSIDE-DIRECT-ASSET-BYTES";
      const outsidePath = path.join(cleanupDir, "outside-proof-asset.png");
      const selectedAsset = path.join(workspaceRoot, "alpha", "dogfood-evidence", "a-first-same-slice", "screenshots", "scope.png");
      fs.writeFileSync(outsidePath, `${outsideAsset}\n`);
      fs.rmSync(selectedAsset);
      fs.symlinkSync(outsidePath, selectedAsset, "file");

      const response = await app.request("/api/slices/same-slice/proof-asset/screenshots/scope.png?project=alpha&mission=a-first");
      const responseText = await response.text();
      expect({
        status: response.status,
        projectPathEscape: responseText.includes("project_path_escape"),
        leaksOutsideAsset: responseText.includes(outsideAsset),
      }).toEqual({ status: 409, projectPathEscape: true, leaksOutsideAsset: false });
    });

    it("uses the missions-root-relative evidence directory for custom missions.root", async () => {
      const project = "custom";
      const mission = "custom-first";
      const slice = "same-slice";
      const projectRoot = path.join(workspaceRoot, project);
      fs.writeFileSync(path.join(workspaceRoot, "workspace.yaml"),
        "projects:\n  - id: alpha\n    root: alpha\n  - id: beta\n    root: beta\n  - id: custom\n    root: custom\n");
      writeSlice(workspaceRoot, project, {
        "project.yaml": "metadata:\n  id: custom\nmissions:\n  root: work/missions\n",
        "SPEC.md": "# custom project\n",
      });
      const missionsRoot = path.join(projectRoot, "work", "missions");
      writeSlice(missionsRoot, mission, { "SPEC.md": `# ${mission}\n` });
      writeSlice(path.join(missionsRoot, mission, "slices"), slice, { "SPEC.md": `# ${project}/${mission}\n` });

      // The CLI contract is path.dirname(project/work/missions)/dogfood-evidence,
      // i.e. project/work/dogfood-evidence; this is a literal fixture path, not a helper call.
      const conventionalRoot = path.join(projectRoot, "work", "dogfood-evidence");
      const projectRootDecoy = path.join(projectRoot, "dogfood-evidence");
      const writePacket = (root: string, marker: string, mtime: number): void => {
        const packet = path.join(root, `${mission}-${slice}`);
        fs.mkdirSync(path.join(packet, "screenshots"), { recursive: true });
        fs.writeFileSync(path.join(packet, "proof.md"), `# ${marker}\n`);
        fs.writeFileSync(path.join(packet, "screenshots/scope.png"), `${marker}\n`);
        fs.utimesSync(packet, mtime, mtime);
      };
      const expectedMarker = "CUSTOM-WORK-MISSIONS-PROOF";
      writePacket(conventionalRoot, expectedMarker, 1600000004);
      writePacket(projectRootDecoy, "CUSTOM-PROJECT-ROOT-DECOY", 1600000005);

      const detail = await app.request(`/api/slices/${slice}?project=${project}&mission=${mission}`);
      const body = await detail.json();
      const packet = body.tests.proofPackets[0];
      const asset = await app.request(`/api/slices/${slice}/proof-asset/screenshots/scope.png?project=${project}&mission=${mission}`);
      expect({
        detailStatus: detail.status,
        proofDir: packet?.dirName,
        proofMarkdown: packet?.primaryMarkdown?.content,
        assetStatus: asset.status,
        assetBytes: await asset.text(),
      }).toEqual({
        detailStatus: 200,
        proofDir: `${mission}-${slice}`,
        proofMarkdown: `# ${expectedMarker}\n`,
        assetStatus: 200,
        assetBytes: `${expectedMarker}\n`,
      });
    });

    it("keeps missions.root . healthy and treats its parent evidence store as optional", async () => {
      const project = "dot-root";
      const mission = "dot-first";
      const slice = "same-slice";
      const projectRoot = path.join(workspaceRoot, project);
      fs.writeFileSync(path.join(workspaceRoot, "workspace.yaml"),
        "projects:\n  - id: alpha\n    root: alpha\n  - id: beta\n    root: beta\n  - id: dot-root\n    root: dot-root\n");
      writeSlice(workspaceRoot, project, {
        "project.yaml": "metadata:\n  id: dot-root\nmissions:\n  root: .\n",
        "SPEC.md": "# dot-root project\n",
      });
      writeSlice(projectRoot, mission, { "SPEC.md": `# ${mission}\n` });
      writeSlice(path.join(projectRoot, mission, "slices"), slice, {
        "SPEC.md": "# dot-root/dot-first\n",
        "notes/a b.md": "dot-root own document\n",
      });

      // Literal parent path for missions.root: .; this is the legacy store outside the project.
      const parentEvidenceRoot = path.join(workspaceRoot, "dogfood-evidence");
      const parentPacket = path.join(parentEvidenceRoot, `${mission}-${slice}`);
      const parentMarkdownMarker = "PARENT-LEGACY-PROOF-ROOT";
      const parentAssetMarker = "PARENT-LEGACY-PROOF-ASSET";
      fs.mkdirSync(path.join(parentPacket, "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(parentPacket, "proof.md"), `# ${parentMarkdownMarker}\n`);
      fs.writeFileSync(path.join(parentPacket, "screenshots/scope.png"), `${parentAssetMarker}\n`);

      const detail = await app.request(`/api/slices/${slice}?project=${project}&mission=${mission}`);
      const detailBody = await detail.json();
      const doc = await app.request(`/api/slices/${slice}/doc/SPEC.md?project=${project}&mission=${mission}`);
      const docBody = await doc.json();
      const asset = await app.request(`/api/slices/${slice}/proof-asset/screenshots/scope.png?project=${project}&mission=${mission}`);
      const assetText = await asset.text();
      const returnedText = `${JSON.stringify(detailBody)}\n${JSON.stringify(docBody)}\n${assetText}`;
      expect({
        detailStatus: detail.status,
        slicePath: detailBody.slicePath,
        missionId: detailBody.missionId,
        proofPackets: detailBody.tests?.proofPackets,
        docStatus: doc.status,
        docBody,
        assetStatus: asset.status,
        assetNotFound: assetText.includes("proof_packet_not_found"),
        parentProofBytesLeaked: returnedText.includes(parentMarkdownMarker) || returnedText.includes(parentAssetMarker),
      }).toEqual({
        detailStatus: 200,
        slicePath: path.join(projectRoot, mission, "slices", slice),
        missionId: mission,
        proofPackets: [],
        docStatus: 200,
        docBody: { relPath: "SPEC.md", content: "# dot-root/dot-first\n" },
        assetStatus: 404,
        assetNotFound: true,
        parentProofBytesLeaked: false,
      });
    });

    it("qualified detail finds the later duplicate mission and its own proof packet", async () => {
      const expectedSlicePath = path.join(workspaceRoot, "alpha", "missions", "z-later", "slices", "same-slice");
      expect(fs.readFileSync(path.join(expectedSlicePath, "SPEC.md"), "utf8")).toBe("# alpha/z-later\n");
      const detail = await app.request("/api/slices/same-slice?project=alpha&mission=z-later");
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        slicePath: expectedSlicePath,
        missionId: "z-later",
        tests: { proofPackets: [{
          dirName: "z-later-same-slice",
          primaryMarkdown: { relPath: "proof.md", content: "# alpha/z-later proof\n" },
          screenshots: ["screenshots/scope.png"],
        }] },
      });
    });

    it("doc follows the detail route's later-duplicate mission selection", async () => {
      const response = await app.request("/api/slices/same-slice/doc/SPEC.md?project=alpha&mission=z-later");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ relPath: "SPEC.md", content: "# alpha/z-later\n" });
    });

    it.each([
      { route: "detail", endpoint: "" },
      { route: "doc", endpoint: "/doc/SPEC.md" },
      { route: "proof", endpoint: "/proof-asset/screenshots/scope.png" },
    ])("qualified $route preserves the source error for a nonexistent mission", async ({ endpoint }) => {
      const response = await app.request(`/api/slices/same-slice${endpoint}?project=alpha&mission=unrelated`);
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe("project_source_unavailable");
      expect(body.message).toMatch(/ENOENT|no such file/i);
      expect(body).not.toHaveProperty("content");
      expect(body).not.toHaveProperty("proofPackets");
    });

    it.each([
      { route: "detail", endpoint: "" },
      { route: "doc", endpoint: "/doc/SPEC.md" },
      { route: "proof", endpoint: "/proof-asset/screenshots/scope.png" },
    ])("returns project_not_found from $route through the default Node adapter", async ({ endpoint }) => {
      const originalRequest = globalThis.Request;
      const originalResponse = globalThis.Response;
      const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Request")!;
      const responseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Response")!;
      let server: ReturnType<typeof createServer> | undefined;
      try {
        // Exercise the adapter defaults that replace the request and response globals.
        server = createServer(getRequestListener(app.fetch));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        expect(globalThis.Request).not.toBe(originalRequest);
        expect(globalThis.Response).not.toBe(originalResponse);
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
        expect(address.address).toBe("127.0.0.1");
        expect(address.port).toBeGreaterThanOrEqual(32768);
        const response = await fetch(`http://127.0.0.1:${address.port}/api/slices/same-slice${endpoint}?project=missing&mission=a-first`, {
          headers: { Connection: "close" },
        });
        const body = await response.text();
        expect(response.status).toBe(409);
        expect(JSON.parse(body)).toMatchObject({ error: "project_not_found" });
      } finally {
        try {
          if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()));
          }
        } finally {
          Object.defineProperty(globalThis, "Request", requestDescriptor);
          Object.defineProperty(globalThis, "Response", responseDescriptor);
          expect(Object.getOwnPropertyDescriptor(globalThis, "Request")).toEqual(requestDescriptor);
          expect(Object.getOwnPropertyDescriptor(globalThis, "Response")).toEqual(responseDescriptor);
          expect(globalThis.Request).toBe(originalRequest);
          expect(globalThis.Response).toBe(originalResponse);
          expect(server?.listening ?? false).toBe(false);
          expect(server?.address() ?? null).toBeNull();
        }
      }
    });

    it.each(["", "?mission=z-later"])("unqualified ambiguous reads preserve the literal first-name selection for %s", async (query) => {
      const detail = await app.request(`/api/slices/same-slice${query}`);
      expect(detail.status).toBe(200);
      const body = await detail.json();
      expect(body.missionId).toBe("a-first");
      expect(body.slicePath).toBe(path.join(workspaceRoot, "alpha/missions/a-first/slices/same-slice"));
      const doc = await app.request(`/api/slices/same-slice/doc/SPEC.md${query}`);
      expect(doc.status).toBe(200);
      expect(await doc.json()).toEqual({ relPath: "SPEC.md", content: "# alpha/a-first\n" });
      const proof = await app.request(`/api/slices/same-slice/proof-asset/screenshots/scope.png${query}`);
      expect(proof.status).toBe(200);
      expect(await proof.text()).toBe("ALPHA-PROOF\n");
    });

    it.each([
      { query: "project=missing&mission=a-first", status: 409, error: "project_not_found" },
      { query: "project=alpha", status: 400, error: "exact_mission_and_slice_required" },
      { query: "project=alpha&mission=..%2Fbeta", status: 409, error: "invalid_mission" },
      { query: "project=alpha&mission=a-first&projectRoot=not-current-root", status: 409, error: "project_changed" },
    ].flatMap(row => ["doc/SPEC.md", "proof-asset/screenshots/scope.png"].map(endpoint => ({ ...row, endpoint }))))(
      "$endpoint keeps detail selection error $error for $query", async ({ query, status, error, endpoint }) => {
        const detail = await app.request(`/api/slices/same-slice?${query}`);
        expect(detail.status).toBe(status);
        expect(await detail.json()).toMatchObject({ error });
        const response = await app.request(`/api/slices/same-slice/${endpoint}?${query}`);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error });
      },
    );

    it.each([
      { endpoint: "doc/..%2F..%2Foutside.md", error: "doc_path_invalid" },
      { endpoint: "proof-asset/..%2F..%2Foutside.png", error: "proof_asset_path_invalid" },
    ])("keeps the existing path guard for $endpoint", async ({ endpoint, error }) => {
      const response = await app.request(`/api/slices/same-slice/${endpoint}?project=beta&mission=a-first`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    });

    it.each(["", "/doc/SPEC.md", "/proof-asset/screenshots/scope.png"])("preserves the production browser boundary and token exception for %s", async (endpoint) => {
      const guarded = buildApp({ indexer, projector, workspaceRoot, guardBrowser: true });
      const url = `/api/slices/same-slice${endpoint}`;
      const refused = await guarded.request(url, { headers: { Host: "other.invalid" } });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "untrusted_host" });
      const accepted = await guarded.request(url, { headers: { Host: "other.invalid", Authorization: "Bearer fixture-read-token" } });
      expect(accepted.status).toBe(200);
      const origin = await guarded.request(url, { headers: { Host: "localhost", Origin: "http://other.invalid", Authorization: "Bearer fixture-read-token" } });
      expect(origin.status).toBe(403);
      expect(await origin.json()).toMatchObject({ code: "browser_origin_refused" });
    });
  });

  describe("Route-order discipline (Phase A R1 lesson)", () => {
    it("literal /api/slices is not shadowed by /:name", async () => {
      writeSlice(slicesRoot, "list", { "README.md": "---\n---\n" });
      const res = await app.request("/api/slices");
      expect(res.status).toBe(200);
      // Body is the LIST envelope, NOT a per-slice payload.
      const body = (await res.json()) as { slices: unknown; totalCount: unknown };
      expect(body).toHaveProperty("slices");
      expect(body).toHaveProperty("totalCount");
    });

    it("proof-asset path is not shadowed by /:name catchall", async () => {
      writeSlice(slicesRoot, "ord-slice", { "README.md": "---\n---\n" });
      const dir = path.join(dogfoodRoot, "ord-slice-20260504");
      fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(dir, "screenshots", "x.png"), "px");
      const res = await app.request("/api/slices/ord-slice/proof-asset/screenshots/x.png");
      expect(res.status).toBe(200);
      // Asserts the response is the binary asset, not the JSON detail
      // payload (which would have content-type application/json).
      expect(res.headers.get("content-type")).toBe("image/png");
    });
  });

  // V0.3.1 slice 17 founder-walk-workspace-state-correctness (walk item 8 — Explorer auto-show). POST /api/slices/refresh drops both
  // indexer caches so newly-created slice / mission folders show up
  // without a daemon restart.
  describe("POST /api/slices/refresh", () => {
    it("returns 200 + drops the listing cache so freshly-created slices appear", async () => {
      writeSlice(slicesRoot, "before-slice", { "README.md": "---\n---\n" });
      // Prime the cache via a list call
      const first = await app.request("/api/slices");
      const firstList = (await first.json()) as { slices: Array<{ name: string }> };
      expect(firstList.slices.map((s) => s.name)).toEqual(["before-slice"]);

      // Add another slice on disk AFTER cache primed
      writeSlice(slicesRoot, "after-slice", { "README.md": "---\n---\n" });
      // Without refresh, the cached list should still be stale
      const stale = await app.request("/api/slices");
      const staleList = (await stale.json()) as { slices: Array<{ name: string }> };
      expect(staleList.slices.map((s) => s.name).sort()).toEqual(["before-slice"]);

      // Trigger refresh
      const refresh = await app.request("/api/slices/refresh", { method: "POST" });
      expect(refresh.status).toBe(200);
      const refreshBody = (await refresh.json()) as { ok: boolean };
      expect(refreshBody.ok).toBe(true);

      // Now the list call picks up the new slice
      const fresh = await app.request("/api/slices");
      const freshList = (await fresh.json()) as { slices: Array<{ name: string }> };
      expect(freshList.slices.map((s) => s.name).sort()).toEqual(["after-slice", "before-slice"]);
    });

    it("returns 503 when indexer is not wired", async () => {
      const bareApp = new Hono();
      bareApp.route("/api/slices", slicesRoutes());
      const res = await bareApp.request("/api/slices/refresh", { method: "POST" });
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/slices?refresh=1", () => {
    it("drops the listing cache before returning the list", async () => {
      writeSlice(slicesRoot, "before-slice", { "README.md": "---\n---\n" });
      const first = await app.request("/api/slices");
      const firstList = (await first.json()) as { slices: Array<{ name: string }> };
      expect(firstList.slices.map((s) => s.name)).toEqual(["before-slice"]);

      writeSlice(slicesRoot, "after-slice", { "README.md": "---\n---\n" });
      const stale = await app.request("/api/slices");
      const staleList = (await stale.json()) as { slices: Array<{ name: string }> };
      expect(staleList.slices.map((s) => s.name)).toEqual(["before-slice"]);

      const fresh = await app.request("/api/slices?refresh=1");
      const freshList = (await fresh.json()) as { slices: Array<{ name: string }> };
      expect(freshList.slices.map((s) => s.name).sort()).toEqual(["after-slice", "before-slice"]);
    });
  });
});

// ---------------------------------------------------------------------------
// qitem-render-driver #3 — the HTTP contract behind the sidebar badge.
//
// Host evidence: GET /api/slices emits qitemCount=355 for placeholder slices
// while siblings emit 1/1/2. The indexer-level discriminator lives in
// slice-indexer.test.ts; THIS pins the observable the UI actually consumes —
// the route response — on a MODERN multi-slice mission (a sibling carries
// typed `slice:` membership) where the zero-typed target authors no rail item
// (railItem therefore defaults to missionId).
// ---------------------------------------------------------------------------

describe("qitem-render-driver #3 — GET /api/slices qitemCount does not leak mission-wide rows", () => {
  let db: Database.Database;
  let cleanup: string;
  let missionsRoot: string;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-leak', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slices-routes-leak-"));
    missionsRoot = path.join(cleanup, "missions");
    const slices = path.join(missionsRoot, "release-x", "slices");
    writeSlice(slices, "01-typed-sibling", { "README.md": "---\nstatus: active\n---\n# sibling\n" });
    writeSlice(slices, "02-placeholder", { "README.md": "---\nstatus: placeholder\n---\n# placeholder\n" });
    // Modern signal: typed membership exists in this mission.
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tags, body)
       VALUES ('q-typed-sibling', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'a@r', 'b@r', 'in-progress', 'routine', ?, 'no name mention')`,
    ).run(JSON.stringify(["slice:01-typed-sibling"]));
    // Mission-scope rows — the 355-class rows.
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tags, body)
       VALUES ('q-mission-tag', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'a@r', 'b@r', 'in-progress', 'routine', ?, 'no slice mention')`,
    ).run(JSON.stringify(["mission:release-x"]));
    insertQitem(db, { qitemId: "q-mission-body", body: "advance the release-x mission" });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer });
    app = buildApp({ indexer, projector });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("RED: the zero-typed target's qitemCount is 0 in the /api/slices response, while the typed sibling keeps its own count", async () => {
    const res = await app.request("/api/slices?filter=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slices: Array<{ name: string; qitemCount: number }> };
    const byName = new Map(body.slices.map((s) => [s.name, s.qitemCount]));
    expect(byName.get("02-placeholder"), "the number the sidebar badge renders for the placeholder slice").toBe(0);
    // Sibling semantics preserved: typed membership still counted, and the
    // mission-scope rows do not inflate it either.
    expect(byName.get("01-typed-sibling"), "typed sibling keeps exactly its typed membership").toBe(1);
  });
});

describe("GET /api/slices observed queue counts", () => {
  const ZERO = { pending: 0, "in-progress": 0, done: 0, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0 };
  type Counts = typeof ZERO;
  type Entry = { name: string; missionId: string | null; slicePath: string; status: string; rawStatus: string | null; qitemCount: number; queueCounts?: Counts | null; derivedState?: string };
  let db: Database.Database;
  let root: string;
  let docs: Map<string, string>;
  let settings: SettingsStore;

  function write(file: string, bytes: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    docs.set(file, bytes);
  }

  function catalog(projects = [{ id: "alpha", root: "alpha" }, { id: "beta", root: "beta" }]): void {
    write(path.join(root, "workspace.yaml"), JSON.stringify({ projects }));
  }

  function addCatalogProject(id: string, catalogRoot: string): string {
    const projectRoot = path.resolve(root, catalogRoot);
    write(path.join(projectRoot, "SPEC.md"), `---\nid: ${id}\n---\n# Project\n`);
    write(path.join(projectRoot, "project.yaml"), `id: ${id}\nmissions:\n  root: missions\n`);
    return path.join(projectRoot, "missions");
  }

  function configureCatalogRoute(slicesRoot: string): void {
    const config = path.join(root, "settings.json");
    write(config, JSON.stringify({ workspace: { root, catalogPath: path.join(root, "workspace.yaml"), slicesRoot } }));
    settings = new SettingsStore(config);
  }

  function nodeBytes(id: string, status = "active", heading = "Node"): string {
    return `---\nid: ${id}\nstatus: ${status}\n---\n# ${heading}\n`;
  }

  function addSlice(
    project: string,
    mission: string,
    name: string,
    status = "active",
    id = name,
    nodeFiles: { slice?: string | null; mission?: string | null; missionId?: string } = {},
  ): string {
    const missionRoot = path.join(root, project, "missions", mission);
    if (nodeFiles.mission !== null) {
      const missionFile = nodeFiles.mission ?? "SPEC.md";
      const missionId = nodeFiles.missionId ?? `M.${mission.toUpperCase()}`;
      write(path.join(missionRoot, missionFile), nodeBytes(missionId, "active", "Mission"));
    }
    const dir = path.join(missionRoot, "slices", name);
    fs.mkdirSync(dir, { recursive: true });
    if (nodeFiles.slice !== null) {
      const sliceFile = nodeFiles.slice ?? "SPEC.md";
      write(path.join(dir, sliceFile), nodeBytes(id, status, "Slice"));
    }
    return dir;
  }

  function row(id: string, state: string, tags: string[] | null, body = "work"): void {
    db.prepare(`INSERT INTO queue_items
      (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, tags)
      VALUES (?, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z', 'writer@fixture', 'worker@fixture', ?, 'routine', ?, ?)`)
      .run(id, state, body, tags === null ? null : JSON.stringify(tags));
  }

  function route(project = "alpha", explicit = false, slicesRoot = path.join(root, project, "missions"), additionalSliceRoots: string[] = []) {
    // Startup supplies roots/db without projectId. Keep that ordinary construction covered.
    const indexer = new SliceIndexer({ db, slicesRoot, additionalSliceRoots,
      dogfoodEvidenceRoot: null, ...(explicit ? { projectId: project } : {}) });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sliceIndexer" as never, indexer);
      c.set("sliceDetailProjector" as never, new SliceDetailProjector({ db, indexer }));
      c.set("settingsStore" as never, settings);
      await next();
    });
    app.route("/api/slices", slicesRoutes());
    return { app, indexer };
  }

  async function list(app: Hono, query = ""): Promise<Entry[]> {
    const response = await app.request("/api/slices" + query);
    expect(response.status).toBe(200);
    const body = await response.json() as { slices: Entry[]; totalCount: number; filter: string };
    expect(body.totalCount).toBe(body.slices.length);
    expect(body.filter).toBe(new URL("http://fixture.invalid/" + query).searchParams.get("filter") ?? "all");
    return body.slices;
  }

  async function withNodeReadFailure<T>(
    file: string,
    code: string,
    action: () => Promise<T>,
  ): Promise<{ result: T; failureHits: number }> {
    nodeMetadataFault.readPath = file;
    nodeMetadataFault.readCode = code;
    nodeMetadataFault.readHits = 0;
    try {
      const result = await action();
      return { result, failureHits: nodeMetadataFault.readHits };
    } finally {
      nodeMetadataFault.readPath = null;
      nodeMetadataFault.readHits = 0;
    }
  }

  async function withNodeSelectionFailure<T>(
    file: string,
    code: string,
    action: () => Promise<T>,
  ): Promise<{ result: T; failureHits: number }> {
    nodeMetadataFault.selectionPath = file;
    nodeMetadataFault.selectionCode = code;
    nodeMetadataFault.selectionHits = 0;
    try {
      const result = await action();
      return { result, failureHits: nodeMetadataFault.selectionHits };
    } finally {
      nodeMetadataFault.selectionPath = null;
      nodeMetadataFault.selectionHits = 0;
    }
  }

  function authoredUnchanged(): void {
    for (const [file, bytes] of docs) expect(fs.readFileSync(file, "utf8"), file).toBe(bytes);
  }

  async function withCatalogReadCount<T>(action: () => Promise<T>): Promise<{ result: T; reads: number }> {
    catalogReadObservation.activePath = path.join(root, "workspace.yaml");
    catalogReadObservation.reads = 0;
    try {
      const result = await action();
      return { result, reads: catalogReadObservation.reads };
    } finally {
      catalogReadObservation.activePath = null;
      catalogReadObservation.reads = 0;
    }
  }

  beforeEach(() => {
    nodeMetadataFault.readPath = null;
    nodeMetadataFault.readHits = 0;
    nodeMetadataFault.selectionPath = null;
    nodeMetadataFault.selectionHits = 0;
    realpathSyncFault.targetPath = null;
    realpathSyncFault.hits = 0;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "slice-counts-")));
    docs = new Map();
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    catalog();
    for (const project of ["alpha", "beta"]) {
      write(path.join(root, project, "SPEC.md"), `---\nid: ${project}\n---\n# Project\n`);
      write(path.join(root, project, "project.yaml"), `id: ${project}\nmissions:\n  root: missions\n`);
      fs.mkdirSync(path.join(root, project, "missions"), { recursive: true });
    }
    const config = path.join(root, "settings.json");
    write(config, JSON.stringify({ workspace: { root, catalogPath: path.join(root, "workspace.yaml"),
      slicesRoot: path.join(root, "alpha", "missions") } }));
    settings = new SettingsStore(config);
  });

  afterEach(() => {
    try { authoredUnchanged(); }
    finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves authored status, rawStatus, filters and legacy display membership", async () => {
    addSlice("alpha", "shipping", "live", "ratified");
    addSlice("alpha", "shipping", "finished", "shipped");
    addSlice("alpha", "shipping", "held", "parked-with-evidence");
    addSlice("alpha", "shipping", "idea", "placeholder");
    row("legacy-display", "blocked", null, "live work");
    const { app } = route();
    const all = await list(app);
    expect(all.map(s => [s.name, s.status, s.rawStatus, s.qitemCount]).sort()).toEqual([
      ["finished", "done", "shipped", 0], ["held", "blocked", "parked-with-evidence", 0],
      ["idea", "draft", "placeholder", 0], ["live", "active", "ratified", 1],
    ]);
    for (const [filter, expected] of [["active", "live"], ["done", "finished"], ["blocked", "held"]]) {
      expect((await list(app, "?filter=" + filter)).map(s => s.name)).toEqual([expected]);
    }
    const invalid = await app.request("/api/slices?filter=unknown");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "filter_invalid" });
  });

  it("#2727 separates in-place non-delivery closed slices (?filter=closed) from ?filter=done and ?filter=active", async () => {
    addSlice("alpha", "shipping", "delivered", "done");
    addSlice("alpha", "shipping", "deferred", "closed-deferred");
    addSlice("alpha", "shipping", "superseded", "closed-superseded");
    addSlice("alpha", "shipping", "live", "active");
    const { app } = route();
    expect((await list(app, "?filter=done")).map((s) => s.name)).toEqual(["delivered"]);
    expect((await list(app, "?filter=active")).map((s) => s.name)).toEqual(["live"]);
    expect((await list(app, "?filter=closed")).map((s) => s.name).sort()).toEqual(["deferred", "superseded"]);
  });

  it("on a WAL file, reads the count rows before the batch, off the main handle, with the same counts", async () => {
    db.close();
    db = createDb(path.join(root, "openrig.sqlite"));
    migrate(db, ALL_MIGRATIONS);
    addSlice("alpha", "shipping", "shared");
    const states = ["pending", "in-progress", "done", "blocked", "failed", "denied", "canceled", "handed-off"];
    for (const state of states) row("selected-" + state, state, ["project:alpha", "mission:shipping", "slice:shared"]);
    row("other-project", "failed", ["project:beta", "mission:shipping", "slice:shared"]);
    // Several windows' worth of rows the count doesn't take.
    for (let i = 0; i < 600; i++) row(`noise-${i}`, "done", null, "x".repeat(200));
    const sql: string[] = [];
    const original = db.prepare;
    (db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => { sql.push(s); return original.call(db, s); };
    let entries: Entry[];
    try { entries = await list(route("alpha").app); } finally { (db as unknown as { prepare: typeof original }).prepare = original; }
    expect(entries[0]!.queueCounts).toEqual({ pending: 1, "in-progress": 1, done: 1, blocked: 1, failed: 1, denied: 1, canceled: 1, "handed-off": 1 });
    expect(sql.filter((statement) => statement.startsWith("SELECT state, tags FROM queue_items"))).toEqual([]);
  });

  it("counts the prefetched rows in chunks the event loop runs between, with the statement's counts", async () => {
    db.close();
    db = createDb(path.join(root, "openrig.sqlite"));
    migrate(db, ALL_MIGRATIONS);
    addSlice("alpha", "shipping", "shared");
    addSlice("alpha", "shipping", "other");
    const states = ["pending", "in-progress", "done", "blocked", "failed", "denied", "canceled", "handed-off"];
    for (let i = 0; i < 400; i++) row(`tagged-${i}`, states[i % 8]!, ["project:alpha", "mission:shipping", `slice:${i % 3 ? "shared" : "other"}`]);
    const { indexer } = route("alpha", true);
    const entries = indexer.list();
    const statement = indexer.observedQueueCounts(entries);
    let countRow: ((row: QueueCountRow) => void) | undefined;
    const deferred = indexer.observedQueueCounts(entries, undefined, { deferRows: (count) => { countRow = count; } });
    const rows = await indexer.readQueueCountRowsCooperatively();
    let turns = 0, stopped = false;
    const spin = () => { if (stopped) return; turns++; setImmediate(spin); };
    setImmediate(spin);
    await indexer.countQueueRowsCooperatively(rows!, countRow!, 0);
    stopped = true;
    expect(turns).toBeGreaterThan(1);
    expect([...deferred]).toEqual([...statement]);
    expect([...statement.values()].some((counts) => (counts?.done ?? 0) > 0)).toBe(true);
  });

  it.each([false, true])("counts all eight states only in the exact project/mission (explicit projectId=%s)", async explicit => {
    const dir = addSlice("alpha", "shipping", "shared", "shipped");
    addSlice("beta", "shipping", "shared");
    const states = ["pending", "in-progress", "done", "blocked", "failed", "denied", "canceled", "handed-off"];
    for (const state of states) row("selected-" + state, state, ["project:alpha", "mission:shipping", "slice:shared"]);
    row("other-project", "failed", ["project:beta", "mission:shipping", "slice:shared"]);
    row("other-mission-1", "done", ["project:alpha", "mission:support", "slice:shared"]);
    row("other-mission-2", "done", ["project:alpha", "mission:support", "slice:shared"]);
    const entries = await list(route("alpha", explicit).app);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: dir,
      status: "done", rawStatus: "shipped", qitemCount: explicit ? 10 : 11 });
    expect(entries[0]!.queueCounts).toEqual({
      pending: 1, "in-progress": 1, done: 1, blocked: 1, failed: 1, denied: 1, canceled: 1, "handed-off": 1,
    });
  });

  // Discovery deduplicates names before mission filtering. Each accessible root is tested separately.
  it.each([
    { mission: "shipping", expected: { ...ZERO, pending: 1, done: 2 } },
    { mission: "support", expected: { ...ZERO, blocked: 3, failed: 1 } },
  ])("keeps same-name rows in the other mission out of $mission counts", async ({ mission, expected }) => {
    addSlice("alpha", mission, "shared");
    row("ship-pending", "pending", ["project:alpha", "mission:shipping", "slice:shared"]);
    for (let i = 0; i < 2; i++) row("ship-done-" + i, "done", ["project:alpha", "mission:shipping", "slice:shared"]);
    for (let i = 0; i < 3; i++) row("support-block-" + i, "blocked", ["project:alpha", "mission:support", "slice:shared"]);
    row("support-failed", "failed", ["project:alpha", "mission:support", "slice:shared"]);
    const entries = await list(route().app);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: mission, qitemCount: 7 });
    expect(entries[0]!.queueCounts).toEqual(expected);
  });

  it("reports eight zeros for known empty and legacy-display-only scopes", async () => {
    addSlice("alpha", "shipping", "empty", "placeholder");
    addSlice("alpha", "shipping", "legacy-only", "parked-with-evidence");
    row("display-only", "blocked", null, "legacy-only notes");
    const entries = await list(route().app);
    expect(entries.map(s => [s.name, s.qitemCount]).sort()).toEqual([["empty", 0], ["legacy-only", 1]]);
    for (const entry of entries) expect.soft(entry.queueCounts, entry.name).toEqual(ZERO);
  });

  it("uses exact comma-aware tokens and counts duplicate tag spellings once per row", async () => {
    catalog([{ id: "alpha", root: "alpha" }]);
    addSlice("alpha", "shipping", "shared");
    row("duplicates", "pending", ["project:alpha", "project:alpha", "mission:shipping", "mission:shipping", "slice:shared", "slice:shared"]);
    row("comma-tokens", "done", [" project:alpha , mission:shipping , slice:shared "]);
    for (const [id, tags] of [
      ["slice-suffix", ["project:alpha", "mission:shipping", "slice:shared-extra"]],
      ["mission-suffix", ["project:alpha", "mission:shipping-extra", "slice:shared"]],
      ["project-suffix", ["project:alpha-extra", "mission:shipping", "slice:shared"]],
      ["slice-space", ["project:alpha", "mission:shipping", "slice: shared"]],
      ["slice-case", ["project:alpha", "mission:shipping", "slice:SHARED"]],
    ] as const) row(id, "failed", [...tags]);
    row("project-missing", "failed", ["mission:shipping", "slice:shared"]);
    row("mission-missing", "denied", ["project:alpha", "slice:shared"]);
    row("both-missing", "canceled", ["slice:shared"]);
    row("wrong-project", "blocked", ["project:beta", "mission:shipping", "slice:shared"]);
    row("wrong-mission", "handed-off", ["project:alpha", "mission:support", "slice:shared"]);
    row("substring-body", "failed", null, "shared shipping project:alpha");
    const entries = await list(route().app);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", status: "active", rawStatus: "active" });
    expect(entries[0]!.queueCounts).toEqual({ ...ZERO, pending: 1, done: 1, failed: 1, denied: 1, canceled: 1 });
  });

  it("does not assign a partially qualified row when the same mission and slice exist in two projects", async () => {
    catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
    const defaultMissionsRoot = addCatalogProject("default", ".");
    const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
    const defaultPath = addSlice(".", "shipping", "shared", "shipped");
    const fooPath = addSlice("projects/foo", "shipping", "shared", "active");
    configureCatalogRoute(fooMissionsRoot);
    row("foo-explicit", "pending", ["project:foo", "mission:shipping", "slice:shared"]);
    row("default-explicit", "done", ["project:default", "mission:shipping", "slice:shared"]);
    row("project-missing", "blocked", ["mission:shipping", "slice:shared"]);
    row("both-missing", "failed", ["slice:shared"]);

    // The same foo folder is also discovered as a flat root; it remains one physical candidate.
    const duplicatePathRoot = path.dirname(fooPath);
    const { app, indexer } = route("foo", false, fooMissionsRoot, [
      defaultMissionsRoot,
      duplicatePathRoot,
    ]);
    expect(indexer.projectId).toBeUndefined();
    const active = await list(app, "?filter=active");
    expect(defaultPath).not.toBe(fooPath);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: fooPath,
      status: "active", rawStatus: "active" });
    expect(active[0]!.queueCounts, "partial rows remain ambiguous across the hidden default-project physical slice")
      .toEqual({ ...ZERO, pending: 1 });
    expect(await list(app, "?filter=done")).toEqual([]);
    authoredUnchanged();
  });

  it("checks project-less rows against catalog missions roots beyond startup roots without changing the visible list", async () => {
    catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
    const defaultMissionsRoot = addCatalogProject("default", ".");
    const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
    const defaultPath = addSlice(".", "shipping", "shared", "shipped", "SLICE.DEFAULT");
    const fooPath = addSlice("projects/foo", "shipping", "shared", "active", "SLICE.FOO");
    configureCatalogRoute(defaultMissionsRoot);
    row("default-explicit", "done", ["project:default", "mission:shipping", "slice:shared"]);
    row("foo-explicit", "failed", ["project:foo", "mission:shipping", "slice:shared"]);
    row("project-missing", "blocked", ["mission:shipping", "slice:shared"]);

    // Match startup's default missions + workspace/slices roots. The catalog's
    // foo missions root is deliberately not configured on this indexer.
    const { app, indexer } = route("default", false, defaultMissionsRoot, [path.join(root, "slices")]);
    expect(indexer.additionalSliceRoots).toEqual([path.join(root, "slices")]);
    expect(indexer.additionalSliceRoots).not.toContain(fooMissionsRoot);
    expect(fooPath).not.toBe(defaultPath);
    const entries = await list(app);
    expect(entries.map((entry) => entry.slicePath)).toEqual([defaultPath]);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", rawStatus: "shipped", qitemCount: 3 });
    expect(entries[0]!.queueCounts, "the project-less row is ambiguous with the hidden foo physical slice")
      .toEqual({ ...ZERO, done: 1 });
    authoredUnchanged();
  });

  it("returns null queue counts when a catalog project cannot be resolved", async () => {
    catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
    const defaultMissionsRoot = addCatalogProject("default", ".");
    addCatalogProject("foo", "projects/foo");
    const defaultPath = addSlice(".", "shipping", "shared", "active");
    write(path.join(root, "projects/foo/project.yaml"), "id: [\n");
    configureCatalogRoute(defaultMissionsRoot);
    row("project-missing-unresolved-catalog", "blocked", ["mission:shipping", "slice:shared"]);

    const entries = await list(route("default", false, defaultMissionsRoot, [path.join(root, "slices")]).app);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ slicePath: defaultPath, qitemCount: 1 });
    expect(entries[0]!.queueCounts).toBeNull();
    authoredUnchanged();
  });

  it("returns null queue counts when a catalog missions root cannot be traversed", async () => {
    catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
    const defaultMissionsRoot = addCatalogProject("default", ".");
    const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
    const defaultPath = addSlice(".", "shipping", "shared", "active");
    write(fooMissionsRoot, "not a directory");
    configureCatalogRoute(defaultMissionsRoot);
    row("project-missing-unreadable-root", "blocked", ["mission:shipping", "slice:shared"]);

    const entries = await list(route("default", false, defaultMissionsRoot, [path.join(root, "slices")]).app);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ slicePath: defaultPath, qitemCount: 1 });
    expect(entries[0]!.queueCounts).toBeNull();
    authoredUnchanged();
  });

  it("does not assign a mission-less row when same-named slices exist in two missions", async () => {
    const shippingPath = addSlice("alpha", "shipping", "shared");
    const supportRoot = path.join(root, "alpha", "extra-missions");
    const supportPath = path.join(supportRoot, "support", "slices", "shared");
    write(path.join(supportRoot, "support", "SPEC.md"), "---\nid: M.SUPPORT\nstatus: active\n---\n# Support\n");
    write(path.join(supportPath, "SPEC.md"), "---\nid: shared\nstatus: active\n---\n# Shared support\n");
    row("shipping-explicit", "pending", ["project:alpha", "mission:shipping", "slice:shared"]);
    row("support-explicit", "done", ["project:alpha", "mission:support", "slice:shared"]);
    row("mission-missing", "blocked", ["project:alpha", "slice:shared"]);

    const primaryRoot = path.join(root, "alpha", "missions");
    const { app, indexer } = route("alpha", true, primaryRoot, [supportRoot]);
    expect(indexer.projectId).toBe("alpha");
    const entries = await list(app);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: shippingPath });
    expect(supportPath).not.toBe(shippingPath);
    expect(entries[0]!.queueCounts, "a mission-less row cannot choose the list's first same-name mission")
      .toEqual({ ...ZERO, pending: 1 });
    authoredUnchanged();
  });

  it("resolves unique directory and authored-id forms to one scope without multiplying rows", async () => {
    addSlice("alpha", "shipping", "shared", "active", "SLICE.SHARED");
    row("directory-form", "pending", ["project:alpha", "mission:shipping", "slice:shared"]);
    row("id-form", "done", ["project:alpha", "mission:shipping", "slice:SLICE.SHARED"]);
    row("mission-id-compat", "blocked", ["project:alpha", "mission:M.SHIPPING", "slice:SLICE.SHARED", "slice:SLICE.SHARED"]);
    const entries = await list(route().app);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", qitemCount: 3 });
    expect(entries[0]!.queueCounts).toEqual({ ...ZERO, pending: 1, done: 1, blocked: 1 });
  });

  it("uses each physical path's authored slice ID when a same-name candidate is hidden", async () => {
    const visiblePath = addSlice("alpha", "shipping", "shared", "active", "SLICE.ALPHA");
    const hiddenPath = addSlice("beta", "shipping", "shared", "active", "SLICE.BETA");
    row("visible-authored-id-only", "pending", ["slice:SLICE.ALPHA"]);

    const { app } = route("alpha", false, path.join(root, "alpha", "missions"), [path.join(root, "beta", "missions")]);
    const entries = await list(app);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: visiblePath });
    expect(entries[0]!.slicePath).not.toBe(hiddenPath);
    expect(entries[0]!.queueCounts).toEqual({ ...ZERO, pending: 1 });
    authoredUnchanged();
  });

  it.each([
    { first: "alpha", second: "beta" },
    { first: "beta", second: "alpha" },
  ] as const)("keeps authored mission aliases local to two visible roots ($first then $second)", async ({ first, second }) => {
    const alphaPath = addSlice("alpha", "shipping", "alpha-work");
    const betaPath = addSlice("beta", "shipping", "beta-work");
    const missionRoots = {
      alpha: path.join(root, "alpha", "missions"),
      beta: path.join(root, "beta", "missions"),
    };
    write(path.join(missionRoots.alpha, "shipping", "SPEC.md"), "---\nid: M.A\nstatus: active\n---\n# Alpha mission\n");
    write(path.join(missionRoots.beta, "shipping", "SPEC.md"), "---\nid: M.B\nstatus: active\n---\n# Beta mission\n");

    row("alpha-own-id", "pending", ["project:alpha", "mission:M.A", "slice:alpha-work"]);
    row("alpha-directory", "done", ["project:alpha", "mission:shipping", "slice:alpha-work"]);
    row("beta-own-id-a", "in-progress", ["project:beta", "mission:M.B", "slice:beta-work"]);
    row("beta-own-id-b", "in-progress", ["project:beta", "mission:M.B", "slice:beta-work"]);
    row("beta-directory", "blocked", ["project:beta", "mission:shipping", "slice:beta-work"]);
    for (let i = 0; i < 2; i++) {
      row("alpha-other-id-" + i, "failed", ["project:alpha", "mission:M.B", "slice:alpha-work"]);
    }
    for (let i = 0; i < 3; i++) {
      row("beta-other-id-" + i, "denied", ["project:beta", "mission:M.A", "slice:beta-work"]);
    }

    const { app, indexer } = route(first, false, missionRoots[first], [missionRoots[second]]);
    expect(indexer.projectId).toBeUndefined();
    const entries = await list(app);
    expect(entries.map(s => [s.name, s.missionId, s.slicePath]).sort()).toEqual([
      ["alpha-work", "shipping", alphaPath],
      ["beta-work", "shipping", betaPath],
    ]);
    authoredUnchanged();
    const alpha = entries.find(s => s.slicePath === alphaPath)!;
    const beta = entries.find(s => s.slicePath === betaPath)!;
    expect.soft(alpha.queueCounts, "alpha: own M.A plus directory form, never M.B").toEqual({
      pending: 1, "in-progress": 0, done: 1, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0,
    });
    expect.soft(beta.queueCounts, "beta: own M.B plus directory form, never M.A").toEqual({
      pending: 0, "in-progress": 2, done: 0, blocked: 1, failed: 0, denied: 0, canceled: 0, "handed-off": 0,
    });
  });

  it.each([
    { first: "primary", second: "extra" },
    { first: "extra", second: "primary" },
  ] as const)("rejects one authored mission ID shared across roots of one project ($first then $second)", async ({ first, second }) => {
    const shippingPath = addSlice("alpha", "shipping", "shipping-work");
    const roots = {
      primary: path.join(root, "alpha", "missions"),
      extra: path.join(root, "alpha", "extra-missions"),
    };
    write(path.join(roots.primary, "shipping", "SPEC.md"), "---\nid: M.SHARED\nstatus: active\n---\n# Shipping\n");
    write(path.join(roots.extra, "support", "SPEC.md"), "---\nid: M.SHARED\nstatus: active\n---\n# Support\n");
    const supportPath = path.join(roots.extra, "support", "slices", "support-work");
    write(path.join(supportPath, "SPEC.md"), "---\nid: support-work\nstatus: active\n---\n# Support work\n");
    row("shipping-directory", "done", ["project:alpha", "mission:shipping", "slice:shipping-work"]);
    row("support-directory", "blocked", ["project:alpha", "mission:support", "slice:support-work"]);
    for (let i = 0; i < 2; i++) {
      row("shipping-ambiguous-id-" + i, "failed", ["project:alpha", "mission:M.SHARED", "slice:shipping-work"]);
    }
    for (let i = 0; i < 3; i++) {
      row("support-ambiguous-id-" + i, "denied", ["project:alpha", "mission:M.SHARED", "slice:support-work"]);
    }

    const { app, indexer } = route("alpha", true, roots[first], [roots[second]]);
    expect(indexer.projectId).toBe("alpha");
    const entries = await list(app);
    expect(entries.map(s => [s.name, s.missionId, s.slicePath]).sort()).toEqual([
      ["shipping-work", "shipping", shippingPath],
      ["support-work", "support", supportPath],
    ]);
    authoredUnchanged();
    const shipping = entries.find(s => s.slicePath === shippingPath)!;
    const support = entries.find(s => s.slicePath === supportPath)!;
    expect.soft(shipping.queueCounts, "shipping: directory form only, shared ID is not unique").toEqual({
      pending: 0, "in-progress": 0, done: 1, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0,
    });
    expect.soft(support.queueCounts, "support: directory form only, shared ID is not unique").toEqual({
      pending: 0, "in-progress": 0, done: 0, blocked: 1, failed: 0, denied: 0, canceled: 0, "handed-off": 0,
    });
  });

  it("deduplicates configured and catalog counting roots by physical slice identity through a symlink", async () => {
    catalog([{ id: "default", root: "." }]);
    const defaultMissionsRoot = addCatalogProject("default", ".");
    const physicalPath = addSlice(".", "shipping", "shared", "shipped", "SLICE.SHARED");
    const aliasWorkspaceRoot = path.join(root, "workspace-alias");
    fs.symlinkSync(root, aliasWorkspaceRoot, "dir");
    const aliasMissionsRoot = path.join(aliasWorkspaceRoot, "missions");
    configureCatalogRoute(aliasMissionsRoot);
    row("symlink-qualified", "done", ["project:default", "mission:shipping", "slice:shared"]);

    // The configured root is reached through the symlink; the request's
    // catalog adds the same missions tree by its physical path.
    const { app } = route("default", false, aliasMissionsRoot, [path.join(root, "slices")]);
    const entries = await list(app);
    const visiblePath = path.join(aliasMissionsRoot, "shipping", "slices", "shared");
    expect(defaultMissionsRoot).toBe(path.join(root, "missions"));
    expect(visiblePath).not.toBe(physicalPath);
    expect(fs.realpathSync(visiblePath)).toBe(fs.realpathSync(physicalPath));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slicePath).toBe(visiblePath);
    expect(entries[0]!.queueCounts).toEqual({ ...ZERO, done: 1 });
    authoredUnchanged();
  });

  it("counts project-less authored mission aliases against catalog-only claims", async () => {
    catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
    const defaultMissionsRoot = addCatalogProject("default", ".");
    const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
    const defaultSharedPath = addSlice(".", "shipping", "shared", "shipped");
    const fooSharedPath = addSlice("projects/foo", "shipping", "shared", "active");
    write(path.join(defaultMissionsRoot, "shipping", "SPEC.md"), "---\nid: M.SHARED\nstatus: active\n---\n# Shipping\n");
    write(path.join(fooMissionsRoot, "shipping", "SPEC.md"), "---\nid: M.SHARED\nstatus: active\n---\n# Foo shipping\n");
    const uniqueControlPath = addSlice(".", "support", "alias-control", "active");
    write(path.join(defaultMissionsRoot, "support", "SPEC.md"), "---\nid: M.UNIQUE\nstatus: active\n---\n# Support\n");
    configureCatalogRoute(defaultMissionsRoot);
    row("shared-mission-id-partial", "blocked", ["mission:M.SHARED", "slice:shared"]);
    row("default-directory-control", "done", ["project:default", "mission:shipping", "slice:shared"]);
    row("unique-mission-id-control", "pending", ["project:default", "mission:M.UNIQUE", "slice:alias-control"]);

    // The catalog-only foo project contributes ambiguity but does not enter the list.
    const entries = await list(route("default", false, defaultMissionsRoot, [path.join(root, "slices")]).app);
    expect(fooSharedPath).not.toBe(defaultSharedPath);
    expect(entries.map((entry) => entry.slicePath).sort()).toEqual([defaultSharedPath, uniqueControlPath].sort());
    const defaultShared = entries.find((entry) => entry.slicePath === defaultSharedPath)!;
    const uniqueControl = entries.find((entry) => entry.slicePath === uniqueControlPath)!;
    expect(defaultShared.queueCounts, "the shared mission ID does not assign the project-less row to default")
      .toEqual({ ...ZERO, done: 1 });
    expect(uniqueControl.queueCounts, "a unique authored mission ID remains a valid counting alias")
      .toEqual({ ...ZERO, pending: 1 });
    authoredUnchanged();
  });

  it("counts beyond the existing 500-row display bucket without changing qitemCount", async () => {
    addSlice("alpha", "shipping", "busy");
    db.transaction(() => {
      for (let i = 0; i < 501; i++) row("bulk-" + i, "pending", ["project:alpha", "mission:shipping", "slice:busy"]);
    })();
    const entries = await list(route().app);
    expect(entries[0]).toMatchObject({ name: "busy", qitemCount: 500 });
    expect(entries[0]!.queueCounts).toEqual({ ...ZERO, pending: 501 });
  });

  it("reads real pending-to-claimed-to-done transitions through the same cached route without file edits", async () => {
    addSlice("alpha", "shipping", "changing", "shipped");
    const repo = new QueueRepository(db, new EventBus(db));
    const created = await repo.create({ qitemId: "qitem-count-transition", sourceSession: "writer@fixture",
      destinationSession: "worker@fixture", body: "work", tags: ["project:alpha", "mission:shipping", "slice:changing"], nudge: false });
    const { app } = route();
    const before = await list(app);
    expect(repo.claim({ qitemId: created.qitemId, destinationSession: "worker@fixture" }).state).toBe("in-progress");
    const claimed = await list(app);
    expect(repo.update({ qitemId: created.qitemId, actorSession: "worker@fixture", state: "done", closureReason: "no-follow-on" }).state).toBe("done");
    const done = await list(app);
    expect(repo.transitionLog.listForQitem(created.qitemId).map(t => t.state)).toEqual(["pending", "in-progress", "done"]);
    for (const entries of [before, claimed, done]) {
      expect(entries[0]).toMatchObject({ name: "changing", status: "done", rawStatus: "shipped", qitemCount: 1 });
    }
    authoredUnchanged();
    expect.soft(before[0]!.queueCounts, "initial pending").toEqual({ ...ZERO, pending: 1 });
    expect.soft(claimed[0]!.queueCounts, "same route after real claim").toEqual({ ...ZERO, "in-progress": 1 });
    expect.soft(done[0]!.queueCounts, "same route after real completion").toEqual({ ...ZERO, done: 1 });
    expect.soft(before[0]!.derivedState, "pending row, none claimed").toBe("pending");
    expect.soft(claimed[0]!.derivedState, "after real claim").toBe("in-progress");
    expect.soft(done[0]!.derivedState, "all matched rows closed: idle, not none").toBe("idle");
  });

  it("drops scrubbed and deleted rows from observed counts after an explicit list refresh", async () => {
    addSlice("alpha", "shipping", "shared");
    row("count-scrub", "done", ["project:alpha", "mission:shipping", "slice:shared"]);
    row("count-delete", "pending", ["project:alpha", "mission:shipping", "slice:shared"]);
    const { app } = route();
    const before = await list(app);
    expect(before[0]).toMatchObject({ name: "shared", qitemCount: 2 });
    expect(before[0]!.queueCounts).toEqual({ ...ZERO, pending: 1, done: 1 });

    const erased = await eraseQueue(db, { scope: { kind: "ids", entries: [
      { qitemId: "count-scrub", action: "scrub" }, { qitemId: "count-delete", action: "delete" },
    ] }, apply: true, nowIso: "2026-11-10T00:00:00.000Z" });
    expect(erased.complete).toBe(true);
    expect(erased.qitems.map(({ qitemId, action }) => [qitemId, action])).toEqual([
      ["count-delete", "delete"], ["count-scrub", "scrub"],
    ]);

    const after = await list(app, "?refresh=1");
    expect(after[0]).toMatchObject({ name: "shared", qitemCount: 0 });
    expect(after[0]!.queueCounts).toEqual(ZERO);
    expect(db.prepare("SELECT body, tags, content_erased_at FROM queue_items WHERE qitem_id = 'count-scrub'").get())
      .toMatchObject({ body: "", tags: null, content_erased_at: "2026-11-10T00:00:00.000Z" });
    expect(db.prepare("SELECT 1 FROM queue_items WHERE qitem_id = 'count-delete'").get()).toBeUndefined();
    authoredUnchanged();
  });

  it.each([
    {
      order: "default then foo",
      projects: [{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }],
    },
    {
      order: "foo then default",
      projects: [{ id: "foo", root: "projects/foo" }, { id: "default", root: "." }],
    },
  ])("counts a nested foo slice in either catalog order ($order)", async ({ projects }) => {
    catalog(projects);
    write(path.join(root, "SPEC.md"), "---\nid: default\n---\n# Default project\n");
    write(path.join(root, "project.yaml"), "id: default\nmissions:\n  root: missions\n");
    write(path.join(root, "projects/foo/SPEC.md"), "---\nid: foo\n---\n# Foo project\n");
    write(path.join(root, "projects/foo/project.yaml"), "id: foo\nmissions:\n  root: missions\n");
    const defaultSlicePath = addSlice(".", "shipping", "shared");
    const fooSlicePath = addSlice("projects/foo", "shipping", "shared");
    const fooMissionsRoot = path.join(root, "projects/foo/missions");
    const config = path.join(root, "settings.json");
    write(config, JSON.stringify({ workspace: { root, catalogPath: path.join(root, "workspace.yaml"), slicesRoot: fooMissionsRoot } }));
    settings = new SettingsStore(config);

    expect(defaultSlicePath).not.toBe(fooSlicePath);
    row("foo-pending", "pending", ["project:foo", "mission:shipping", "slice:shared"]);
    row("default-decoy-pending", "pending", ["project:default", "mission:shipping", "slice:shared"]);

    const { app, indexer } = route("foo", false, fooMissionsRoot);
    expect(indexer.projectId).toBeUndefined();
    const entries = await list(app);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: fooSlicePath, status: "active", rawStatus: "active" });
    authoredUnchanged();
    expect(entries[0]!.queueCounts, "the default project's same-name decoy must not inflate foo").toEqual({ ...ZERO, pending: 1 });
  });

  it("bounds real workspace catalog reads when many slices share one containing-root set", async () => {
    const names = ["nested-01", "nested-02", "nested-03", "nested-04", "nested-05"];
    catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
    addCatalogProject("default", ".");
    const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
    configureCatalogRoute(fooMissionsRoot);

    const addSameNameProjectPair = (name: string): void => {
      addSlice(".", "shipping", name);
      addSlice("projects/foo", "shipping", name);
      row(`foo-${name}`, "pending", ["project:foo", "mission:shipping", `slice:${name}`]);
      row(`default-${name}`, "failed", ["project:default", "mission:shipping", `slice:${name}`]);
    };
    addSameNameProjectPair(names[0]!);
    const { app, indexer } = route("foo", false, fooMissionsRoot, [path.join(root, "missions")]);
    expect(indexer.projectId).toBeUndefined();

    const small = await withCatalogReadCount(() => list(app));
    expect(small.result).toHaveLength(1);
    expect(small.result[0]).toMatchObject({ name: names[0], slicePath: path.join(fooMissionsRoot, "shipping", "slices", names[0]!) });
    expect(small.result[0]!.queueCounts).toEqual({ ...ZERO, pending: 1 });

    for (const name of names.slice(1)) addSameNameProjectPair(name);
    const many = await withCatalogReadCount(() => list(app, "?refresh=1"));
    expect(many.result.map((entry) => entry.name).sort()).toEqual([...names].sort());
    for (const name of names) {
      const entry = many.result.find((candidate) => candidate.name === name)!;
      expect(entry.slicePath).toBe(path.join(fooMissionsRoot, "shipping", "slices", name));
      expect(entry.queueCounts, `default project's same-name ${name} row is excluded`).toEqual({ ...ZERO, pending: 1 });
    }
    expect(small.reads).toBeGreaterThan(0);
    expect(many.reads, "catalog reads should stay bounded by the shared containing-root set, not slice count")
      .toBeLessThanOrEqual(small.reads + 1);
    authoredUnchanged();
  });

  it("does not reuse a selection across different containing-root sets in one request", async () => {
    const fooNames = ["a-foo-01", "b-foo-02"];
    const barNames = ["y-bar-01", "z-bar-02"];
    catalog([
      { id: "default", root: "." },
      { id: "foo", root: "projects/foo" },
      { id: "bar", root: "projects/bar" },
    ]);
    addCatalogProject("default", ".");
    const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
    const barMissionsRoot = addCatalogProject("bar", "projects/bar");
    configureCatalogRoute(fooMissionsRoot);

    for (const name of fooNames) {
      addSlice(".", "shipping", name);
      addSlice("projects/foo", "shipping", name);
      row(`foo-${name}`, "pending", ["project:foo", "mission:shipping", `slice:${name}`]);
      row(`default-${name}`, "failed", ["project:default", "mission:shipping", `slice:${name}`]);
    }
    for (const name of barNames) {
      addSlice(".", "shipping", name);
      addSlice("projects/bar", "shipping", name);
      row(`bar-${name}`, "done", ["project:bar", "mission:shipping", `slice:${name}`]);
      row(`default-${name}`, "blocked", ["project:default", "mission:shipping", `slice:${name}`]);
    }

    const { app, indexer } = route("foo", false, fooMissionsRoot, [barMissionsRoot]);
    expect(indexer.projectId).toBeUndefined();
    const entries = await list(app);
    expect(entries.map((entry) => entry.name).sort()).toEqual([...fooNames, ...barNames].sort());
    for (const name of fooNames) {
      const entry = entries.find((candidate) => candidate.name === name)!;
      expect(entry.slicePath).toBe(path.join(fooMissionsRoot, "shipping", "slices", name));
      expect(entry.queueCounts, `default project's same-name ${name} row is excluded`).toEqual({ ...ZERO, pending: 1 });
    }
    for (const name of barNames) {
      const entry = entries.find((candidate) => candidate.name === name)!;
      expect(entry.slicePath).toBe(path.join(barMissionsRoot, "shipping", "slices", name));
      expect(entry.queueCounts, `default project's same-name ${name} row is excluded`).toEqual({ ...ZERO, done: 1 });
    }
    authoredUnchanged();
  });

  it("uses the updated workspace catalog on the next HTTP request", async () => {
    catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
    addCatalogProject("default", ".");
    const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
    configureCatalogRoute(fooMissionsRoot);
    addSlice(".", "shipping", "shared");
    const fooSlicePath = addSlice("projects/foo", "shipping", "shared");
    row("old-project-row", "pending", ["project:foo", "mission:shipping", "slice:shared"]);
    row("new-project-row", "done", ["project:renamed", "mission:shipping", "slice:shared"]);
    row("default-decoy-row", "blocked", ["project:default", "mission:shipping", "slice:shared"]);

    const { app, indexer } = route("foo", false, fooMissionsRoot);
    expect(indexer.projectId).toBeUndefined();
    const first = await list(app);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: "shared", slicePath: fooSlicePath });
    expect(first[0]!.queueCounts).toEqual({ ...ZERO, pending: 1 });

    catalog([{ id: "default", root: "." }, { id: "renamed", root: "projects/foo" }]);
    addCatalogProject("renamed", "projects/foo");
    const second = await withCatalogReadCount(() => list(app));
    expect(second.reads).toBeGreaterThan(0);
    expect(second.result).toHaveLength(1);
    expect(second.result[0]).toMatchObject({ name: "shared", slicePath: fooSlicePath });
    expect(second.result[0]!.queueCounts, "the renamed project's row replaces the old owner on a fresh request")
      .toEqual({ ...ZERO, done: 1 });
    authoredUnchanged();
  });

  it.each(["unidentified root", "ambiguous project root"])("reports null rather than observed zero for %s", async reason => {
    let slicesRoot: string;
    if (reason === "unidentified root") {
      slicesRoot = path.join(root, "legacy");
      write(path.join(slicesRoot, "loose", "SPEC.md"), "---\nstatus: active\n---\n# Legacy\n");
    } else {
      addSlice("alpha", "shipping", "shared");
      catalog([{ id: "alpha", root: "alpha" }, { id: "shadow", root: "alpha" }]);
      slicesRoot = path.join(root, "alpha", "missions");
    }
    const { app } = route("alpha", false, slicesRoot);
    const entries = await list(app);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.qitemCount).toBe(0);
    expect(entries[0]!.queueCounts).toBeNull();
    expect(entries[0]!.derivedState, "counts that cannot be read are unknown, never idle or none").toBe("unknown");
    expect((await list(app, "?derived=unknown")).map(s => s.name)).toEqual([entries[0]!.name]);
    for (const state of ["idle", "none"]) expect(await list(app, "?derived=" + state), state).toEqual([]);
  });

  it("uses bounded batched queue scans for both one slice and many slices", async () => {
    addSlice("alpha", "shipping", "batch-00");
    row("batch-row-00", "pending", ["project:alpha", "mission:shipping", "slice:batch-00"]);
    let scans = 0;
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const stmt = prepare(sql);
      const scan = /\bfrom\s+queue_items\b/i.test(sql) && !/\bwhere\s+qitem_id\s*(?:in\b|=)/i.test(sql);
      if (!scan) return stmt;
      return new Proxy(stmt, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "all" || key === "iterate" || key === "get") scans++;
          return value.apply(target, args);
        };
      } });
    }) as typeof db.prepare);
    try {
      const small = await list(route().app);
      const smallScans = scans;
      for (let i = 1; i < 24; i++) {
        const name = "batch-" + String(i).padStart(2, "0");
        addSlice("alpha", "shipping", name);
        row("batch-row-" + i, "pending", ["project:alpha", "mission:shipping", "slice:" + name]);
      }
      scans = 0;
      const many = await list(route().app);
      const manyScans = scans;
      expect(small).toHaveLength(1);
      expect(many).toHaveLength(24);
      expect(smallScans).toBeGreaterThan(0);
      expect(smallScans).toBeLessThanOrEqual(4);
      expect(manyScans).toBeGreaterThan(0);
      expect(manyScans).toBeLessThanOrEqual(4);
      expect(manyScans).toBeLessThanOrEqual(smallScans + 1);
      expect(small.map(s => s.queueCounts)).toEqual([{ ...ZERO, pending: 1 }]);
      expect(many.map(s => s.queueCounts)).toEqual(Array.from({ length: 24 }, () => ({ ...ZERO, pending: 1 })));
    } finally { spy.mockRestore(); }
  });

  describe("#2729 queue-derived state beside the authored status", () => {
    const scope = (name: string) => ["project:alpha", "mission:shipping", "slice:" + name];
    const derivedByName = (entries: Entry[]) => Object.fromEntries(entries.map(s => [s.name, s.derivedState]));

    it.each([
      { label: "blocked wins over in-progress, pending and closed rows", states: ["pending", "in-progress", "blocked", "done"], expected: "blocked" },
      { label: "in-progress wins over pending", states: ["pending", "pending", "in-progress"], expected: "in-progress" },
      { label: "pending wins over closed rows", states: ["done", "pending", "handed-off"], expected: "pending" },
      { label: "only done rows: matched rows, none open", states: ["done", "done"], expected: "idle" },
      { label: "only handed-off rows: matched rows, none open", states: ["handed-off"], expected: "idle" },
      { label: "failed, denied and canceled rows are not open", states: ["failed", "denied", "canceled"], expected: "idle" },
      { label: "no matched rows", states: [] as string[], expected: "none" },
    ])("reports $expected: $label", async ({ states, expected }) => {
      addSlice("alpha", "shipping", "target");
      addSlice("alpha", "shipping", "decoy");
      states.forEach((state, i) => row("target-row-" + i, state, scope("target")));
      row("decoy-row", "blocked", scope("decoy"));
      const entries = await list(route().app);
      expect(derivedByName(entries)).toEqual({ target: expected, decoy: "blocked" });
    });

    it("leaves status and rawStatus authored while the derived state follows the rows", async () => {
      addSlice("alpha", "shipping", "started-late", "placeholder");
      addSlice("alpha", "shipping", "all-closed", "placeholder");
      addSlice("alpha", "shipping", "never-started", "placeholder");
      for (const [i, state] of ["blocked", "handed-off", "handed-off", "handed-off"].entries()) row("late-" + i, state, scope("started-late"));
      for (const [i, state] of ["done", "done", "handed-off"].entries()) row("closed-" + i, state, scope("all-closed"));
      const { app } = route();
      const entries = await list(app);
      for (const entry of entries) expect(entry, entry.name).toMatchObject({ status: "draft", rawStatus: "placeholder" });
      expect(derivedByName(entries)).toEqual({ "started-late": "blocked", "all-closed": "idle", "never-started": "none" });
      expect((await list(app, "?filter=blocked")).map(s => s.name), "the authored blocked filter does not see queue rows").toEqual([]);
      expect((await list(app, "?derived=blocked")).map(s => s.name)).toEqual(["started-late"]);
    });

    it("filters by derived state, case-insensitively, and narrows the authored status filter", async () => {
      addSlice("alpha", "shipping", "stuck", "active");
      addSlice("alpha", "shipping", "moving", "active");
      addSlice("alpha", "shipping", "waiting", "active");
      addSlice("alpha", "shipping", "closed", "active");
      addSlice("alpha", "shipping", "empty", "active");
      addSlice("alpha", "shipping", "parked", "parked-with-evidence");
      row("stuck-0", "blocked", scope("stuck"));
      row("moving-0", "in-progress", scope("moving"));
      row("waiting-0", "pending", scope("waiting"));
      row("closed-0", "done", scope("closed"));
      row("parked-0", "blocked", scope("parked"));
      const { app } = route();
      const names = async (query: string) => (await list(app, query)).map(s => s.name).sort();
      expect(await names("?derived=blocked")).toEqual(["parked", "stuck"]);
      expect(await names("?derived=BLOCKED")).toEqual(["parked", "stuck"]);
      expect(await names("?derived=in-progress")).toEqual(["moving"]);
      expect(await names("?derived=pending")).toEqual(["waiting"]);
      expect(await names("?derived=idle")).toEqual(["closed"]);
      expect(await names("?derived=none")).toEqual(["empty"]);
      expect(await names("?derived=unknown"), "every row here is readable").toEqual([]);
      expect(await names("?filter=active&derived=blocked")).toEqual(["stuck"]);
      expect(await names("?filter=blocked&derived=blocked")).toEqual(["parked"]);
      expect(await names("?filter=done&derived=blocked")).toEqual([]);
    });

    it("rejects an unknown derived state with 400 and names every allowed value", async () => {
      addSlice("alpha", "shipping", "any");
      const { app } = route();
      for (const query of ["?derived=open", "?derived="]) {
        const response = await app.request("/api/slices" + query);
        expect(response.status, query).toBe(400);
        const body = await response.json() as { error: string; hint: string };
        expect(body.error).toBe("derived_invalid");
        for (const state of ["blocked", "in-progress", "pending", "idle", "none", "unknown"]) expect(body.hint).toContain(state);
      }
    });

    it("returns absolute slice paths when a root is configured with a relative spelling", async () => {
      // The legacy OPENRIG_SLICES_ROOT string reaches the indexer as written. A relative slicePath would mean a
      // different slice to a client that resolves it from another working directory.
      const alphaDir = addSlice("alpha", "shipping", "rel-a");
      const betaDir = addSlice("beta", "shipping", "rel-b");
      const relativeAlpha = path.relative(process.cwd(), path.join(root, "alpha", "missions"));
      const relativeBeta = path.relative(process.cwd(), path.join(root, "beta", "missions"));
      expect([relativeAlpha, relativeBeta].map(p => path.isAbsolute(p))).toEqual([false, false]);
      const entries = await list(route("alpha", false, relativeAlpha, [relativeBeta]).app);
      expect(entries.map(s => s.slicePath).sort()).toEqual([alphaDir, betaDir].sort());
      for (const entry of entries) expect(path.isAbsolute(entry.slicePath), entry.slicePath).toBe(true);
    });

    describe("a configured root with a symlink followed by a parent component", () => {
      // The kernel applies `..` to the directory the link points at; `path.resolve` drops it from the text first.
      //   <root>/beta/link -> <root>/alpha/sub        (the link's target)
      //   <root>/beta/link/../missions  names  <root>/alpha/missions   (physical, holds "physical-slice")
      //   the same text collapsed        names  <root>/beta/missions    (a different directory, holds "lexical-slice")
      let physicalDir: string;
      const configured = () => `${root}/beta/link/../missions`;

      beforeEach(() => {
        physicalDir = addSlice("alpha", "shipping", "physical-slice");
        addSlice("beta", "shipping", "lexical-slice");
        fs.mkdirSync(path.join(root, "alpha", "sub"), { recursive: true });
        fs.symlinkSync(path.join(root, "alpha", "sub"), path.join(root, "beta", "link"));
        fs.writeFileSync(path.join(root, "alpha", "missions", "MARKER-PHYSICAL.txt"), "");
        // Node's own fs.realpathSync collapses `..` as text first; the native call and the kernel's readdir do not.
        expect(fs.realpathSync.native(configured()), "the fixture must make the two readings differ").toBe(path.join(root, "alpha", "missions"));
        expect(fs.readdirSync(configured()), "the kernel reads the physical root").toContain("MARKER-PHYSICAL.txt");
        expect(fs.readdirSync(path.resolve(configured())), "the text-collapsed root is another directory").not.toContain("MARKER-PHYSICAL.txt");
        expect(path.resolve(configured())).toBe(path.join(root, "beta", "missions"));
      });

      it("walks, publishes and reports the physical root, not the text-collapsed one", async () => {
        const { app, indexer } = route("alpha", false, configured());
        const entries = await list(app);
        expect(entries.map(s => [s.name, s.slicePath])).toEqual([["physical-slice", physicalDir]]);
        expect(indexer.slicesRoot, "every consumer of the root field sees the same identity").toBe(path.join(root, "alpha", "missions"));
      });

      it("uses the current root for the refreshed list and its readiness", async () => {
        addSlice("beta", "retargeted-mission", "retargeted-slice");
        const { app, indexer } = route("alpha", false, configured());
        const link = path.join(root, "beta", "link");
        fs.mkdirSync(path.join(root, "beta", "sub"), { recursive: true });
        fs.rmSync(link);
        fs.symlinkSync(path.join(root, "beta", "sub"), link, "dir");

        const refreshed = await app.request("/api/slices/refresh", { method: "POST" });
        expect(refreshed.status).toBe(200);
        const response = await app.request("/api/slices");
        expect(response.status).toBe(200);
        const body = await response.json() as { slices: Entry[]; missions: Record<string, { readiness?: unknown }> };
        expect(body.slices.map((slice) => slice.name).sort()).toEqual(["lexical-slice", "retargeted-slice"]);
        expect(body.missions["retargeted-mission"]?.readiness).toBeDefined();
        expect(indexer.slicesRoot).toBe(path.join(root, "beta", "missions"));
      });

      it("resolves a root that was missing at startup after the target is created", async () => {
        const missingConfigured = `${root}/beta/link/../later-missions`;
        const { app, indexer } = route("alpha", false, missingConfigured);
        const missing = await app.request("/api/slices");
        expect(missing.status).toBe(503);

        const missionRoot = path.join(root, "alpha", "later-missions", "created-mission");
        write(path.join(missionRoot, "SPEC.md"), nodeBytes("M.CREATED", "active", "Mission"));
        write(path.join(missionRoot, "slices", "created-slice", "SPEC.md"), nodeBytes("OPR.CREATED", "active", "Slice"));
        const refreshed = await app.request("/api/slices/refresh", { method: "POST" });
        expect(refreshed.status).toBe(200);
        const response = await app.request("/api/slices");
        expect(response.status).toBe(200);
        const body = await response.json() as { slices: Entry[]; missions: Record<string, { readiness?: unknown }> };
        expect(body.slices.map((slice) => slice.name)).toEqual(["created-slice"]);
        expect(body.missions["created-mission"]?.readiness).toBeDefined();
        expect(indexer.slicesRoot).toBe(path.join(root, "alpha", "later-missions"));
      });

      it("keeps the physical identity for an additional root and does not list the collapsed sibling", async () => {
        const { app } = route("alpha", false, path.join(root, "alpha", "missions"), [configured()]);
        const entries = await list(app);
        expect(entries.map(s => s.name)).toEqual(["physical-slice"]);
      });

      it("preserves the missing-root outcome instead of falling back to the collapsed sibling", async () => {
        // <root>/alpha/nothing does not exist; <root>/beta/nothing does, with a slice folder, and is where a
        // collapsed reading would look.
        fs.mkdirSync(path.join(root, "beta", "nothing", "shipping", "slices", "decoy"), { recursive: true });
        const response = await route("alpha", false, `${root}/beta/link/../nothing`).app.request("/api/slices");
        expect(response.status, "a missing root is not ready, as before").toBe(503);
        expect(await response.json()).toMatchObject({ error: "slices_root_not_configured" });
      });

      it("uses native realpath for count keys and mission aliases when a symlinked root target contains ..", async () => {
        const currentAlias = path.join(root, "current");
        fs.symlinkSync(configured(), currentAlias, "dir");
        expect(fs.realpathSync.native(currentAlias)).toBe(path.join(root, "alpha", "missions"));

        // Mirror physical-slice in Beta first so every listed path exists in Beta too and exposes the Beta count collision.
        addSlice("beta", "shipping", "physical-slice");
        addSlice("alpha", "release-train", "01-release", "active", "SLICE.ALPHA.RELEASE", { missionId: "M.ALPHA.RELEASE" });
        addSlice("beta", "release-train", "01-release", "active", "SLICE.BETA.RELEASE", { missionId: "M.BETA.RELEASE" });
        row("beta-blocked", "blocked", ["project:beta", "mission:release-train", "slice:01-release"]);
        row("alpha-mission-id", "pending", ["project:alpha", "mission:M.ALPHA.RELEASE", "slice:01-release"]);

        const aliasSlicePath = path.join(currentAlias, "release-train", "slices", "01-release");
        const { app: implicitApp } = route("alpha", false, currentAlias);
        const implicitEntries = await list(implicitApp);
        expect.soft(implicitEntries.find((s) => s.name === "01-release")).toMatchObject({
          slicePath: aliasSlicePath,
          status: "active",
          queueCounts: { ...ZERO, pending: 1 },
          derivedState: "pending",
        });
        expect.soft((await list(implicitApp, "?derived=blocked")).map((s) => s.name)).toEqual([]);
        expect.soft((await list(implicitApp, "?derived=pending")).map((s) => s.name)).toEqual(["01-release"]);

        // Also cover an explicit project-scoped indexer where Alpha is configured only via the symlink alias.
        catalog([{ id: "beta", root: "beta" }]);
        const { app: explicitApp } = route("alpha", true, currentAlias);
        const explicitEntries = await list(explicitApp);
        expect.soft(explicitEntries.find((s) => s.name === "01-release")).toMatchObject({
          slicePath: aliasSlicePath,
          status: "active",
          queueCounts: { ...ZERO, pending: 1 },
          derivedState: "pending",
        });
        expect.soft((await list(explicitApp, "?derived=blocked")).map((s) => s.name)).toEqual([]);
        expect.soft((await list(explicitApp, "?derived=pending")).map((s) => s.name)).toEqual(["01-release"]);

        // An Alpha-only slice absent from Beta must also keep counts readable rather than failing lexical realpath.
        catalog([{ id: "alpha", root: "alpha" }, { id: "beta", root: "beta" }]);
        addSlice("alpha", "release-train", "02-alpha-only", "active", "SLICE.ALPHA.ONLY", { missionId: "M.ALPHA.RELEASE" });
        const afterAlphaOnly = await list(implicitApp, "?refresh=1");
        expect.soft(afterAlphaOnly.find((s) => s.name === "01-release")?.derivedState).toBe("pending");
        expect.soft(afterAlphaOnly.find((s) => s.name === "02-alpha-only")?.derivedState).toBe("none");
      });

      it("does not assign explicit project ownership to an unresolved root and shares native realpath resolution with catalog roots", async () => {
        const alphaExtra = path.join(root, "alpha-extra-missions");
        write(path.join(alphaExtra, "shipping", "SPEC.md"), nodeBytes("M.ALPHA.SHIP", "active", "Mission"));
        write(path.join(alphaExtra, "shipping", "slices", "01-release", "SPEC.md"), nodeBytes("SLICE.ALPHA.REL", "active", "Slice"));
        addSlice("beta", "shipping", "01-release", "active", "SLICE.BETA.REL", { missionId: "M.BETA.SHIP" });

        row("alpha-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-release"]);
        row("beta-pending", "pending", ["project:beta", "mission:shipping", "slice:01-release"]);

        const unresolvedRoot = `${path.join(root, "beta")}${path.sep}missing-link${path.sep}..${path.sep}missions`;
        expect(fs.existsSync(unresolvedRoot)).toBe(false);
        expect(path.resolve(unresolvedRoot)).toBe(path.join(root, "beta", "missions"));

        const danglingLink = path.join(root, "beta", "dangling-link");
        fs.symlinkSync(path.join(root, "nonexistent-target"), danglingLink, "dir");
        const danglingUnresolvedRoot = `${danglingLink}${path.sep}..${path.sep}missions`;
        expect(fs.existsSync(danglingUnresolvedRoot)).toBe(false);
        expect(path.resolve(danglingUnresolvedRoot)).toBe(path.join(root, "beta", "missions"));

        // Missing-component additional root must not claim Beta's lexical sibling as Alpha.
        const { app: extraMissingApp } = route("alpha", true, alphaExtra, [unresolvedRoot]);
        const extraMissingSlices = await list(extraMissingApp);
        expect(extraMissingSlices.find((s) => s.name === "01-release")).toMatchObject({
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect((await list(extraMissingApp, "?derived=blocked")).map((s) => s.name)).toEqual(["01-release"]);

        // Dangling-symlink additional root must not claim Beta's lexical sibling either.
        const { app: danglingExtraApp } = route("alpha", true, alphaExtra, [danglingUnresolvedRoot]);
        const danglingExtraSlices = await list(danglingExtraApp);
        expect(danglingExtraSlices.find((s) => s.name === "01-release")).toMatchObject({
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect((await list(danglingExtraApp, "?derived=blocked")).map((s) => s.name)).toEqual(["01-release"]);

        // Positive control: a valid symlink root outside the catalog still grants explicit project ownership to its target.
        const validLink = path.join(root, "alpha-extra-link");
        fs.symlinkSync(alphaExtra, validLink, "dir");
        // Include a valid catalog project without a missions directory yet (ENOENT) to ensure it does not void counts.
        const gammaRoot = path.join(root, "gamma");
        write(path.join(gammaRoot, "SPEC.md"), nodeBytes("P.GAMMA", "active", "Gamma"));
        catalog([{ id: "beta", root: "beta" }, { id: "gamma", root: "gamma" }]);
        const { app: validLinkApp } = route("alpha", true, validLink);
        const validLinkSlices = await list(validLinkApp);
        expect(validLinkSlices.find((s) => s.name === "01-release")).toMatchObject({
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect((await list(validLinkApp, "?derived=blocked")).map((s) => s.name)).toEqual(["01-release"]);

        // Shared catalog root helper: a non-ENOENT native realpath failure on a catalog root must fail closed to unknown
        // instead of falling back to path.resolve.
        const origNative = fs.realpathSync.native;
        let catalogFaultHits = 0;
        const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, options?: fs.EncodingOption) => {
          if (String(p) === gammaRoot) {
            catalogFaultHits++;
            throw Object.assign(new Error("injected catalog root EACCES"), { code: "EACCES" });
          }
          return origNative(p, options as never);
        }) as typeof fs.realpathSync.native);
        try {
          const afterCatalogError = await list(validLinkApp);
          expect(catalogFaultHits).toBeGreaterThan(0);
          expect(afterCatalogError.find((s) => s.name === "01-release")).toMatchObject({
            queueCounts: null,
            derivedState: "unknown",
          });
          expect((await list(validLinkApp, "?derived=blocked")).map((s) => s.name)).toEqual([]);
          expect((await list(validLinkApp, "?derived=unknown")).map((s) => s.name)).toEqual(["01-release"]);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it("invalidates a warm listing when a configured symlink root changes target without refresh", async () => {
      const oldRoot = path.join(root, "old-missions");
      const newRoot = path.join(root, "new-missions");
      const alias = path.join(root, "alpha", "missions-alias");
      const addMission = (missionsRoot: string, mission: string, slice: string, id: string) => {
        write(path.join(missionsRoot, mission, "SPEC.md"), nodeBytes(`M.${id}`, "active", "Mission"));
        write(path.join(missionsRoot, mission, "slices", slice, "SPEC.md"), nodeBytes(`OPR.${id}`, "active", "Slice"));
      };
      addMission(oldRoot, "old-mission", "old-slice", "OLD");
      addMission(newRoot, "new-mission", "new-slice", "NEW");
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(oldRoot, alias, "dir");
      const { app } = route("alpha", false, alias);

      const first = await app.request("/api/slices");
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { slices: Entry[]; missions: Record<string, { readiness?: unknown }> };
      expect(firstBody.slices.map(slice => slice.name)).toEqual(["old-slice"]);
      expect(firstBody.missions["old-mission"]?.readiness).toBeDefined();

      fs.rmSync(alias);
      fs.symlinkSync(newRoot, alias, "dir");
      const second = await app.request("/api/slices");
      expect(second.status).toBe(200);
      const secondBody = await second.json() as { slices: Entry[]; missions: Record<string, { readiness?: unknown }> };
      expect(secondBody.missions["new-mission"]?.readiness).toBeDefined();
      expect(secondBody.slices.map(slice => slice.name)).toEqual(["new-slice"]);
      expect(secondBody.missions["old-mission"]).toBeUndefined();
    });

    it("keeps list readiness bound to the captured native realpath when a symlink root retargets before readiness completes", async () => {
      const oldRoot = path.join(root, "old-readiness-missions");
      const newRoot = path.join(root, "new-readiness-missions");
      const alias = path.join(root, "alpha", "readiness-alias");
      write(path.join(oldRoot, "shipping", "SPEC.md"), nodeBytes("M.OLD", "active", "Old Mission"));
      write(path.join(oldRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.OLD\n  status: active\n");
      write(path.join(oldRoot, "shipping", "slices", "01-old", "SPEC.md"), nodeBytes("OPR.OLD", "active", "Old Slice"));

      write(path.join(newRoot, "shipping", "SPEC.md"), nodeBytes("M.NEW", "closed", "New Mission"));
      write(path.join(newRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.NEW\n  status: closed\n");
      write(path.join(newRoot, "shipping", "slices", "01-new", "SPEC.md"), nodeBytes("OPR.NEW", "closed", "New Slice"));

      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(oldRoot, alias, "dir");
      const { app } = route("alpha", false, alias);

      // Start the request; the synchronous withResolvedRoots listing and initial readdirSync
      // complete before readProjectReadinessAsync yields with setImmediate.
      const pending = app.request("/api/slices");
      fs.rmSync(alias);
      fs.symlinkSync(newRoot, alias, "dir");

      const first = await pending;
      expect(first.status).toBe(200);
      const firstBody = await first.json() as {
        slices: Entry[];
        missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
      };
      expect(firstBody.slices.map((s) => s.name)).toEqual(["01-old"]);
      expect(firstBody.missions["shipping"]?.authoredStatus).toBe("active");
      expect(firstBody.missions["shipping"]?.readiness?.historicalStatus).toBe("active");

      // A subsequent request observes the retargeted alias for both slices and readiness.
      const second = await app.request("/api/slices");
      expect(second.status).toBe(200);
      const secondBody = await second.json() as {
        slices: Entry[];
        missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
      };
      expect(secondBody.slices.map((s) => s.name)).toEqual(["01-new"]);
      expect(secondBody.missions["shipping"]?.authoredStatus).toBe("closed");
      expect(secondBody.missions["shipping"]?.readiness?.historicalStatus).toBe("closed");
    });

    it("keeps the whole list operation bound to the captured physical root when a symlink root retargets before the walk", async () => {
      const oldRoot = path.join(root, "alpha", "missions");
      const newRoot = path.join(root, "beta", "missions");
      const alias = path.join(root, "current-walk-alias");

      write(path.join(oldRoot, "shipping", "SPEC.md"), nodeBytes("M.OLD", "active", "Old Mission"));
      write(
        path.join(oldRoot, "shipping", "mission.yaml"),
        "metadata:\n  id: M.OLD\n  status: active\nproofPolicy:\n  judges:\n    - judge@old\n",
      );
      write(
        path.join(oldRoot, "shipping", "slices", "01-old", "SPEC.md"),
        `${nodeBytes("OPR.OLD", "active", "Old Slice")}\n## Proof contract\n- [ ] Old outcome.\n`,
      );
      write(
        path.join(oldRoot, "child-old", "SPEC.md"),
        "---\nid: M.CHILD.OLD\nstatus: active\nparent: OPR.OLD\n---\n# Child Old\n",
      );
      fs.mkdirSync(path.join(oldRoot, "child-old", "slices"), { recursive: true });

      write(path.join(newRoot, "shipping", "SPEC.md"), nodeBytes("M.NEW", "closed", "New Mission"));
      write(
        path.join(newRoot, "shipping", "mission.yaml"),
        "metadata:\n  id: M.NEW\n  status: closed\nproofPolicy:\n  judges:\n    - judge@new\n",
      );
      write(
        path.join(newRoot, "shipping", "slices", "01-old", "SPEC.md"),
        `${nodeBytes("OPR.NEW.SHARED", "closed", "New Collision Slice")}\n## Proof contract\n- [ ] New collision outcome.\n`,
      );
      write(
        path.join(newRoot, "shipping", "slices", "02-new", "SPEC.md"),
        `${nodeBytes("OPR.NEW", "closed", "New Slice")}\n## Proof contract\n- [ ] New outcome.\n`,
      );
      write(
        path.join(newRoot, "child-new", "SPEC.md"),
        "---\nid: M.CHILD.NEW\nstatus: active\nparent: OPR.NEW.SHARED\n---\n# Child New\n",
      );
      fs.mkdirSync(path.join(newRoot, "child-new", "slices"), { recursive: true });

      row("old-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-old"]);
      row("new-shared-pending", "pending", ["project:beta", "mission:shipping", "slice:01-old"]);
      row("new-only-pending", "pending", ["project:beta", "mission:shipping", "slice:02-new"]);

      fs.symlinkSync(oldRoot, alias, "dir");
      const { app, indexer } = route("alpha", false, alias);

      type DetailedEntry = Entry & {
        childMissions?: Array<{ id: string | null }>;
        readiness?: { policy?: { judges?: string[] } | null };
      };
      type DetailedBody = {
        slices: DetailedEntry[];
        missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
      };

      const origIsReady = indexer.isReady.bind(indexer);
      let retargetBeforeWalk = true;
      const readySpy = vi.spyOn(indexer, "isReady").mockImplementation(() => {
        if (retargetBeforeWalk) {
          retargetBeforeWalk = false;
          fs.rmSync(alias);
          fs.symlinkSync(newRoot, alias, "dir");
        }
        return origIsReady();
      });
      try {
        // Request 1: retarget happens inside withResolvedRoots AFTER capture and BEFORE the uncached walk.
        const first = await app.request("/api/slices");
        expect(first.status).toBe(200);
        const firstBody = await first.json() as DetailedBody;
        expect(firstBody.slices.map((s) => s.name)).toEqual(["01-old"]);
        expect(firstBody.slices[0]).toMatchObject({
          name: "01-old",
          slicePath: path.join(alias, "shipping", "slices", "01-old"),
          status: "active",
          rawStatus: "active",
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
          readiness: { policy: { judges: ["judge@old"] } },
        });
        expect(firstBody.slices[0]?.childMissions).toMatchObject([{ id: "M.CHILD.OLD" }]);
        expect(firstBody.missions["shipping"]?.authoredStatus).toBe("active");
        expect(firstBody.missions["shipping"]?.readiness?.historicalStatus).toBe("active");

        // Request 2: subsequent request observes the retargeted alias coherently across list, counts, and readiness.
        const second = await app.request("/api/slices");
        expect(second.status).toBe(200);
        const secondBody = await second.json() as DetailedBody;
        expect(secondBody.slices.map((s) => s.name)).toEqual(["01-old", "02-new"]);
        expect(secondBody.slices.find((s) => s.name === "01-old")).toMatchObject({
          slicePath: path.join(alias, "shipping", "slices", "01-old"),
          rawStatus: "closed",
          queueCounts: { ...ZERO, pending: 1 },
          derivedState: "pending",
          readiness: { policy: { judges: ["judge@new"] } },
        });
        expect(secondBody.slices.find((s) => s.name === "01-old")?.childMissions).toMatchObject([{ id: "M.CHILD.NEW" }]);
        expect(secondBody.slices.find((s) => s.name === "02-new")).toMatchObject({
          slicePath: path.join(alias, "shipping", "slices", "02-new"),
          queueCounts: { ...ZERO, pending: 1 },
          derivedState: "pending",
        });
        expect(secondBody.missions["shipping"]?.authoredStatus).toBe("closed");
        expect(secondBody.missions["shipping"]?.readiness?.historicalStatus).toBe("closed");

        // Repeat with ?derived=blocked&refresh=1 from the same pre-walk retarget starting state.
        fs.rmSync(alias);
        fs.symlinkSync(oldRoot, alias, "dir");
        retargetBeforeWalk = true;
        const filteredFirst = await list(app, "?derived=blocked&refresh=1");
        expect(filteredFirst).toHaveLength(1);
        expect(filteredFirst[0]).toMatchObject({
          name: "01-old",
          slicePath: path.join(alias, "shipping", "slices", "01-old"),
          derivedState: "blocked",
        });
        expect((await list(app, "?derived=pending")).map((s) => s.name)).toEqual(["01-old", "02-new"]);
      } finally {
        readySpy.mockRestore();
      }
    });

    it("keeps explicit project ownership and reads bound to the captured physical root when a symlink root retargets or unlinks before the walk", async () => {
      const externalOldRoot = path.join(root, "alpha-external-old-missions");
      const betaRoot = path.join(root, "beta", "missions");
      const alias = path.join(root, "explicit-walk-alias");

      write(path.join(externalOldRoot, "shipping", "SPEC.md"), nodeBytes("M.EXT.OLD", "active", "External Old Mission"));
      write(path.join(externalOldRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.EXT.OLD\n  status: active\n");
      write(
        path.join(externalOldRoot, "shipping", "slices", "01-ext", "SPEC.md"),
        nodeBytes("OPR.EXT.OLD", "active", "External Old Slice"),
      );

      write(path.join(betaRoot, "shipping", "SPEC.md"), nodeBytes("M.BETA", "closed", "Beta Mission"));
      write(path.join(betaRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.BETA\n  status: closed\n");
      write(path.join(betaRoot, "shipping", "slices", "01-ext", "SPEC.md"), nodeBytes("OPR.BETA.1", "closed", "Beta Slice 1"));
      write(path.join(betaRoot, "shipping", "slices", "02-beta", "SPEC.md"), nodeBytes("OPR.BETA.2", "closed", "Beta Slice 2"));

      row("ext-old-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-ext"]);
      row("beta-ext-pending", "pending", ["project:beta", "mission:shipping", "slice:01-ext"]);
      row("beta-only-pending", "pending", ["project:beta", "mission:shipping", "slice:02-beta"]);

      catalog([{ id: "beta", root: "beta" }]);
      fs.symlinkSync(externalOldRoot, alias, "dir");
      const { app, indexer } = route("alpha", true, alias);

      const origIsReady = indexer.isReady.bind(indexer);
      let preWalkAction: "retarget" | "unlink" | null = "retarget";
      const readySpy = vi.spyOn(indexer, "isReady").mockImplementation(() => {
        if (preWalkAction === "retarget") {
          preWalkAction = null;
          fs.rmSync(alias);
          fs.symlinkSync(betaRoot, alias, "dir");
        } else if (preWalkAction === "unlink") {
          preWalkAction = null;
          fs.rmSync(alias);
        }
        return origIsReady();
      });
      try {
        // Case 1: retargeting the explicit symlink root to Beta before the walk stays bound to externalOldRoot.
        const retargeted = await app.request("/api/slices");
        expect(retargeted.status).toBe(200);
        const retargetedBody = await retargeted.json() as {
          slices: Entry[];
          missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
        };
        expect(retargetedBody.slices.map((s) => s.name)).toEqual(["01-ext"]);
        expect(retargetedBody.slices[0]).toMatchObject({
          slicePath: path.join(alias, "shipping", "slices", "01-ext"),
          rawStatus: "active",
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect(retargetedBody.missions["shipping"]?.authoredStatus).toBe("active");
        expect(retargetedBody.missions["shipping"]?.readiness?.historicalStatus).toBe("active");

        // Case 2: unlinking the alias after capture and before the uncached walk still completes coherently
        // from the captured physical root with zero filesystem reads through the removed alias.
        fs.rmSync(alias);
        fs.symlinkSync(externalOldRoot, alias, "dir");
        indexer.invalidate();
        preWalkAction = "unlink";
        const unlinkedMidOp = await app.request("/api/slices");
        expect(unlinkedMidOp.status).toBe(200);
        const unlinkedBody = await unlinkedMidOp.json() as {
          slices: Entry[];
          missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
        };
        expect(unlinkedBody.slices.map((s) => s.name)).toEqual(["01-ext"]);
        expect(unlinkedBody.slices[0]).toMatchObject({
          slicePath: path.join(alias, "shipping", "slices", "01-ext"),
          rawStatus: "active",
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect(unlinkedBody.missions["shipping"]?.authoredStatus).toBe("active");
        expect(unlinkedBody.missions["shipping"]?.readiness?.historicalStatus).toBe("active");

        // Subsequent request after unlink observes the missing alias as 503 slices_root_not_configured.
        const afterUnlink = await app.request("/api/slices");
        expect(afterUnlink.status).toBe(503);
        expect(await afterUnlink.json()).toMatchObject({ error: "slices_root_not_configured" });
      } finally {
        readySpy.mockRestore();
      }
    });

    it("keeps catalog-matched configured symlink root ownership bound to the captured physical target when retargeted before the walk", async () => {
      const oldRoot = path.join(root, "alpha", "missions-v1");
      const newRoot = path.join(root, "alpha", "missions-v2");
      const alphaMissions = path.join(root, "alpha", "missions");

      write(path.join(oldRoot, "shipping", "SPEC.md"), nodeBytes("M.CAT.OLD", "active", "Catalog Old Mission"));
      write(path.join(oldRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.CAT.OLD\n  status: active\n");
      write(
        path.join(oldRoot, "shipping", "slices", "01-old", "SPEC.md"),
        nodeBytes("OPR.CAT.OLD", "active", "Catalog Old Slice"),
      );

      write(path.join(newRoot, "shipping", "SPEC.md"), nodeBytes("M.CAT.NEW", "closed", "Catalog New Mission"));
      write(path.join(newRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.CAT.NEW\n  status: closed\n");
      write(
        path.join(newRoot, "shipping", "slices", "02-new", "SPEC.md"),
        nodeBytes("OPR.CAT.NEW", "closed", "Catalog New Slice"),
      );

      row("cat-old-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-old"]);
      row("cat-new-pending", "pending", ["project:alpha", "mission:shipping", "slice:02-new"]);

      fs.rmSync(alphaMissions, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(alphaMissions), { recursive: true });
      fs.symlinkSync(oldRoot, alphaMissions, "dir");
      const { app, indexer } = route("alpha", false, alphaMissions);

      const origIsReady = indexer.isReady.bind(indexer);
      let retargetBeforeWalk = true;
      const readySpy = vi.spyOn(indexer, "isReady").mockImplementation(() => {
        if (retargetBeforeWalk) {
          retargetBeforeWalk = false;
          fs.rmSync(alphaMissions);
          fs.symlinkSync(newRoot, alphaMissions, "dir");
        }
        return origIsReady();
      });
      try {
        const first = await app.request("/api/slices");
        expect(first.status).toBe(200);
        const firstBody = await first.json() as {
          slices: Entry[];
          missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
        };
        expect(firstBody.slices.map((s) => s.name)).toEqual(["01-old"]);
        expect(firstBody.slices[0]).toMatchObject({
          slicePath: path.join(alphaMissions, "shipping", "slices", "01-old"),
          rawStatus: "active",
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect(firstBody.missions["shipping"]?.authoredStatus).toBe("active");
        expect(firstBody.missions["shipping"]?.readiness?.historicalStatus).toBe("active");

        const second = await app.request("/api/slices");
        expect(second.status).toBe(200);
        const secondBody = await second.json() as {
          slices: Entry[];
          missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
        };
        expect(secondBody.slices.map((s) => s.name)).toEqual(["02-new"]);
        expect(secondBody.slices[0]).toMatchObject({
          slicePath: path.join(alphaMissions, "shipping", "slices", "02-new"),
          rawStatus: "closed",
          queueCounts: { ...ZERO, pending: 1 },
          derivedState: "pending",
        });
        expect(secondBody.missions["shipping"]?.authoredStatus).toBe("closed");
        expect(secondBody.missions["shipping"]?.readiness?.historicalStatus).toBe("closed");
      } finally {
        readySpy.mockRestore();
      }
    });

    it("does not walk or re-resolve a failed primary root for project readiness when it appears after capture", async () => {
      const alphaExtra = path.join(root, "alpha-readiness-fallback-extra");
      const alphaSlicePath = path.join(alphaExtra, "shipping", "slices", "01-extra");
      write(path.join(alphaExtra, "shipping", "SPEC.md"), nodeBytes("M.EXTRA", "active", "Extra Mission"));
      write(path.join(alphaSlicePath, "SPEC.md"), nodeBytes("OPR.EXTRA", "active", "Extra Slice"));

      // Case 1: primary root is missing at capture (ready additional root makes isReady() true),
      // then appears before the walk inside isReady(). Request 1 must fail from the captured
      // missing state without calling fs.readdirSync on the uncaptured primary root; Request 2
      // captures the newly created primary root coherently across list and project readiness.
      const latePrimary = path.join(root, "late-primary-missions");
      expect(fs.existsSync(latePrimary)).toBe(false);
      const { app: missingApp, indexer: missingIndexer } = route("alpha", false, latePrimary, [alphaExtra]);

      const origIsReady = missingIndexer.isReady.bind(missingIndexer);
      let createBeforeWalk = true;
      const readySpy = vi.spyOn(missingIndexer, "isReady").mockImplementation(() => {
        if (createBeforeWalk) {
          createBeforeWalk = false;
          write(path.join(latePrimary, "late-mission", "SPEC.md"), nodeBytes("M.LATE", "active", "Late Mission"));
          write(path.join(latePrimary, "late-mission", "mission.yaml"), "metadata:\n  id: M.LATE\n  status: active\n");
          write(path.join(latePrimary, "late-mission", "slices", "02-late", "SPEC.md"), nodeBytes("OPR.LATE", "active", "Late Slice"));
        }
        return origIsReady();
      });
      vi.mocked(fs.readdirSync).mockClear();
      try {
        const first = await missingApp.request("/api/slices");
        expect(first.status).toBe(500);
        const readdirOnLatePrimary = vi.mocked(fs.readdirSync).mock.calls.filter(([p]) => String(p) === latePrimary);
        expect(readdirOnLatePrimary).toHaveLength(0);
      } finally {
        readySpy.mockRestore();
      }

      const second = await missingApp.request("/api/slices");
      expect(second.status).toBe(200);
      const secondBody = await second.json() as {
        slices: Entry[];
        missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
      };
      expect(secondBody.slices.map((s) => s.name)).toContain("02-late");
      expect(secondBody.missions["late-mission"]?.readiness?.historicalStatus).toBe("active");

      // Case 2: primary `..` root is missing at capture and its symlink appears AFTER list()
      // (inside missionAuthoredStatuses, right before readinessRoot selection). Request 1 must
      // still fail from the captured missing state with zero fs.readdirSync calls on the failed
      // spelling, and Request 2 captures the new target cleanly.
      const lateDotDotTarget = path.join(root, "late-dotdot-readiness-target");
      fs.mkdirSync(path.join(lateDotDotTarget, "sub"), { recursive: true });
      write(path.join(lateDotDotTarget, "missions", "dotdot-mission", "SPEC.md"), nodeBytes("M.DOTDOT", "active", "DotDot Mission"));
      write(path.join(lateDotDotTarget, "missions", "dotdot-mission", "mission.yaml"), "metadata:\n  id: M.DOTDOT\n  status: active\n");
      write(
        path.join(lateDotDotTarget, "missions", "dotdot-mission", "slices", "03-dotdot", "SPEC.md"),
        nodeBytes("OPR.DOTDOT", "active", "DotDot Slice"),
      );
      const lateDotDotLink = path.join(root, "beta", "late-readiness-link");
      fs.mkdirSync(path.dirname(lateDotDotLink), { recursive: true });
      const unresolvedDotDotPrimary = `${lateDotDotLink}${path.sep}..${path.sep}missions`;
      expect(fs.existsSync(unresolvedDotDotPrimary)).toBe(false);
      const { app: dotDotApp, indexer: dotDotIndexer } = route("alpha", false, unresolvedDotDotPrimary, [alphaExtra]);

      const origAuthored = dotDotIndexer.missionAuthoredStatuses.bind(dotDotIndexer);
      let linkAfterList = true;
      const authoredSpy = vi.spyOn(dotDotIndexer, "missionAuthoredStatuses").mockImplementation(() => {
        if (linkAfterList) {
          linkAfterList = false;
          fs.symlinkSync(path.join(lateDotDotTarget, "sub"), lateDotDotLink, "dir");
        }
        return origAuthored();
      });
      vi.mocked(fs.readdirSync).mockClear();
      try {
        const firstDotDot = await dotDotApp.request("/api/slices");
        expect(firstDotDot.status).toBe(500);
        const readdirOnUnresolved = vi.mocked(fs.readdirSync).mock.calls.filter(([p]) => String(p) === unresolvedDotDotPrimary);
        expect(readdirOnUnresolved).toHaveLength(0);
      } finally {
        authoredSpy.mockRestore();
      }

      const secondDotDot = await dotDotApp.request("/api/slices");
      expect(secondDotDot.status).toBe(200);
      const secondDotDotBody = await secondDotDot.json() as {
        slices: Entry[];
        missions: Record<string, { readiness?: { historicalStatus?: string | null } }>;
      };
      expect(secondDotDotBody.slices.map((s) => s.name)).toContain("03-dotdot");
      expect(secondDotDotBody.missions["dotdot-mission"]?.readiness?.historicalStatus).toBe("active");

      // Case 3: primary root capture fails with EACCES while ready additional root exists, and the
      // EACCES clears before readiness runs. Request 1 must preserve the captured failure (500)
      // without walking the primary root via fs.readdirSync.
      const unreadablePrimary = path.join(root, "unreadable-primary-missions");
      write(path.join(unreadablePrimary, "perm-mission", "SPEC.md"), nodeBytes("M.PERM", "active", "Perm Mission"));
      write(path.join(unreadablePrimary, "perm-mission", "mission.yaml"), "metadata:\n  id: M.PERM\n  status: active\n");
      write(path.join(unreadablePrimary, "perm-mission", "slices", "04-perm", "SPEC.md"), nodeBytes("OPR.PERM", "active", "Perm Slice"));
      const { app: unreadableApp } = route("alpha", false, unreadablePrimary, [alphaExtra]);

      const origNative = fs.realpathSync.native;
      let injectOnce = true;
      const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, options?: fs.EncodingOption) => {
        if (injectOnce && String(p) === unreadablePrimary) {
          injectOnce = false;
          throw Object.assign(new Error("injected primary capture EACCES"), { code: "EACCES" });
        }
        return origNative(p, options as never);
      }) as typeof fs.realpathSync.native);
      vi.mocked(fs.readdirSync).mockClear();
      try {
        const unreadableRes = await unreadableApp.request("/api/slices");
        expect(unreadableRes.status).toBe(500);
        const readdirOnUnreadable = vi.mocked(fs.readdirSync).mock.calls.filter(([p]) => String(p) === unreadablePrimary);
        expect(readdirOnUnreadable).toHaveLength(0);
      } finally {
        realpathSpy.mockRestore();
      }

      // Case 4 (control): primary root missing at capture and still missing at readiness time keeps
      // the pre-existing 500 outcome without invoking fs.readdirSync on the failed primary spelling.
      const stillMissingPrimary = path.join(root, "still-missing-primary-missions");
      expect(fs.existsSync(stillMissingPrimary)).toBe(false);
      const { app: stillMissingApp } = route("alpha", false, stillMissingPrimary, [alphaExtra]);
      vi.mocked(fs.readdirSync).mockClear();
      const stillMissingRes = await stillMissingApp.request("/api/slices");
      expect(stillMissingRes.status).toBe(500);
      const readdirOnStillMissing = vi.mocked(fs.readdirSync).mock.calls.filter(([p]) => String(p) === stillMissingPrimary);
      expect(readdirOnStillMissing).toHaveLength(0);
    });

    it("keeps captured snapshot roots unchanged in sliceRoots during withResolvedRoots", () => {
      const alphaExtra = path.join(root, "alpha-snapshot-missions");
      const alphaSlicePath = path.join(alphaExtra, "shipping", "slices", "01-release");
      write(path.join(alphaExtra, "shipping", "SPEC.md"), nodeBytes("M.ALPHA", "active", "Mission"));
      write(path.join(alphaSlicePath, "SPEC.md"), nodeBytes("SLICE.ALPHA", "active", "Slice"));

      const lateTarget = path.join(root, "late-target");
      fs.mkdirSync(path.join(lateTarget, "sub"), { recursive: true });
      write(path.join(lateTarget, "missions", "late-mission", "SPEC.md"), nodeBytes("M.LATE", "active", "Late Mission"));
      write(path.join(lateTarget, "missions", "late-mission", "slices", "02-late", "SPEC.md"), nodeBytes("SLICE.LATE", "active", "Late Slice"));
      // Flat directory with no lexical sibling under root/beta/missions; walking an unresolved `..`
      // spelling after late-link appears would publish it as a false flat slice under beta/missions.
      write(path.join(lateTarget, "missions", "orphan-mission", "SPEC.md"), nodeBytes("SLICE.ORPHAN", "active", "Orphan"));
      // Lexical sibling under root/beta/missions; path.join(unresolvedRoot, "late-mission") collapses
      // here and would leak 09-beta-sibling if the missing `..` root were still walked mid-operation.
      write(path.join(root, "beta", "missions", "late-mission", "SPEC.md"), nodeBytes("M.BETA.SIB", "active", "Beta Sibling"));
      write(
        path.join(root, "beta", "missions", "late-mission", "slices", "09-beta-sibling", "SPEC.md"),
        nodeBytes("SLICE.BETA.SIB", "active", "Beta Sibling Slice"),
      );

      const lateLink = path.join(root, "beta", "late-link");
      fs.mkdirSync(path.dirname(lateLink), { recursive: true });
      const unresolvedRoot = `${lateLink}${path.sep}..${path.sep}missions`;
      expect(fs.existsSync(unresolvedRoot)).toBe(false);

      const indexer = new SliceIndexer({
        db,
        slicesRoot: unresolvedRoot,
        additionalSliceRoots: [alphaExtra],
        dogfoodEvidenceRoot: null,
      });

      const origNative = fs.realpathSync.native;
      let unresolvedRealpathCalls = 0;
      const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, options?: fs.EncodingOption) => {
        if (String(p) === unresolvedRoot) unresolvedRealpathCalls++;
        return origNative(p, options as never);
      }) as typeof fs.realpathSync.native);
      try {
        indexer.withResolvedRoots(() => {
          indexer.withMembershipBatch(() => {
            const snapshotRoot = indexer.slicesRoot;
            expect(snapshotRoot).toBe(unresolvedRoot);
            expect(indexer.isReady()).toBe(true);
            const beforeLink = indexer.list().map((s) => [s.name, s.missionId, s.slicePath]);
            expect(beforeLink).toEqual([["01-release", "shipping", alphaSlicePath]]);
            expect(indexer.missionAuthoredStatuses()).toEqual({ shipping: { authoredStatus: "active" } });

            // Create the symlink mid-operation; a `..` root that was missing at capture must stay
            // excluded from walks for the rest of the operation rather than walking the unresolved
            // `..` string and collapsing into lexical siblings or publishing a false flat slice.
            const callsBeforeLink = unresolvedRealpathCalls;
            fs.symlinkSync(path.join(lateTarget, "sub"), lateLink, "dir");
            indexer.invalidate();
            const midOp = indexer.list();
            expect(indexer.slicesRoot).toBe(snapshotRoot);
            expect(midOp.map((s) => [s.name, s.missionId, s.slicePath])).toEqual(beforeLink);
            expect(indexer.missionAuthoredStatuses()).toEqual({ shipping: { authoredStatus: "active" } });
            expect(unresolvedRealpathCalls).toBe(callsBeforeLink);
          });
        });

        // The next withResolvedRoots call captures the newly resolved physical root.
        const callsBeforeNextOp = unresolvedRealpathCalls;
        indexer.withResolvedRoots(() => {
          expect(indexer.slicesRoot).toBe(path.join(lateTarget, "missions"));
          expect(unresolvedRealpathCalls).toBe(callsBeforeNextOp + 1);
          const nextOp = indexer.list();
          expect(nextOp.map((s) => [s.name, s.missionId, s.slicePath])).toEqual([
            ["01-release", "shipping", alphaSlicePath],
            ["02-late", "late-mission", path.join(lateTarget, "missions", "late-mission", "slices", "02-late")],
            ["orphan-mission", null, path.join(lateTarget, "missions", "orphan-mission")],
          ]);
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("excludes unreadable .. roots from walks and fails observed counts closed to unknown", () => {
      const alphaExtra = path.join(root, "alpha-unreadable-missions");
      const alphaSlicePath = path.join(alphaExtra, "shipping", "slices", "01-release");
      write(path.join(alphaExtra, "shipping", "SPEC.md"), nodeBytes("M.ALPHA", "active", "Mission"));
      write(path.join(alphaSlicePath, "SPEC.md"), nodeBytes("SLICE.ALPHA", "active", "Slice"));
      row("alpha-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-release"]);

      const target = path.join(root, "unreadable-target");
      fs.mkdirSync(path.join(target, "sub"), { recursive: true });
      write(path.join(target, "missions", "late-mission", "SPEC.md"), nodeBytes("M.LATE", "active", "Late Mission"));
      write(path.join(target, "missions", "late-mission", "slices", "02-late", "SPEC.md"), nodeBytes("SLICE.LATE", "active", "Late Slice"));
      write(path.join(target, "missions", "orphan-mission", "SPEC.md"), nodeBytes("SLICE.ORPHAN", "active", "Orphan"));
      write(
        path.join(root, "beta", "missions", "late-mission", "slices", "09-beta-sibling", "SPEC.md"),
        nodeBytes("SLICE.BETA.SIB", "active", "Beta Sibling Slice"),
      );

      const link = path.join(root, "beta", "unreadable-link");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(target, "sub"), link, "dir");
      const unreadableRoot = `${link}${path.sep}..${path.sep}missions`;

      const indexer = new SliceIndexer({
        db,
        projectId: "alpha",
        slicesRoot: alphaExtra,
        additionalSliceRoots: [unreadableRoot],
        dogfoodEvidenceRoot: null,
      });

      const origNative = fs.realpathSync.native;
      let realpathFaultHits = 0;
      const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, options?: fs.EncodingOption) => {
        if (String(p) === unreadableRoot) {
          realpathFaultHits++;
          throw Object.assign(new Error("injected unreadable .. root EACCES"), { code: "EACCES" });
        }
        return origNative(p, options as never);
      }) as typeof fs.realpathSync.native);
      vi.mocked(fs.readdirSync).mockClear();
      try {
        indexer.withResolvedRoots(() => {
          const entries = indexer.list();
          const counts = indexer.observedQueueCounts(entries);
          expect(realpathFaultHits).toBeGreaterThan(0);
          expect(counts.get(alphaSlicePath)).toBeNull();
          expect(entries.map((s) => [s.name, s.missionId, s.slicePath])).toEqual([
            ["01-release", "shipping", alphaSlicePath],
          ]);
          const readdirOnUnresolved = vi.mocked(fs.readdirSync).mock.calls.filter(([p]) => String(p) === unreadableRoot);
          expect(readdirOnUnresolved).toHaveLength(0);
        });
      } finally {
        spy.mockRestore();
      }

      // Positive control: when the .. root resolves cleanly, observed counts recover and list the physical target.
      indexer.withResolvedRoots(() => {
        const entries = indexer.list();
        const counts = indexer.observedQueueCounts(entries);
        expect(entries.map((s) => [s.name, s.missionId, s.slicePath])).toEqual([
          ["01-release", "shipping", alphaSlicePath],
          ["02-late", "late-mission", path.join(target, "missions", "late-mission", "slices", "02-late")],
          ["orphan-mission", null, path.join(target, "missions", "orphan-mission")],
        ]);
        expect(counts.get(alphaSlicePath)).toEqual({ ...ZERO, blocked: 1 });
      });
    });

    it.each(["ENOENT", "EACCES"] as const)(
      "does not drop an ambiguous duplicate candidate via a redundant second realpath in resolveProjectId (%s)",
      async (code) => {
        const alphaPrimary = path.join(root, "alpha", "missions");
        addSlice("alpha", "shipping", "01-release", "active", "SLICE.ALPHA.PRIMARY");
        addSlice("alpha", "shipping", "02-unique", "active", "SLICE.ALPHA.UNIQUE");

        const alphaDuplicate = path.join(root, "alpha-duplicate-missions");
        write(path.join(alphaDuplicate, "shipping", "SPEC.md"), nodeBytes("M.ALPHA.DUP", "active", "Duplicate Mission"));
        const hiddenSlicePath = path.join(alphaDuplicate, "shipping", "slices", "01-release");
        write(path.join(hiddenSlicePath, "SPEC.md"), nodeBytes("SLICE.ALPHA.DUP", "active", "Duplicate Slice"));
        const hiddenSliceReal = fs.realpathSync.native(hiddenSlicePath);

        row("dup-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-release"]);
        row("unique-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:02-unique"]);

        catalog([{ id: "alpha", root: "alpha" }]);
        const { app } = route("alpha", true, alphaPrimary, [alphaDuplicate]);

        const origNative = fs.realpathSync.native;
        let hiddenRealpathCalls = 0;
        let secondCallFailures = 0;
        const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, options?: fs.EncodingOption) => {
          if (String(p) === hiddenSliceReal) {
            hiddenRealpathCalls++;
            if (hiddenRealpathCalls > 1) {
              secondCallFailures++;
              throw Object.assign(new Error(`injected second realpath ${code}`), { code });
            }
          }
          return origNative(p, options as never);
        }) as typeof fs.realpathSync.native);
        try {
          const entries = await list(app);
          expect(entries.find((s) => s.name === "01-release")).toMatchObject({
            queueCounts: ZERO,
            derivedState: "none",
          });
          expect(entries.find((s) => s.name === "02-unique")).toMatchObject({
            queueCounts: { ...ZERO, blocked: 1 },
            derivedState: "blocked",
          });
          expect(hiddenRealpathCalls).toBe(1);
          expect(secondCallFailures).toBe(0);

          hiddenRealpathCalls = 0;
          expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual(["02-unique"]);
          expect(hiddenRealpathCalls).toBe(1);
          expect(secondCallFailures).toBe(0);
        } finally {
          spy.mockRestore();
        }
      },
    );

    it("keeps explicit project ownership bound to captured root status when a missing .. additional root appears mid-request", async () => {
      const alphaExtra = path.join(root, "alpha-extra-midreq-missions");
      write(path.join(alphaExtra, "shipping", "SPEC.md"), nodeBytes("M.ALPHA.SHIP", "active", "Mission"));
      write(path.join(alphaExtra, "shipping", "slices", "01-release", "SPEC.md"), nodeBytes("SLICE.ALPHA.REL", "active", "Slice"));
      addSlice("beta", "shipping", "01-release", "active", "SLICE.BETA.REL", { missionId: "M.BETA.SHIP" });
      fs.mkdirSync(path.join(root, "beta", "sub"), { recursive: true });

      row("alpha-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-release"]);
      row("beta-pending", "pending", ["project:beta", "mission:shipping", "slice:01-release"]);

      const lateLink = path.join(root, "alpha", "late-link");
      const unresolvedRoot = `${lateLink}${path.sep}..${path.sep}missions`;
      expect(fs.existsSync(unresolvedRoot)).toBe(false);

      const { app, indexer } = route("alpha", true, alphaExtra, [unresolvedRoot]);
      const origList = indexer.list.bind(indexer);
      let injectOnList = true;
      const listSpy = vi.spyOn(indexer, "list").mockImplementation(() => {
        const entries = origList();
        if (injectOnList) {
          injectOnList = false;
          fs.symlinkSync(path.join(root, "beta", "sub"), lateLink, "dir");
        }
        return entries;
      });
      const origNative = fs.realpathSync.native;
      let unresolvedRealpathCalls = 0;
      const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, options?: fs.EncodingOption) => {
        if (String(p) === unresolvedRoot) unresolvedRealpathCalls++;
        return origNative(p, options as never);
      }) as typeof fs.realpathSync.native);
      try {
        // Request 1: unresolvedRoot is missing at withResolvedRoots capture and appears before resolveSliceProjectLookup.
        const firstEntries = await list(app);
        expect(firstEntries.find((s) => s.name === "01-release")).toMatchObject({
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect(unresolvedRealpathCalls).toBe(1);

        // Repeat with ?derived=blocked from the same missing-at-capture starting state.
        fs.unlinkSync(lateLink);
        injectOnList = true;
        expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual(["01-release"]);
        expect(unresolvedRealpathCalls).toBe(2);

        // Request 3 (positive control): lateLink now exists BEFORE withResolvedRoots capture,
        // so unresolvedRoot legitimately resolves to Beta's missions root as an explicit Alpha root.
        const afterCapturedEntries = await list(app);
        expect(afterCapturedEntries.find((s) => s.name === "01-release")).toMatchObject({
          queueCounts: ZERO,
          derivedState: "none",
        });
        expect(unresolvedRealpathCalls).toBe(3);
        expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual([]);
      } finally {
        listSpy.mockRestore();
        realpathSpy.mockRestore();
      }
    });

    it.each(["ENOENT", "EACCES"] as const)(
      "preserves ambiguity in nested catalog projects without a second realpath in inferCatalogProject (%s)",
      async (code) => {
        catalog([
          { id: "root", root: "." },
          { id: "alpha", root: "projects/alpha" },
        ]);
        addCatalogProject("root", ".");
        addCatalogProject("alpha", "projects/alpha");

        const alphaExtra = path.join(root, "alpha-extra-nested-missions");
        write(path.join(alphaExtra, "shipping", "SPEC.md"), nodeBytes("M.ALPHA.EXTRA", "active", "Mission"));
        write(path.join(alphaExtra, "shipping", "slices", "01-release", "SPEC.md"), nodeBytes("SLICE.ALPHA.REL", "active", "Slice"));
        write(path.join(alphaExtra, "shipping", "slices", "02-unique", "SPEC.md"), nodeBytes("SLICE.ALPHA.UNIQ", "active", "Unique"));

        const hiddenSlicePath = addSlice("projects/alpha", "shipping", "01-release", "active", "SLICE.ALPHA.NESTED");
        const hiddenSliceReal = fs.realpathSync.native(hiddenSlicePath);
        configureCatalogRoute(alphaExtra);

        row("dup-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-release"]);
        row("unique-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:02-unique"]);

        const { app } = route("alpha", true, alphaExtra);

        realpathSyncFault.targetPath = hiddenSliceReal;
        realpathSyncFault.code = code;
        realpathSyncFault.hits = 0;
        try {
          const entries = await list(app);
          expect(entries.find((s) => s.name === "01-release")).toMatchObject({
            queueCounts: ZERO,
            derivedState: "none",
          });
          expect(entries.find((s) => s.name === "02-unique")).toMatchObject({
            queueCounts: { ...ZERO, blocked: 1 },
            derivedState: "blocked",
          });
          expect(realpathSyncFault.hits).toBe(0);

          expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual(["02-unique"]);
          expect(realpathSyncFault.hits).toBe(0);
        } finally {
          realpathSyncFault.targetPath = null;
          realpathSyncFault.hits = 0;
        }
      },
    );

    it("keeps unrelated slice counts readable and preserves ambiguity checks when a cached folder moves in a README-only mission", async () => {
      const missionRoot = path.join(root, "alpha", "missions", "shipping");
      addSlice("alpha", "shipping", "01-stuck", "active", "SLICE.SHARED", { mission: "README.md", slice: "README.md" });
      const movableDir = path.join(missionRoot, "slices", "02-movable");
      fs.mkdirSync(movableDir, { recursive: true });
      fs.writeFileSync(path.join(movableDir, "README.md"), nodeBytes("SLICE.SHARED", "active", "Movable"));
      expect(fs.existsSync(path.join(missionRoot, "mission.yaml"))).toBe(false);

      row("stuck-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-stuck"]);
      row("movable-pending", "pending", ["project:alpha", "mission:shipping", "slice:02-movable"]);
      row("shared-id-ambiguous", "in-progress", ["slice:SLICE.SHARED"]);

      const { app } = route();
      const primed = await list(app);
      expect(derivedByName(primed)).toEqual({ "01-stuck": "blocked", "02-movable": "pending" });
      expect(primed.find((s) => s.name === "01-stuck")?.queueCounts).toEqual({ ...ZERO, blocked: 1 });

      const movedDir = path.join(missionRoot, "slices", "02-moved");
      fs.renameSync(movableDir, movedDir);

      // Next ordinary request hits the warm 60s listing cache without ?refresh=1.
      const afterMove = await list(app);
      expect(afterMove.map((s) => s.name).sort()).toEqual(["01-stuck", "02-movable"]);
      expect(afterMove.find((s) => s.name === "01-stuck")).toMatchObject({
        queueCounts: { ...ZERO, blocked: 1 },
        derivedState: "blocked",
      });
      expect(afterMove.find((s) => s.name === "02-movable")).toMatchObject({
        queueCounts: null,
        derivedState: "unknown",
      });
      expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual(["01-stuck"]);
      expect((await list(app, "?derived=unknown")).map((s) => s.name)).toEqual(["02-movable"]);
    });

    it("still fails all counts to unknown when a stale cached entry lookup fails with a non-ENOENT error", async () => {
      const missionRoot = path.join(root, "alpha", "missions", "shipping");
      addSlice("alpha", "shipping", "01-stuck", "active", "SLICE.STUCK", { mission: "README.md", slice: "README.md" });
      const otherDir = path.join(missionRoot, "slices", "02-other");
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(path.join(otherDir, "README.md"), nodeBytes("SLICE.OTHER", "active", "Other"));
      row("stuck-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-stuck"]);
      row("other-pending", "pending", ["project:alpha", "mission:shipping", "slice:02-other"]);

      const { app } = route();
      expect(derivedByName(await list(app))).toEqual({ "01-stuck": "blocked", "02-other": "pending" });

      // Move the folder away after priming the listing cache so the live walk no longer visits otherDir;
      // only the visible cached-entry check sees the EACCES on the stale cached spelling.
      fs.renameSync(otherDir, path.join(missionRoot, "slices", "02-other-moved"));

      const origNative = fs.realpathSync.native;
      let hits = 0;
      const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, options?: fs.EncodingOption) => {
        if (String(p) === otherDir) {
          hits++;
          throw Object.assign(new Error("injected realpath EACCES"), { code: "EACCES" });
        }
        return origNative(p, options as never);
      }) as typeof fs.realpathSync.native);
      try {
        const afterError = await list(app);
        expect(hits).toBeGreaterThan(0);
        expect(afterError.map((s) => [s.name, s.queueCounts, s.derivedState]).sort()).toEqual([
          ["01-stuck", null, "unknown"],
          ["02-other", null, "unknown"],
        ]);
        expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual([]);
        expect((await list(app, "?derived=unknown")).map((s) => s.name).sort()).toEqual(["01-stuck", "02-other"]);
      } finally {
        spy.mockRestore();
      }
    });

    it("reports unknown, not none, when the queue table cannot be read", async () => {
      addSlice("alpha", "shipping", "live");
      row("live-0", "pending", scope("live"));
      const { app } = route();
      expect((await list(app))[0]).toMatchObject({ name: "live", derivedState: "pending" });
      db.exec("DROP TABLE queue_items");
      const entries = await list(app, "?refresh=1");
      expect(entries[0]).toMatchObject({ name: "live", queueCounts: null, derivedState: "unknown" });
    });

    // Fault injection on the separate count read: the first matching row is read, then the iterator fails.
    function failCountScanAfterFirstRow(): { hits: () => number; yielded: () => number; restore: () => void } {
      const prepare = db.prepare.bind(db);
      let hits = 0;
      let yielded = 0;
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        const stmt = prepare(sql);
        if (!/^SELECT state, tags FROM queue_items WHERE tags LIKE/.test(sql)) return stmt;
        return new Proxy(stmt, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "iterate") return typeof value === "function" ? value.bind(target) : value;
          return (...args: unknown[]) => (function* () {
            const rows = (target.iterate(...args as []) as Iterable<unknown>)[Symbol.iterator]();
            try {
              const first = rows.next();
              if (!first.done) { yielded++; yield first.value; }
              hits++;
              throw new Error("SQLITE_IOERR: disk I/O error while reading queue rows");
            } finally { rows.return?.(); }
          })();
        } });
      }) as typeof db.prepare);
      return { hits: () => hits, yielded: () => yielded, restore: () => spy.mockRestore() };
    }

    it("returns the slice rows with unknown counts, and no partial counter, when the count scan fails after it starts", async () => {
      addSlice("alpha", "shipping", "first", "active");
      addSlice("alpha", "shipping", "second", "active");
      row("first-0", "blocked", scope("first"));
      row("first-1", "blocked", scope("first"));
      row("second-0", "pending", scope("second"));
      const fault = failCountScanAfterFirstRow();
      try {
        const { app } = route();
        const entries = await list(app);
        expect(fault.yielded(), "a counted row must have been read before the failure, or the partial-count control proves nothing").toBe(1);
        expect(fault.hits(), "the iterator must then have failed").toBe(1);
        expect(entries.map(s => [s.name, s.status, s.queueCounts, s.derivedState]).sort()).toEqual([
          ["first", "active", null, "unknown"], ["second", "active", null, "unknown"],
        ]);
        expect((await list(app, "?derived=blocked")).map(s => s.name), "a counter filled before the failure must not leak").toEqual([]);
        expect((await list(app, "?derived=unknown")).map(s => s.name).sort()).toEqual(["first", "second"]);
        expect((await list(app, "?filter=active&derived=unknown")).map(s => s.name).sort()).toEqual(["first", "second"]);
      } finally { fault.restore(); }
    });

    it("still fails the request when the underlying slice listing fails", async () => {
      addSlice("alpha", "shipping", "live");
      row("live-0", "pending", scope("live"));
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (/ORDER BY ts_created DESC, qitem_id DESC/.test(sql)) throw new Error("SQLITE_IOERR: disk I/O error while listing");
        return prepare(sql);
      }) as typeof db.prepare);
      try {
        const response = await route().app.request("/api/slices");
        expect(response.status).toBe(500);
      } finally { spy.mockRestore(); }
    });

    it.each([
      { label: "absent counts", counts: undefined },
      { label: "null counts", counts: null },
    ])("derives unknown from $label", ({ counts }) => {
      expect(deriveSliceQueueState(counts)).toBe("unknown");
    });

    it("applies derivedState and ?derived= after cooperative WAL counting and degrades to unknown if the cooperative count read fails", async () => {
      db.close();
      db = createDb(path.join(root, "openrig-derived-wal.sqlite"));
      migrate(db, ALL_MIGRATIONS);
      addSlice("alpha", "shipping", "blocked-slice", "active");
      addSlice("alpha", "shipping", "none-slice", "active");
      row("wal-blocked", "blocked", scope("blocked-slice"));
      const { app, indexer } = route("alpha", false);

      const allEntries = await list(app);
      expect(allEntries.map((s) => [s.name, s.derivedState, s.queueCounts]).sort()).toEqual([
        ["blocked-slice", "blocked", { ...ZERO, blocked: 1 }],
        ["none-slice", "none", ZERO],
      ]);
      expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual(["blocked-slice"]);
      expect((await list(app, "?derived=none")).map((s) => s.name)).toEqual(["none-slice"]);

      // A fault in the cooperative pre-read must degrade counts to unknown without failing GET /api/slices.
      const spy = vi.spyOn(indexer, "readQueueCountRowsCooperatively").mockRejectedValueOnce(new Error("SQLITE_BUSY: injected WAL read error"));
      try {
        const degraded = await list(app);
        expect(degraded.map((s) => [s.name, s.queueCounts, s.derivedState]).sort()).toEqual([
          ["blocked-slice", null, "unknown"],
          ["none-slice", null, "unknown"],
        ]);
      } finally {
        spy.mockRestore();
      }
      const spyFilter = vi.spyOn(indexer, "readQueueCountRowsCooperatively").mockRejectedValueOnce(new Error("SQLITE_BUSY: injected WAL read error"));
      try {
        expect((await list(app, "?derived=blocked")).map((s) => s.name)).toEqual([]);
      } finally {
        spyFilter.mockRestore();
      }
      const spyUnknown = vi.spyOn(indexer, "readQueueCountRowsCooperatively").mockRejectedValueOnce(new Error("SQLITE_BUSY: injected WAL read error"));
      try {
        expect((await list(app, "?derived=unknown")).map((s) => s.name).sort()).toEqual(["blocked-slice", "none-slice"]);
      } finally {
        spyUnknown.mockRestore();
      }
    });

    it("discards partial counts and degrades to unknown when countQueueRowsCooperatively throws mid-count", async () => {
      db.close();
      db = createDb(path.join(root, "openrig-count-catch-wal.sqlite"));
      migrate(db, ALL_MIGRATIONS);
      addSlice("alpha", "shipping", "blocked-slice", "active");
      addSlice("alpha", "shipping", "none-slice", "active");
      row("wal-blocked", "blocked", scope("blocked-slice"));
      const { app, indexer } = route("alpha", false);

      const injectMidCountThrow = () =>
        vi.spyOn(indexer, "countQueueRowsCooperatively").mockImplementationOnce(async (rows, countRow) => {
          expect(rows.length).toBeGreaterThan(0);
          countRow(rows[0]!);
          throw new Error("injected cooperative count failure");
        });

      const spyAll = injectMidCountThrow();
      try {
        const res = await app.request("/api/slices");
        expect(res.status).toBe(200);
        const body = await res.json() as { slices: Entry[] };
        expect(body.slices.map((s) => [s.name, s.queueCounts, s.derivedState]).sort()).toEqual([
          ["blocked-slice", null, "unknown"],
          ["none-slice", null, "unknown"],
        ]);
        expect(spyAll).toHaveBeenCalledTimes(1);
      } finally {
        spyAll.mockRestore();
      }

      const spyBlocked = injectMidCountThrow();
      try {
        const res = await app.request("/api/slices?derived=blocked");
        expect(res.status).toBe(200);
        const body = await res.json() as { slices: Entry[] };
        expect(body.slices.map((s) => s.name)).toEqual([]);
        expect(spyBlocked).toHaveBeenCalledTimes(1);
      } finally {
        spyBlocked.mockRestore();
      }

      const spyUnknown = injectMidCountThrow();
      try {
        const res = await app.request("/api/slices?derived=unknown");
        expect(res.status).toBe(200);
        const body = await res.json() as { slices: Entry[] };
        expect(body.slices.map((s) => s.name).sort()).toEqual(["blocked-slice", "none-slice"]);
        expect(spyUnknown).toHaveBeenCalledTimes(1);
      } finally {
        spyUnknown.mockRestore();
      }

      // After the transient fault clears, the next request returns normal observed counts.
      const recovered = await list(app);
      expect(recovered.map((s) => [s.name, s.derivedState, s.queueCounts]).sort()).toEqual([
        ["blocked-slice", "blocked", { ...ZERO, blocked: 1 }],
        ["none-slice", "none", ZERO],
      ]);
    });

    it("keeps the whole WAL cooperative list operation bound to the captured physical root when a symlink root retargets before the walk", async () => {
      db.close();
      db = createDb(path.join(root, "openrig-retarget-wal.sqlite"));
      migrate(db, ALL_MIGRATIONS);

      const oldRoot = path.join(root, "alpha", "missions");
      const newRoot = path.join(root, "beta", "missions");
      const alias = path.join(root, "wal-walk-alias");

      write(path.join(oldRoot, "shipping", "SPEC.md"), nodeBytes("M.OLD", "active", "Old Mission"));
      write(path.join(oldRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.OLD\n  status: active\n");
      write(path.join(oldRoot, "shipping", "slices", "01-old", "SPEC.md"), nodeBytes("OPR.OLD", "active", "Old Slice"));

      write(path.join(newRoot, "shipping", "SPEC.md"), nodeBytes("M.NEW", "closed", "New Mission"));
      write(path.join(newRoot, "shipping", "mission.yaml"), "metadata:\n  id: M.NEW\n  status: closed\n");
      write(path.join(newRoot, "shipping", "slices", "02-new", "SPEC.md"), nodeBytes("OPR.NEW", "closed", "New Slice"));

      row("wal-old-blocked", "blocked", ["project:alpha", "mission:shipping", "slice:01-old"]);
      row("wal-new-pending", "pending", ["project:beta", "mission:shipping", "slice:02-new"]);

      fs.symlinkSync(oldRoot, alias, "dir");
      const { app, indexer } = route("alpha", false, alias);

      const origIsReady = indexer.isReady.bind(indexer);
      let retargetOnce = true;
      const readySpy = vi.spyOn(indexer, "isReady").mockImplementation(() => {
        if (retargetOnce) {
          retargetOnce = false;
          fs.rmSync(alias);
          fs.symlinkSync(newRoot, alias, "dir");
        }
        return origIsReady();
      });
      try {
        const firstRes = await app.request("/api/slices?derived=blocked");
        expect(firstRes.status).toBe(200);
        const firstBody = await firstRes.json() as {
          slices: Entry[];
          missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
        };
        expect(firstBody.slices.map((s) => s.name)).toEqual(["01-old"]);
        expect(firstBody.slices[0]).toMatchObject({
          slicePath: path.join(alias, "shipping", "slices", "01-old"),
          rawStatus: "active",
          queueCounts: { ...ZERO, blocked: 1 },
          derivedState: "blocked",
        });
        expect(firstBody.missions["shipping"]?.authoredStatus).toBe("active");
        expect(firstBody.missions["shipping"]?.readiness?.historicalStatus).toBe("active");

        const secondRes = await app.request("/api/slices?derived=pending");
        expect(secondRes.status).toBe(200);
        const secondBody = await secondRes.json() as {
          slices: Entry[];
          missions: Record<string, { authoredStatus?: string | null; readiness?: { historicalStatus?: string | null } }>;
        };
        expect(secondBody.slices.map((s) => s.name)).toEqual(["02-new"]);
        expect(secondBody.slices[0]).toMatchObject({
          slicePath: path.join(alias, "shipping", "slices", "02-new"),
          rawStatus: "closed",
          queueCounts: { ...ZERO, pending: 1 },
          derivedState: "pending",
        });
        expect(secondBody.missions["shipping"]?.authoredStatus).toBe("closed");
        expect(secondBody.missions["shipping"]?.readiness?.historicalStatus).toBe("closed");
      } finally {
        readySpy.mockRestore();
      }
    });

    it("isolates frontmatter-id slice aliases between two overlapping WAL cooperative requests across a symlink retarget", async () => {
      db.close();
      db = createDb(path.join(root, "openrig-concurrent-alias-wal.sqlite"));
      migrate(db, ALL_MIGRATIONS);

      const oldRoot = path.join(root, "alpha", "missions");
      const newRoot = path.join(root, "beta", "missions");
      const alias = path.join(root, "wal-concurrent-alias");

      write(path.join(oldRoot, "shipping", "SPEC.md"), nodeBytes("M.OLD", "active", "Old Mission"));
      write(path.join(oldRoot, "shipping", "slices", "01-shared", "SPEC.md"), nodeBytes("SLICE.SHARED.ID", "active", "Old Shared"));
      write(path.join(oldRoot, "shipping", "slices", "02-old-fallback", "SPEC.md"), nodeBytes("SLICE.OLD.FALLBACK", "active", "Old Fallback"));

      write(path.join(newRoot, "shipping", "SPEC.md"), nodeBytes("M.NEW", "active", "New Mission"));
      // Under newRoot, 01-shared declares SLICE.UNRELATED (no slice in newRoot owns SLICE.SHARED.ID).
      // If reqB reuses reqA's oldRoot idAliases cache, reqB folds SLICE.SHARED.ID onto 01-shared, skips the
      // fallback scan, and finishes before reqA invalidates with a false qitemCount: 1 on 01-shared.
      write(path.join(newRoot, "shipping", "slices", "01-shared", "SPEC.md"), nodeBytes("SLICE.UNRELATED", "active", "New Unrelated"));

      // Insert >4 cooperative rowid windows (WINDOW_ROWS = 256) so both requests genuinely yield across setImmediate.
      const insertNoise = db.prepare(`INSERT INTO queue_items
        (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, tags)
        VALUES (?, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z', 'writer@fixture', 'worker@fixture', 'done', 'routine', 'noise', NULL)`);
      db.transaction(() => {
        for (let i = 0; i < 1100; i++) insertNoise.run(`noise-${String(i).padStart(4, "0")}`);
      })();
      row("shared-frontmatter-tag", "blocked", ["slice:SLICE.SHARED.ID"], "frontmatter-tagged work");

      fs.symlinkSync(oldRoot, alias, "dir");
      const { app } = route("alpha", false, alias);

      let firstSettled = false;
      const reqA = app.request("/api/slices").then((res) => { firstSettled = true; return res; });
      // Advance 2 cooperative event-loop turns so reqA is mid-flight, then retarget and start reqB overlapping reqA.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstSettled, "reqA must still be in flight when alias retargets and reqB starts").toBe(false);
      fs.rmSync(alias);
      fs.symlinkSync(newRoot, alias, "dir");
      const reqB = app.request("/api/slices");

      const [resA, resB] = await Promise.all([reqA, reqB]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const bodyA = await resA.json() as { slices: Entry[] };
      const bodyB = await resB.json() as { slices: Entry[] };

      expect(bodyA.slices.map((s) => s.name).sort()).toEqual(["01-shared", "02-old-fallback"]);
      expect(bodyA.slices.find((s) => s.name === "01-shared")).toMatchObject({
        slicePath: path.join(alias, "shipping", "slices", "01-shared"),
        qitemCount: 1,
      });

      expect(bodyB.slices.map((s) => s.name)).toEqual(["01-shared"]);
      expect(bodyB.slices.find((s) => s.name === "01-shared")).toMatchObject({
        slicePath: path.join(alias, "shipping", "slices", "01-shared"),
        qitemCount: 0,
      });

      // A follow-up request on the new target must also observe clean aliases with zero lingering cache poisoning.
      const followUp = await list(app);
      expect(followUp.find((s) => s.name === "01-shared")?.qitemCount).toBe(0);
    });

    it("maps listed slices through the winning outer root when nested configured roots contain an inner symlink", async () => {
      const outerPhysical = path.join(root, "a");
      const archiveShared = path.join(root, "archive", "shared");
      const otherRoot = path.join(root, "other");
      const currentAlias = path.join(root, "current");

      write(path.join(outerPhysical, "project.yaml"), "id: outer\n");
      write(path.join(outerPhysical, "m", "SPEC.md"), nodeBytes("M.OUTER", "active", "Outer Mission"));
      write(
        path.join(outerPhysical, "m", "mission.yaml"),
        "metadata:\n  id: M.OUTER\n  status: active\nproofPolicy:\n  judges:\n    - judge@outer\n",
      );
      write(
        path.join(archiveShared, "s", "SPEC.md"),
        `${nodeBytes("SLICE.S", "active", "Nested Slice")}\n## Proof contract\n- [ ] Nested slice outcome.\n`,
      );
      fs.symlinkSync(archiveShared, path.join(outerPhysical, "m", "slices"), "dir");
      write(
        path.join(outerPhysical, "child-m", "SPEC.md"),
        "---\nid: M.CHILD\nstatus: active\nparent: SLICE.S\n---\n# Child Mission\n",
      );
      fs.mkdirSync(path.join(outerPhysical, "child-m", "slices"), { recursive: true });

      // A second mission named "m" in another root prevents idByName fallback from masking physicalPathFor remapping.
      write(path.join(otherRoot, "m", "SPEC.md"), nodeBytes("M.OTHER", "active", "Other Mission"));
      write(path.join(otherRoot, "m", "slices", "other-slice", "SPEC.md"), nodeBytes("SLICE.OTHER", "active", "Other Slice"));

      fs.symlinkSync(outerPhysical, currentAlias, "dir");
      const innerNestedRoot = path.join(currentAlias, "m", "slices");
      const { app, indexer } = route("alpha", false, currentAlias, [innerNestedRoot, otherRoot]);

      const res = await app.request("/api/slices");
      expect(res.status).toBe(200);
      const body = await res.json() as {
        slices: Array<Entry & {
          childMissions?: Array<{ id: string | null }>;
          readiness?: {
            policy?: { judges?: string[] } | null;
            attention?: { scope?: string };
          };
        }>;
      };

      const nestedSlice = body.slices.find((s) => s.name === "s");
      expect(nestedSlice).toBeDefined();
      const expectedSlicePath = path.join(currentAlias, "m", "slices", "s");
      const expectedPhysicalPath = path.join(outerPhysical, "m", "slices", "s");
      expect(nestedSlice?.slicePath).toBe(expectedSlicePath);
      expect(Object.prototype.hasOwnProperty.call(nestedSlice, "physicalSlicePath")).toBe(false);
      expect(nestedSlice?.childMissions).toMatchObject([{ id: "M.CHILD" }]);
      expect(nestedSlice?.readiness?.policy).toMatchObject({ judges: ["judge@outer"] });
      expect(nestedSlice?.readiness?.attention?.scope).toBe(expectedPhysicalPath);
      expect(indexer.missionTagKeys("m", expectedSlicePath)).toEqual(["m", "M.OUTER"]);

      // Uncached multi-root missionTagKeys after invalidation must also resolve through the winning root.
      indexer.invalidate();
      expect(indexer.missionTagKeys("m", expectedSlicePath)).toEqual(["m", "M.OUTER"]);
      expect(indexer.missionTagKeys("m", path.join(otherRoot, "m", "slices", "other-slice"))).toEqual(["m", "M.OTHER"]);
    });
  });

  describe("PR2902 JOIN001 hidden authored node metadata", () => {
    const readFailureVariants = [
      { nodeFile: "SPEC.md", code: "EACCES" },
      { nodeFile: "README.md", code: "EIO" },
    ] as const;

    function addCatalogOnlyFoo(): { defaultMissionsRoot: string; fooMissionsRoot: string } {
      catalog([{ id: "default", root: "." }, { id: "foo", root: "projects/foo" }]);
      const defaultMissionsRoot = addCatalogProject("default", ".");
      const fooMissionsRoot = addCatalogProject("foo", "projects/foo");
      configureCatalogRoute(defaultMissionsRoot);
      return { defaultMissionsRoot, fooMissionsRoot };
    }

    it.each(readFailureVariants)(
      "JOIN001 RED: returns unknown for a partial slice-ID row when hidden $nodeFile read fails ($code)",
      async ({ nodeFile, code }) => {
        const visiblePath = addSlice("alpha", "shipping", "shared", "active", "SLICE.SHARED");
        const hiddenPath = addSlice("beta", "shipping", "shared", "active", "SLICE.SHARED", { slice: nodeFile });
        if (nodeFile === "SPEC.md") write(path.join(hiddenPath, "README.md"), nodeBytes("SLICE.LEGACY"));
        row("hidden-slice-id-partial", "pending", ["slice:SLICE.SHARED"]);

        const { app } = route("alpha", false, path.join(root, "alpha", "missions"), [path.join(root, "beta", "missions")]);
        const observed = await withNodeReadFailure(path.join(hiddenPath, nodeFile), code, () => list(app));
        expect(observed.failureHits).toBeGreaterThan(0);
        expect(observed.result).toHaveLength(1);
        expect(observed.result[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: visiblePath });
        expect(observed.result[0]!.queueCounts).toBeNull();
        authoredUnchanged();
      },
    );

    it.each([
      {
        scenario: "readable collision",
        hiddenId: "SLICE.SHARED",
        hiddenNodeFile: "SPEC.md",
        expected: { pending: 0, "in-progress": 0, done: 0, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0 },
      },
      {
        scenario: "readable unique alias",
        hiddenId: "SLICE.HIDDEN",
        hiddenNodeFile: "SPEC.md",
        expected: { pending: 1, "in-progress": 0, done: 0, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0 },
      },
      {
        scenario: "genuinely absent optional node",
        hiddenId: "unused-without-node",
        hiddenNodeFile: null,
        expected: { pending: 1, "in-progress": 0, done: 0, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0 },
      },
    ])("keeps slice-ID control behavior for a $scenario", async ({ hiddenId, hiddenNodeFile, expected }) => {
      const visiblePath = addSlice("alpha", "shipping", "shared", "active", "SLICE.SHARED");
      const hiddenPath = addSlice("beta", "shipping", "shared", "active", hiddenId, { slice: hiddenNodeFile });
      row("slice-id-control", "pending", ["slice:SLICE.SHARED"]);

      const { app } = route("alpha", false, path.join(root, "alpha", "missions"), [path.join(root, "beta", "missions")]);
      const entries = await list(app);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: visiblePath });
      expect(entries[0]!.slicePath).not.toBe(hiddenPath);
      expect(entries[0]!.queueCounts).toEqual(expected);
      authoredUnchanged();
    });

    it.each(readFailureVariants)(
      "JOIN001 RED: returns unknown for a partial mission-ID row when catalog-only hidden $nodeFile read fails ($code)",
      async ({ nodeFile, code }) => {
        const { defaultMissionsRoot, fooMissionsRoot } = addCatalogOnlyFoo();
        const visiblePath = addSlice(".", "shipping", "shared", "active", "SLICE.SHARED", { missionId: "M.SHARED" });
        addSlice("projects/foo", "shipping", "shared", "active", "SLICE.SHARED", { mission: nodeFile, missionId: "M.SHARED" });
        if (nodeFile === "SPEC.md") write(path.join(fooMissionsRoot, "shipping", "README.md"), nodeBytes("M.LEGACY"));
        row("hidden-mission-id-partial", "pending", ["mission:M.SHARED", "slice:shared"]);

        const { app } = route("default", false, defaultMissionsRoot, [path.join(root, "slices")]);
        const hiddenMissionFile = path.join(fooMissionsRoot, "shipping", nodeFile);
        const observed = await withNodeReadFailure(hiddenMissionFile, code, () => list(app));
        expect(observed.failureHits).toBeGreaterThan(0);
        expect(observed.result).toHaveLength(1);
        expect(observed.result[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: visiblePath });
        expect(observed.result[0]!.queueCounts).toBeNull();
        authoredUnchanged();
      },
    );

    it.each([
      {
        scenario: "readable collision",
        hiddenMissionId: "M.SHARED",
        hiddenMissionFile: "SPEC.md",
        expected: { pending: 0, "in-progress": 0, done: 0, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0 },
      },
      {
        scenario: "readable unique alias",
        hiddenMissionId: "M.HIDDEN",
        hiddenMissionFile: "SPEC.md",
        expected: { pending: 1, "in-progress": 0, done: 0, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0 },
      },
      {
        scenario: "genuinely absent optional mission node",
        hiddenMissionId: "unused-without-node",
        hiddenMissionFile: null,
        expected: { pending: 1, "in-progress": 0, done: 0, blocked: 0, failed: 0, denied: 0, canceled: 0, "handed-off": 0 },
      },
    ])("keeps mission-ID control behavior for a $scenario", async ({ hiddenMissionId, hiddenMissionFile, expected }) => {
      const { defaultMissionsRoot } = addCatalogOnlyFoo();
      const visiblePath = addSlice(".", "shipping", "shared", "active", "SLICE.SHARED", { missionId: "M.SHARED" });
      addSlice("projects/foo", "shipping", "shared", "active", "SLICE.SHARED", {
        mission: hiddenMissionFile,
        missionId: hiddenMissionId,
      });
      row("mission-id-control", "pending", ["mission:M.SHARED", "slice:shared"]);

      const { app } = route("default", false, defaultMissionsRoot, [path.join(root, "slices")]);
      const entries = await list(app);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: visiblePath });
      expect(entries[0]!.queueCounts).toEqual(expected);
      authoredUnchanged();
    });

    it("JOIN001 RED: does not let an inaccessible hidden SPEC fall through to a unique legacy README ID", async () => {
      const visiblePath = addSlice("alpha", "shipping", "shared", "active", "SLICE.SHARED");
      const hiddenPath = addSlice("beta", "shipping", "shared", "active", "SLICE.SHARED");
      write(path.join(hiddenPath, "README.md"), nodeBytes("SLICE.LEGACY"));
      row("hidden-spec-selection-partial", "pending", ["slice:SLICE.SHARED"]);

      const { app } = route("alpha", false, path.join(root, "alpha", "missions"), [path.join(root, "beta", "missions")]);
      const observed = await withNodeSelectionFailure(path.join(hiddenPath, "SPEC.md"), "EACCES", () => list(app));
      expect(observed.failureHits).toBeGreaterThan(0);
      expect(observed.result).toHaveLength(1);
      expect(observed.result[0]).toMatchObject({ name: "shared", missionId: "shipping", slicePath: visiblePath });
      expect(observed.result[0]!.queueCounts).toBeNull();
      authoredUnchanged();
    });
  });
});
