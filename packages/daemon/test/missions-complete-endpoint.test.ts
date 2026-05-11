// Slice 18 §3.5 — POST /api/missions/:missionId/complete tests.
//
// The endpoint writes `status: complete` to the mission's README.md
// frontmatter. Powers the Mark-complete action on storytelling cards
// (Getting Started complete-and-hide flow). Behavior:
//  - 200 + { missionId, status: "complete" } on success
//  - Creates the frontmatter block when README has no frontmatter
//  - Updates an existing status: X line in place
//  - Adds a status line when frontmatter exists but lacks status
//  - 404 when mission doesn't exist
//  - Idempotent: calling complete twice still succeeds

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

function writeMissionReadme(
  missionsRoot: string,
  missionId: string,
  body: string,
): void {
  const dir = path.join(missionsRoot, missionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), body);
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

let cleanupRoot: string;
let missionsRoot: string;
let indexer: SliceIndexer;

beforeEach(() => {
  cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "missions-complete-"));
  missionsRoot = path.join(cleanupRoot, "missions");
  fs.mkdirSync(missionsRoot, { recursive: true });
  indexer = new SliceIndexer({ slicesRoot: missionsRoot });
});

afterEach(() => {
  fs.rmSync(cleanupRoot, { recursive: true, force: true });
});

describe("POST /api/missions/:missionId/complete", () => {
  it("updates existing status: active to status: complete in README frontmatter", async () => {
    writeMissionReadme(
      missionsRoot,
      "getting-started",
      "---\nid: getting-started\nstatus: active\n---\n# Getting Started\n",
    );
    writeSliceInMission(missionsRoot, "getting-started", "intro");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/getting-started/complete", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { missionId: string; status: string };
    expect(body.missionId).toBe("getting-started");
    expect(body.status).toBe("complete");

    const readme = fs.readFileSync(path.join(missionsRoot, "getting-started", "README.md"), "utf-8");
    expect(readme).toContain("status: complete");
    expect(readme).not.toContain("status: active");
  });

  it("adds status: complete to frontmatter when status field absent", async () => {
    writeMissionReadme(
      missionsRoot,
      "demo-mission",
      "---\nid: demo-mission\n---\n# Demo Mission\n",
    );
    writeSliceInMission(missionsRoot, "demo-mission", "first");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/demo-mission/complete", { method: "POST" });

    expect(res.status).toBe(200);
    const readme = fs.readFileSync(path.join(missionsRoot, "demo-mission", "README.md"), "utf-8");
    expect(readme).toContain("status: complete");
    expect(readme).toContain("id: demo-mission");
  });

  it("creates a frontmatter block when README has no frontmatter at all", async () => {
    writeMissionReadme(missionsRoot, "no-fm", "# A mission with no frontmatter\n");
    writeSliceInMission(missionsRoot, "no-fm", "only-slice");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/no-fm/complete", { method: "POST" });

    expect(res.status).toBe(200);
    const readme = fs.readFileSync(path.join(missionsRoot, "no-fm", "README.md"), "utf-8");
    expect(readme.startsWith("---\n")).toBe(true);
    expect(readme).toContain("status: complete");
    expect(readme).toContain("# A mission with no frontmatter");
  });

  it("is idempotent — calling complete twice still returns 200 and status stays complete", async () => {
    writeMissionReadme(
      missionsRoot,
      "idempotent-mission",
      "---\nid: idempotent-mission\nstatus: active\n---\n# Body\n",
    );
    writeSliceInMission(missionsRoot, "idempotent-mission", "s");

    const app = buildApp(indexer);
    const res1 = await app.request("/api/missions/idempotent-mission/complete", { method: "POST" });
    expect(res1.status).toBe(200);
    const res2 = await app.request("/api/missions/idempotent-mission/complete", { method: "POST" });
    expect(res2.status).toBe(200);

    const readme = fs.readFileSync(path.join(missionsRoot, "idempotent-mission", "README.md"), "utf-8");
    const occurrences = (readme.match(/status: complete/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("GET /api/missions/:missionId returns status from frontmatter (slice 18 status surfacing)", async () => {
    writeMissionReadme(
      missionsRoot,
      "has-status",
      "---\nid: has-status\nstatus: complete\n---\n# body\n",
    );
    writeSliceInMission(missionsRoot, "has-status", "s");
    const app = buildApp(indexer);
    const res = await app.request("/api/missions/has-status", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string | null };
    expect(body.status).toBe("complete");
  });

  it("GET /api/missions/:missionId returns status=null when frontmatter has no status field", async () => {
    writeMissionReadme(
      missionsRoot,
      "no-status",
      "---\nid: no-status\n---\n# body\n",
    );
    writeSliceInMission(missionsRoot, "no-status", "s");
    const app = buildApp(indexer);
    const res = await app.request("/api/missions/no-status", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string | null };
    expect(body.status).toBeNull();
  });

  it("after POST complete, subsequent GET returns status=complete (durable round-trip)", async () => {
    writeMissionReadme(
      missionsRoot,
      "round-trip",
      "---\nid: round-trip\nstatus: active\n---\n# body\n",
    );
    writeSliceInMission(missionsRoot, "round-trip", "s");
    const app = buildApp(indexer);

    const before = await app.request("/api/missions/round-trip", { method: "GET" });
    const beforeBody = (await before.json()) as { status: string | null };
    expect(beforeBody.status).toBe("active");

    const post = await app.request("/api/missions/round-trip/complete", { method: "POST" });
    expect(post.status).toBe(200);

    const after = await app.request("/api/missions/round-trip", { method: "GET" });
    const afterBody = (await after.json()) as { status: string | null };
    expect(afterBody.status).toBe("complete");
  });

  it("returns 404 when mission does not exist", async () => {
    const app = buildApp(indexer);
    const res = await app.request("/api/missions/nonexistent-mission/complete", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mission_not_found");
  });

  it("returns 503 when SliceIndexer is unavailable", async () => {
    const app = new Hono();
    app.route("/api/missions", missionsRoutes());
    const res = await app.request("/api/missions/anything/complete", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("preserves unrelated frontmatter fields when updating status", async () => {
    writeMissionReadme(
      missionsRoot,
      "preserves",
      "---\nid: preserves\nworkflow_spec: my-workflow@1\nstatus: active\nlabel: keep me\n---\n# Body\n",
    );
    writeSliceInMission(missionsRoot, "preserves", "s");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/preserves/complete", { method: "POST" });
    expect(res.status).toBe(200);

    const readme = fs.readFileSync(path.join(missionsRoot, "preserves", "README.md"), "utf-8");
    expect(readme).toContain("workflow_spec: my-workflow@1");
    expect(readme).toContain("label: keep me");
    expect(readme).toContain("status: complete");
    expect(readme).toContain("id: preserves");
  });
});
