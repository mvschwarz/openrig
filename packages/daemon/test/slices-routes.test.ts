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
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (catalogReadObservation.activePath !== null && String(args[0]) === catalogReadObservation.activePath) {
        catalogReadObservation.reads++;
      }
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
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
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { slicesRoutes } from "../src/routes/slices.js";
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
    db.close();
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  });

  describe("GET /api/slices (list)", () => {
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

    it.each([
      { project: "alpha", literal: "# alpha/a-first\n" },
      { project: "beta", literal: "# beta/a-first\n" },
    ])("detail selects $project independently and has no qualified proof discovery", async ({ project, literal }) => {
      const detail = await app.request(`/api/slices/same-slice?project=${project}&mission=a-first`);
      expect(detail.status).toBe(200);
      const body = await detail.json();
      expect(body.slicePath).toBe(path.join(workspaceRoot, project, "missions/a-first/slices/same-slice"));
      expect(fs.readFileSync(path.join(body.slicePath, "SPEC.md"), "utf8")).toBe(literal);
      expect(body.missionId).toBe("a-first");
      expect(body.tests.proofPackets).toEqual([]);
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

    it.each(["alpha", "beta"])("qualified proof for %s does not substitute the injected legacy packet", async (project) => {
      const response = await app.request(`/api/slices/same-slice/proof-asset/screenshots/scope.png?project=${project}&mission=a-first`);
      expect({ status: response.status, text: await response.text() }).toEqual({
        status: 404, text: JSON.stringify({ error: "proof_packet_not_found" }),
      });
    });

    it("records detail's existing later-duplicate mission absence without inventing a successful lookup", async () => {
      expect(fs.readFileSync(path.join(workspaceRoot, "alpha/missions/z-later/slices/same-slice/SPEC.md"), "utf8")).toBe("# alpha/z-later\n");
      const detail = await app.request("/api/slices/same-slice?project=alpha&mission=z-later");
      expect(detail.status).toBe(404);
      expect(await detail.json()).toEqual({ error: "slice_not_found", name: "same-slice" });
    });

    it("doc preserves the detail route's current missing later-duplicate selection", async () => {
      const response = await app.request("/api/slices/same-slice/doc/SPEC.md?project=alpha&mission=z-later");
      const body = await response.json();
      expect({ status: response.status, content: body.content }).toEqual({ status: 404, content: undefined });
      expect(body).toEqual({ error: "doc_not_found" });
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
  type Entry = { name: string; missionId: string | null; slicePath: string; status: string; rawStatus: string | null; qitemCount: number; queueCounts?: Counts | null };
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

  function addSlice(project: string, mission: string, name: string, status = "active", id = name): string {
    const missionRoot = path.join(root, project, "missions", mission);
    write(path.join(missionRoot, "SPEC.md"), `---\nid: M.${mission.toUpperCase()}\nstatus: active\n---\n# Mission\n`);
    const dir = path.join(missionRoot, "slices", name);
    write(path.join(dir, "SPEC.md"), `---\nid: ${id}\nstatus: ${status}\n---\n# Slice\n`);
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), "slice-counts-"));
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

    const { app, indexer } = route("foo", false, fooMissionsRoot, [defaultMissionsRoot]);
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
    const entries = await list(route("alpha", false, slicesRoot).app);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.qitemCount).toBe(0);
    expect(entries[0]!.queueCounts).toBeNull();
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
});
