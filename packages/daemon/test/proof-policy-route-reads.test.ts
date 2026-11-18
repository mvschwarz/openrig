// #3354 item 3: GET /api/missions/:id and GET /api/slices read the shared
// proofPolicy manifests once per request, through one request-local
// createProofPolicyRead(), and read them again on the next request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { readMissionReadiness, readProjectReadinessAsync, readSliceReadiness } from "../src/domain/proof/judgments.js";
import { missionsRoutes } from "../src/routes/missions.js";
import { slicesRoutes } from "../src/routes/slices.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let db: Database.Database;
let root: string;
let missions: string;
let projectFile: string;
let missionFile: string;
let sliceDirs: string[];
let app: Hono;

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : YAML.stringify(value));
}

beforeEach(() => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "policy-route-reads-")));
  missions = path.join(root, "missions");
  projectFile = path.join(root, "project.yaml");
  missionFile = path.join(missions, "trial", "mission.yaml");
  write(projectFile, { proofPolicy: { judges: ["judge@trial"] } });
  sliceDirs = Array.from({ length: 6 }, (_, i) => path.join(missions, "trial", "slices", `slice-${i}`));
  write(missionFile, {
    kind: "mission",
    metadata: { status: "active" },
    composition: { slices: sliceDirs.map((d, order) => ({ ref: `slices/${path.basename(d)}/slice.yaml`, order: order + 1, active: true })) },
  });
  for (const dir of sliceDirs) {
    write(path.join(dir, "slice.yaml"), { metadata: { id: path.basename(dir) } });
    write(path.join(dir, "README.md"), `---\nstatus: active\n---\n# ${path.basename(dir)}\n`);
    write(path.join(dir, "SPEC.md"), "# Outcome\n\n## Proof contract\n- [ ] Observed outcome.\n");
  }
  const indexer = new SliceIndexer({ slicesRoot: missions, dogfoodEvidenceRoot: null, db });
  const projector = new SliceDetailProjector({ db, indexer });
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, indexer);
    c.set("sliceDetailProjector" as never, projector);
    await next();
  });
  app.route("/api/missions", missionsRoutes());
  app.route("/api/slices", slicesRoutes());
});

afterEach(() => {
  vi.mocked(fs.readFileSync).mockClear();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const projectReads = () => vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => file === projectFile).length;

async function getJson(url: string) {
  const response = await app.request(url);
  expect(response.status).toBe(200);
  return (await response.json()) as any;
}

describe("one proof-policy read per request (#3354)", () => {
  it("GET /api/missions/:id reads the shared project policy once, keeps today's readiness and reads it again next request", async () => {
    // Today's (uncached) readiness, before counting.
    const mission = readMissionReadiness(path.join(missions, "trial"));
    const slices = new Map(sliceDirs.map(d => [d, readSliceReadiness(d)]));
    expect(mission.issues).toEqual([]);
    expect([...slices.values()].every(r => r.policy?.judges?.join() === "judge@trial")).toBe(true);

    vi.mocked(fs.readFileSync).mockClear();
    const first = await getJson("/api/missions/trial");
    expect(first.readiness).toEqual(mission);
    expect(first.slices).toHaveLength(sliceDirs.length);
    for (const s of first.slices) expect(s.readiness).toEqual(slices.get(s.slicePath));
    expect(projectReads()).toBe(1);

    // Request-local: the next request reads the manifest again and sees a change.
    write(projectFile, { proofPolicy: { judges: ["judge@trial", "second@trial"] } });
    vi.mocked(fs.readFileSync).mockClear();
    const second = await getJson("/api/missions/trial");
    expect(projectReads()).toBe(1);
    for (const s of second.slices) expect(s.readiness.policy.judges).toEqual(["judge@trial", "second@trial"]);
  });

  it("GET /api/slices reads the shared project policy once across the listing and the project readiness, and again next request", async () => {
    const slices = new Map(sliceDirs.map(d => [d, readSliceReadiness(d)]));
    const project = await readProjectReadinessAsync(missions);

    vi.mocked(fs.readFileSync).mockClear();
    const first = await getJson("/api/slices");
    expect(first.slices).toHaveLength(sliceDirs.length);
    for (const s of first.slices) expect(s.readiness).toEqual(slices.get(s.slicePath));
    expect(first.missions.trial.readiness).toEqual(project.missions.find(m => m.name === "trial"));
    expect(projectReads()).toBe(1);

    write(projectFile, { proofPolicy: { judges: ["other@trial"] } });
    vi.mocked(fs.readFileSync).mockClear();
    const second = await getJson("/api/slices");
    expect(projectReads()).toBe(1);
    for (const s of second.slices) expect(s.readiness.policy.judges).toEqual(["other@trial"]);
    expect(second.missions.trial.readiness).toEqual({ name: "trial", ...readMissionReadiness(path.join(missions, "trial")) });
  });
});
