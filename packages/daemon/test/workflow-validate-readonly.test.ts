// #2726: `rig workflow validate` / POST /api/workflow/validate must be READ-ONLY.
// It validates the file in memory with the same checks it runs today and never
// writes workflow_specs: no INSERT of a new id@version, no UPDATE of a
// registered name@version (from another path, or from the same path after the
// file was edited in place). instantiate (and `rig workflow
// run`, which posts to the same /instantiate route) and the workflows-folder
// scan keep registering specs as today.
//
// Golden fixtures under fixtures/workflow-validate-readonly/ are a real capture
// of rig 0.7.9 (isolated daemon, 2026-11-08): the spec files the capture used
// and the validate output it printed, with the temp root as "<TMP>".
//
// The test sets state up through the entry points that register today
// (specCache.readThrough, scanWorkflowSpecFolder); what it asserts is only the
// HTTP routes and the workflow_specs rows.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { scanWorkflowSpecFolder } from "../src/domain/spec-library-workflow-scanner.js";
import { workflowRoutes } from "../src/routes/workflow.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workflow-validate-readonly");
const fixture = (name: string): string => join(FIXTURES, name);
const realJson = (name: string): unknown => JSON.parse(readFileSync(fixture(name), "utf-8"));

const REGISTERED = "wf-validate-ro";
const NEW_ID = "wf-validate-ro-new";

function buildApp(runtime: WorkflowRuntime, bus: EventBus): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, bus);
    c.set("workflowRuntime" as never, runtime);
    await next();
  });
  app.route("/api/workflow", workflowRoutes());
  return app;
}

