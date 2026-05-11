// Slice 11 (workflow-spec-folder-discovery) — route-level TDD.
//
// GET /api/specs/library opportunistically scans
// <workspace.specs_root>/workflows/ when wired via context vars
// `workflowSpecCache` + `workflowsFolderDir`, then surfaces both
// valid + diagnostic rows alongside built-in starters (OQ-3).

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
import { workflowSpecsDiagnosticSchema } from "../src/db/migrations/040_workflow_specs_diagnostic.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { ActiveLensStore } from "../src/domain/active-lens-store.js";
import { specLibraryRoutes } from "../src/routes/spec-library.js";

const VALID_YAML = (id: string) => `workflow:
  id: ${id}
  version: '1'
  objective: Folder-scan fixture
  target:
    rig: folder-fix
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@folder-fix
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

const INVALID_YAML = `workflow:
  id: bad-spec
  # missing required version, roles, steps
  objective: This will not parse cleanly
`;

describe("spec-library route folder scan (slice 11)", () => {
  let db: Database.Database;
  let tmp: string;
  let folder: string;
  let builtinDir: string;
  let cache: WorkflowSpecCache;
  let lib: SpecLibraryService;
  let lensStore: ActiveLensStore;
  let lensFilePath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-folder-route-"));
    folder = join(tmp, "workflows");
    builtinDir = join(tmp, "builtins", "workflow-specs");
    mkdirSync(folder, { recursive: true });
    mkdirSync(builtinDir, { recursive: true });
    lensFilePath = join(tmp, "active-workflow-lens.json");

    lib = new SpecLibraryService({ roots: [], specReviewService: new SpecReviewService() });
    lib.scan();
    lensStore = new ActiveLensStore({ filePath: lensFilePath });
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function createApp(opts: { withFolder: boolean } = { withFolder: true }): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("specLibraryService" as never, lib);
      c.set("specReviewService" as never, new SpecReviewService());
      c.set("activeLensStore" as never, lensStore);
      c.set("rigRepo" as never, { db });
      c.set("workflowBuiltinSpecsDir" as never, builtinDir);
      c.set("workflowSpecCache" as never, cache);
      if (opts.withFolder) c.set("workflowsFolderDir" as never, folder);
      await next();
    });
    app.route("/api/specs/library", specLibraryRoutes());
    return app;
  }

  it("GET / triggers folder scan and surfaces valid YAML as a workflow entry", async () => {
    writeFileSync(join(folder, "good.yaml"), VALID_YAML("good-spec"));
    const app = createApp();
    const res = await app.request("/api/specs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; kind: string; name: string }>;
    const entry = body.find((e) => e.kind === "workflow" && e.name === "good-spec");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("workflow:good-spec:1");
  });

  it("GET / surfaces invalid YAML as a diagnostic workflow entry", async () => {
    writeFileSync(join(folder, "broken.yaml"), INVALID_YAML);
    const app = createApp();
    const res = await app.request("/api/specs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{
      id: string;
      kind: string;
      name: string;
      status?: string;
      errorMessage?: string | null;
    }>;
    const diag = body.find((e) => e.kind === "workflow" && e.id.startsWith("workflow:error:"));
    expect(diag).toBeDefined();
    expect(diag?.status).toBe("error");
    expect(diag?.errorMessage).toBeTruthy();
    expect(diag?.name).toBe("broken.yaml");
  });

  it("GET / removes diagnostic row after the file disappears (OQ-4)", async () => {
    const brokenPath = join(folder, "broken.yaml");
    writeFileSync(brokenPath, INVALID_YAML);
    let app = createApp();
    let res = await app.request("/api/specs/library");
    let body = await res.json() as Array<{ id: string }>;
    expect(body.some((e) => e.id.startsWith("workflow:error:"))).toBe(true);

    rmSync(brokenPath);
    app = createApp();
    res = await app.request("/api/specs/library");
    body = await res.json() as Array<{ id: string }>;
    expect(body.some((e) => e.id.startsWith("workflow:error:"))).toBe(false);
  });

  it("GET / is a no-op for the folder scan when workflowsFolderDir is not set", async () => {
    writeFileSync(join(folder, "good.yaml"), VALID_YAML("ghost-spec"));
    const app = createApp({ withFolder: false });
    const res = await app.request("/api/specs/library");
    const body = await res.json() as Array<{ name: string }>;
    expect(body.some((e) => e.name === "ghost-spec")).toBe(false);
  });

  it("drift-discriminator: valid + invalid + previously-removed in single response", async () => {
    // Pre-seed a diagnostic for a file that no longer exists.
    cache.writeDiagnostic({
      sourcePath: join(folder, "previously-here.yaml"),
      sourceHash: "h",
      errorMessage: "stale",
    });
    writeFileSync(join(folder, "good.yaml"), VALID_YAML("disc-good"));
    writeFileSync(join(folder, "bad.yaml"), INVALID_YAML);
    const app = createApp();
    const res = await app.request("/api/specs/library");
    const body = await res.json() as Array<{
      id: string;
      name: string;
      kind: string;
      status?: string;
    }>;
    expect(body.some((e) => e.name === "disc-good")).toBe(true);
    expect(body.some((e) => e.name === "bad.yaml" && e.status === "error")).toBe(true);
    expect(body.some((e) => e.id === `workflow:error:${join(folder, "previously-here.yaml")}`)).toBe(false);
  });
});
