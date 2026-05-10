// Workflows in Spec Library + Activation Lens v0 — route-level tests.
//
// Covers active-lens GET/POST/DELETE + workflow-kind library entry +
// /:id/review for workflow entries.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { ActiveLensStore } from "../src/domain/active-lens-store.js";
import { specLibraryRoutes } from "../src/routes/spec-library.js";

const SAMPLE_SPEC = (id: string) => `workflow:
  id: ${id}
  version: 1
  objective: Sample workflow
  target:
    rig: sample-rig
  entry:
    role: alpha
  roles:
    alpha:
      preferred_targets:
        - alpha@sample-rig
    beta:
      preferred_targets:
        - beta@sample-rig
  steps:
    - id: step-1
      actor_role: alpha
      objective: Start.
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - beta
    - id: step-2
      actor_role: beta
      objective: End.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
`;

describe("workflow library routes (Workflows in Spec Library v0)", () => {
  let db: Database.Database;
  let tmp: string;
  let lensFilePath: string;
  let builtinDir: string;
  let cache: WorkflowSpecCache;
  let lib: SpecLibraryService;
  let lensStore: ActiveLensStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-lib-routes-"));
    builtinDir = join(tmp, "builtins", "workflow-specs");
    mkdirSync(builtinDir, { recursive: true });
    lensFilePath = join(tmp, "active-workflow-lens.json");

    const svc = new SpecReviewService();
    lib = new SpecLibraryService({ roots: [], specReviewService: svc });
    lib.scan();

    lensStore = new ActiveLensStore({ filePath: lensFilePath });
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function createApp(): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("specLibraryService" as never, lib);
      c.set("specReviewService" as never, new SpecReviewService());
      c.set("activeLensStore" as never, lensStore);
      c.set("rigRepo" as never, { db });
      c.set("workflowBuiltinSpecsDir" as never, builtinDir);
      await next();
    });
    app.route("/api/specs/library", specLibraryRoutes());
    return app;
  }

  it("GET /active-lens returns null when no lens is set", async () => {
    const app = createApp();
    const res = await app.request("/api/specs/library/active-lens");
    expect(res.status).toBe(200);
    const body = await res.json() as { activeLens: unknown };
    expect(body.activeLens).toBeNull();
  });

  it("POST /active-lens persists the lens; GET /active-lens returns it", async () => {
    const app = createApp();
    const post = await app.request("/api/specs/library/active-lens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specName: "conveyor", specVersion: "1" }),
    });
    expect(post.status).toBe(200);
    const postBody = await post.json() as { activeLens: { specName: string } };
    expect(postBody.activeLens.specName).toBe("conveyor");

    const get = await app.request("/api/specs/library/active-lens");
    const getBody = await get.json() as { activeLens: { specName: string; specVersion: string } };
    expect(getBody.activeLens.specName).toBe("conveyor");
    expect(getBody.activeLens.specVersion).toBe("1");
  });

  it("POST /active-lens 400s when specName/specVersion missing", async () => {
    const app = createApp();
    const res = await app.request("/api/specs/library/active-lens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specName: "conveyor" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /active-lens clears it", async () => {
    const app = createApp();
    lensStore.set("foo", "1");
    const del = await app.request("/api/specs/library/active-lens", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(lensStore.get()).toBeNull();
  });

  it("GET / surfaces workflow entries from the workflow_specs cache", async () => {
    const path = join(builtinDir, "alpha.yaml");
    writeFileSync(path, SAMPLE_SPEC("alpha"));
    cache.readThrough(path);

    const app = createApp();
    const res = await app.request("/api/specs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; kind: string; name: string; sourceType: string; isBuiltIn?: boolean }>;
    const entry = body.find((e) => e.kind === "workflow")!;
    expect(entry).toBeDefined();
    expect(entry.id).toBe("workflow:alpha:1");
    expect(entry.sourceType).toBe("builtin");
    expect(entry.isBuiltIn).toBe(true);
  });

  it("GET /:id/review returns the topology graph for workflow entries", async () => {
    const path = join(builtinDir, "alpha.yaml");
    writeFileSync(path, SAMPLE_SPEC("alpha"));
    cache.readThrough(path);

    const app = createApp();
    const res = await app.request("/api/specs/library/workflow:alpha:1/review");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      kind: string;
      libraryEntryId: string;
      topology: { nodes: unknown[]; edges: Array<{ fromStepId: string; toStepId: string }> };
      steps: Array<{ stepId: string }>;
    };
    expect(body.kind).toBe("workflow");
    expect(body.libraryEntryId).toBe("workflow:alpha:1");
    expect(body.topology.nodes).toHaveLength(2);
    expect(body.topology.edges).toEqual([
      { fromStepId: "step-1", toStepId: "step-2", routingType: "direct" },
    ]);
    expect(body.steps.map((s) => s.stepId)).toEqual(["step-1", "step-2"]);
  });

  it("GET /:id/review 404s for an unknown workflow id", async () => {
    const app = createApp();
    const res = await app.request("/api/specs/library/workflow:missing:1/review");
    expect(res.status).toBe(404);
  });
});
