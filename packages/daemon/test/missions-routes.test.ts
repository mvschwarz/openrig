// V0.3.1 slice 12 walk-item 1 — mission scope data layer.
//
// GET /api/missions/:missionId returns aggregated mission metadata:
//   - missionId: echo of the requested id
//   - missionPath: absolute filesystem path of the mission folder
//                  (the parent of the slices folder containing the
//                  matched slices)
//   - slices: SliceListEntry[] filtered to entries with this missionId
//
// The route does NOT itself read README.md / PROGRESS.md content —
// the UI fetches those via the existing /api/files/read route through
// the generalized useScopeMarkdown hook. This route is the mission
// METADATA layer; the file content layer is reused.

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
import { missionsRoutes } from "../src/routes/missions.js";

function buildApp(indexer: SliceIndexer): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, indexer);
    await next();
  });
  app.route("/api/missions", missionsRoutes());
  return app;
}

function writeSliceInMission(
  missionsRoot: string,
  missionId: string,
  sliceName: string,
  frontmatter: Record<string, string> = {},
): void {
  const dir = path.join(missionsRoot, missionId, "slices", sliceName);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `---\n${fm}\n---\n# ${sliceName}\n`,
  );
}

let db: Database.Database;
let cleanupRoot: string;
let missionsRoot: string;
let indexer: SliceIndexer;
let app: Hono;

beforeEach(() => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
  cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "missions-routes-"));
  missionsRoot = path.join(cleanupRoot, "missions");
  fs.mkdirSync(missionsRoot, { recursive: true });
  indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
  app = buildApp(indexer);
});

afterEach(() => {
  db.close();
  fs.rmSync(cleanupRoot, { recursive: true, force: true });
});

describe("GET /api/missions/:missionId", () => {
  it("returns 200 with missionPath + slices filtered to the requested mission", async () => {
    writeSliceInMission(missionsRoot, "getting-started", "first-slice", { status: "active" });
    writeSliceInMission(missionsRoot, "getting-started", "second-slice", { status: "done" });
    writeSliceInMission(missionsRoot, "other-mission", "third-slice", { status: "active" });

    const res = await app.request("/api/missions/getting-started");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      missionId: string;
      missionPath: string;
      slices: Array<{ name: string; missionId: string }>;
    };
    expect(body.missionId).toBe("getting-started");
    expect(body.missionPath).toBe(path.join(missionsRoot, "getting-started"));
    expect(body.slices.map((s) => s.name).sort()).toEqual(["first-slice", "second-slice"]);
    expect(body.slices.every((s) => s.missionId === "getting-started")).toBe(true);
  });

  it("returns 404 when no slices exist for the missionId", async () => {
    writeSliceInMission(missionsRoot, "getting-started", "first-slice", { status: "active" });

    const res = await app.request("/api/missions/unknown-mission");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mission_not_found");
  });

  it("returns 503 when the indexer isn't wired", async () => {
    const bareApp = new Hono();
    bareApp.route("/api/missions", missionsRoutes());
    const res = await bareApp.request("/api/missions/anything");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slices_indexer_unavailable");
  });

  it("returns 503 when the indexer is not ready (slices root not configured)", async () => {
    const emptyIndexer = new SliceIndexer({
      slicesRoot: "",
      dogfoodEvidenceRoot: null,
      db,
    });
    const emptyApp = buildApp(emptyIndexer);
    const res = await emptyApp.request("/api/missions/getting-started");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slices_root_not_configured");
  });

  it("only counts slices with the exact missionId (no substring match)", async () => {
    writeSliceInMission(missionsRoot, "release-0.3.1", "slice-a", { status: "active" });
    writeSliceInMission(missionsRoot, "release-0.3.1-followup", "slice-b", { status: "active" });

    const res = await app.request("/api/missions/release-0.3.1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slices: Array<{ name: string }> };
    expect(body.slices.map((s) => s.name)).toEqual(["slice-a"]);
  });
});