describe("#2726 workflow validate is read-only", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let tmp: string;
  // Same layout the real capture used: <TMP>/specs-a/spec.workflow.yaml,
  // <TMP>/specs-b/spec.workflow.yaml (same id@version, other bytes),
  // <TMP>/specs-b/new.workflow.yaml (a new id@version).
  let specA: string;
  let specB: string;
  let specNew: string;

  const post = (path: string, body: unknown) =>
    app.request(`/api/workflow${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const validate = (specPath: string) => post("/validate", { specPath });
  const instantiate = (specPath: string) =>
    post("/instantiate", { specPath, rootObjective: "validate read-only", createdBySession: "ops@rig" });
  /** The whole registry, every column, in a stable order. */
  const registry = () => db.prepare(`SELECT * FROM workflow_specs ORDER BY name, version, spec_id`).all();
  const rowsNamed = (name: string) =>
    db.prepare(`SELECT * FROM workflow_specs WHERE name = ?`).all(name) as Array<Record<string, unknown>>;
  const specsList = async () => {
    const res = await app.request("/api/workflow/specs");
    expect(res.status).toBe(200);
    return ((await res.json()) as { specs: Array<{ name: string; version: string; sourcePath: string }> }).specs;
  };
  const normalized = (body: unknown): unknown => JSON.parse(JSON.stringify(body).split(tmp).join("<TMP>"));

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS); // the shipped schema, like the real daemon
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp(runtime, bus);
    tmp = mkdtempSync(join(tmpdir(), "wf-validate-ro-"));
    mkdirSync(join(tmp, "specs-a"));
    mkdirSync(join(tmp, "specs-b"));
    specA = join(tmp, "specs-a", "spec.workflow.yaml");
    specB = join(tmp, "specs-b", "spec.workflow.yaml");
    specNew = join(tmp, "specs-b", "new.workflow.yaml");
    copyFileSync(fixture("spec-a.workflow.yaml"), specA);
    copyFileSync(fixture("spec-b.workflow.yaml"), specB);
    copyFileSync(fixture("spec-b.new.workflow.yaml"), specNew);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fixtures are the real capture: B has the same id@version as A with other bytes", () => {
    const a = readFileSync(specA, "utf-8");
    const b = readFileSync(specB, "utf-8");
    expect(b).not.toBe(a);
    expect(a).toContain(`id: ${REGISTERED}`);
    expect(b).toContain(`id: ${REGISTERED}`);
    expect(readFileSync(specNew, "utf-8")).toContain(`id: ${NEW_ID}`);
  });

  // ---- golden: no write ---------------------------------------------------

  it("validating a draft with a registered name@version from another path and other bytes leaves the row untouched", async () => {
    runtime.specCache.readThrough(specA); // registered the way instantiate/scan register
    const before = registry();
    const [rowBefore] = rowsNamed(REGISTERED);
    expect(rowBefore.source_path).toBe(specA);

    const res = await validate(specB);

    expect(res.status).toBe(200);
    // Same output as today (real capture, rig 0.7.9).
    expect(normalized(await res.json())).toEqual(realJson("real-validate-b-same-id-other-bytes.json"));
    // The registered row keeps its content and its source_path.
    const [rowAfter] = rowsNamed(REGISTERED);
    expect(rowAfter.source_path).toBe(specA);
    expect(rowAfter.source_hash).toBe(rowBefore.source_hash);
    expect(rowAfter.spec_json).toBe(rowBefore.spec_json);
    expect(registry()).toEqual(before);
  });

  it("validating the registered file after it was edited in place (same path, other bytes) leaves the row untouched", async () => {
    runtime.specCache.readThrough(specB); // registered from specs-b, as in the real capture
    const before = registry();
    copyFileSync(specA, specB); // same path, same id@version, other bytes

    const res = await validate(specB);

    expect(res.status).toBe(200);
    expect(normalized(await res.json())).toEqual(realJson("real-validate-same-path-edited.json"));
    // No UPDATE of source_hash / spec_json / cached_at: the row stays as it was.
    expect(registry()).toEqual(before);
  });

  it("validating a new id@version inserts nothing (rig workflow specs does not change)", async () => {
    runtime.specCache.readThrough(specA);
    const before = registry();
    const listBefore = await specsList();

    const res = await validate(specNew);

    expect(res.status).toBe(200);
    expect(normalized(await res.json())).toEqual(realJson("real-validate-new.json"));
    expect(rowsNamed(NEW_ID)).toEqual([]);
    expect(registry()).toEqual(before);
    expect(await specsList()).toEqual(listBefore);
  });

  it("validating into an empty registry writes nothing, and the output is the real one", async () => {
    const res = await validate(specA);
    expect(res.status).toBe(200);
    expect(normalized(await res.json())).toEqual(realJson("real-validate-a.json"));
    expect(registry()).toEqual([]);
  });

  it("an invalid but parseable spec is reported and still not written", async () => {
    const bad = join(tmp, "specs-b", "invalid-validator.workflow.yaml");
    copyFileSync(fixture("invalid-validator.workflow.yaml"), bad);
    const res = await validate(bad);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(registry()).toEqual([]);
  });

  // ---- golden: same errors as today ---------------------------------------

  it("a missing file is still 404 spec_file_missing", async () => {
    const res = await validate(join(tmp, "specs-b", "missing.workflow.yaml"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("spec_file_missing");
  });

  it("an unknown top-level key is still rejected by the parser with the same error", async () => {
    const bad = join(tmp, "specs-b", "invalid-unknown-key.workflow.yaml");
    copyFileSync(fixture("invalid-unknown-key.workflow.yaml"), bad);
    const res = await validate(bad);
    expect({ status: res.status, error: ((await res.json()) as { error: string }).error }).toEqual(
      { status: 400, error: "spec_unknown_key" }, // frozen from main 220e27a9a
    );
  });

  it("validator errors are still reported with the same issues", async () => {
    const bad = join(tmp, "specs-b", "invalid-validator.workflow.yaml");
    copyFileSync(fixture("invalid-validator.workflow.yaml"), bad);
    const res = await validate(bad);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; issues: Array<{ code: string; field?: string; severity: string }> };
    expect(body.ok).toBe(false);
    expect(body.issues.map((i) => ({ code: i.code, field: i.field, severity: i.severity }))).toEqual(
      [
        // frozen from main 220e27a9a
        { code: "entry_role_mismatch", field: "workflow.entry.role", severity: "error" },
        { code: "step_actor_role_not_declared", field: "workflow.steps[0].actor_role", severity: "error" },
        { code: "role_no_live_preferred_target", field: "workflow.roles.producer.preferred_targets", severity: "warning" },
      ],
    );
  });

  // ---- golden: regression (instantiate / run / scan still register) --------

  it("instantiate (and run, same route) by path registers a new spec as today", async () => {
    const res = await instantiate(specNew);
    expect(res.status).toBe(201);
    const rows = rowsNamed(NEW_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_path).toBe(specNew);
    expect((await specsList()).map((s) => s.name)).toContain(NEW_ID);
  });

  it("instantiate from another path with other bytes updates the registered row as today", async () => {
    runtime.specCache.readThrough(specA);
    const hashA = rowsNamed(REGISTERED)[0].source_hash;
    const res = await instantiate(specB);
    expect(res.status).toBe(201);
    const rows = rowsNamed(REGISTERED);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_path).toBe(specB);
    expect(rows[0].source_hash).not.toBe(hashA);
  });

  it("the workflows-folder scan registers specs as today", () => {
    const folder = join(tmp, "workspace", "workflows");
    mkdirSync(folder, { recursive: true });
    copyFileSync(specA, join(folder, "spec.workflow.yaml"));
    const result = scanWorkflowSpecFolder({ db, cache: runtime.specCache, folder, builtinDir: null });
    expect(result.valid).toBe(1);
    expect(rowsNamed(REGISTERED).map((r) => r.source_path)).toEqual([join(folder, "spec.workflow.yaml")]);
  });

  // ---- maintainer's (b): only-validated spec outside the workflows folder ---

  it("(b) a spec only validated from outside the workflows folder is not listed and not found by bare name; its path still works", async () => {
    const folder = join(tmp, "workspace", "workflows");
    mkdirSync(folder, { recursive: true });
    copyFileSync(specA, join(folder, "spec.workflow.yaml"));
    scanWorkflowSpecFolder({ db, cache: runtime.specCache, folder, builtinDir: null });

    const v = await validate(specNew);
    expect(v.status).toBe(200);
    expect(((await v.json()) as { ok: boolean }).ok).toBe(true);

    const names = (await specsList()).map((s) => s.name);
    expect(names).toContain(REGISTERED);
    expect(names).not.toContain(NEW_ID);

    const byName = await instantiate(NEW_ID);
    expect(byName.status).toBe(404);
    expect(((await byName.json()) as { error: string }).error).toBe("spec_file_missing");

    const byPath = await instantiate(specNew);
    expect(byPath.status).toBe(201);
    expect(rowsNamed(NEW_ID).map((r) => r.source_path)).toEqual([specNew]);
  });
});
