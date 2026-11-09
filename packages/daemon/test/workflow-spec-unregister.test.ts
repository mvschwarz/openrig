// #2635: POST /api/workflow/specs/unregister takes a workflow spec out of the registry, by
// name[@version] or every version whose source file is gone (pruneMissing). A version that
// unfinished work is pinned to is never removed (#511), and a file still inside a scanned folder
// is kept, since the next scan would register it again.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { scanWorkflowSpecs } from "../src/domain/spec-library-workflow-scanner.js";
import { workflowRoutes } from "../src/routes/workflow.js";

const spec = (id: string, version: string) => `workflow:
  id: ${id}
  version: '${version}'
  objective: unregister fixture
  entry:
    role: anyone
  roles:
    anyone:
      preferred_targets:
        - anyone@rig
    next:
      preferred_targets:
        - next@rig
  steps:
    - id: act
      actor_role: anyone
      allowed_exits:
        - handoff
    - id: follow
      actor_role: next
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
`;

type Row = { name: string; version: string; sourcePath: string };
type Body = { removed: Row[]; kept: Array<Row & { reason: string }>; error?: string };

describe("POST /api/workflow/specs/unregister (#2635)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let root: string;
  let scratch: string;
  let workflowsFolder: string;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
    root = mkdtempSync(join(tmpdir(), "wf-unregister-"));
    scratch = join(root, "scratch");
    workflowsFolder = join(root, "workspace", "workflows");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(workflowsFolder, { recursive: true });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("workflowRuntime" as never, runtime);
      c.set("eventBus" as never, bus);
      c.set("workflowsFolderDir" as never, workflowsFolder);
      await next();
    });
    app.route("/api/workflow", workflowRoutes());
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  const register = (dir: string, file: string, id: string, version: string) => {
    const path = join(dir, file);
    writeFileSync(path, spec(id, version));
    // Register the way instantiate and the folder scan do; validate is read-only since #2726.
    runtime.specCache.readThrough(path);
    return path;
  };
  const unregister = async (body: Record<string, unknown>) => {
    const res = await app.request("/api/workflow/specs/unregister", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  const registered = () => runtime.specCache.listAll().map((row) => `${row.name}@${row.version}`).sort();
  const library = () => scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: null }).map((entry) => `${entry.name}@${entry.version}`).sort();
  const removedEvents = () => (db.prepare(`SELECT payload FROM events WHERE type = 'workflow_spec.removed' ORDER BY seq`).all() as { payload: string }[])
    .map((row) => { const p = JSON.parse(row.payload) as { specName: string; specVersion: string; reason: string }; return `${p.specName}@${p.specVersion}:${p.reason}`; });

  it("--prune-missing removes a probe registered from a path that is gone, and keeps the rest", async () => {
    const probe = register(scratch, "probe.yaml", "qa-probe", "1");
    register(scratch, "real.yaml", "real-flow", "1");
    unlinkSync(probe);

    const { status, body } = await unregister({ pruneMissing: true });

    expect(status).toBe(200);
    expect(body.removed).toEqual([{ name: "qa-probe", version: "1", sourcePath: probe }]);
    expect(body.kept).toEqual([]);
    expect(registered()).toEqual(["real-flow@1"]);
    expect(library()).toEqual(["real-flow@1"]);
    expect(removedEvents()).toEqual(["qa-probe@1:source_missing"]);
  });

  it("a name removes every version of that spec whose file is outside a scanned folder, even if the file exists", async () => {
    const v1 = register(scratch, "flow-v1.yaml", "flow", "1");
    const v2 = register(scratch, "flow-v2.yaml", "flow", "2");
    register(scratch, "other.yaml", "other", "1");

    const { status, body } = await unregister({ name: "flow" });

    expect(status).toBe(200);
    expect(body.removed.map((row) => `${row.name}@${row.version}:${row.sourcePath}`).sort()).toEqual([`flow@1:${v1}`, `flow@2:${v2}`]);
    expect(registered()).toEqual(["other@1"]);
    expect(removedEvents().sort()).toEqual(["flow@1:unregistered", "flow@2:unregistered"]);
  });

  it("name@version removes only that version", async () => {
    register(scratch, "flow-v1.yaml", "flow", "1");
    register(scratch, "flow-v2.yaml", "flow", "2");

    const { body } = await unregister({ name: "flow", version: "1" });

    expect(body.removed.map((row) => row.version)).toEqual(["1"]);
    expect(registered()).toEqual(["flow@2"]);
  });

  it("never removes a version unfinished work is pinned to: a prune retains it, and a later prune removes it once the work ends", async () => {
    const file = register(scratch, "keep.yaml", "wf-keep", "1");
    const inst = await runtime.instantiate({ specPath: file, rootObjective: "unregister", createdBySession: "ops@rig" });
    unlinkSync(file);

    const first = await unregister({ pruneMissing: true });
    expect(first.body.removed).toEqual([]);
    expect(first.body.kept).toEqual([{ name: "wf-keep", version: "1", sourcePath: file, reason: "pinned" }]);
    expect(runtime.specCache.getByNameVersion("wf-keep", "1")).not.toBeNull();
    expect(library()).toEqual([]);
    await expect(runtime.project({
      instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "handoff", actorSession: "anyone@rig", resultNote: "still readable",
    })).resolves.toBeTruthy();

    const named = await unregister({ name: "wf-keep" });
    expect(named.body.kept.map((row) => row.reason)).toEqual(["pinned"]);
    expect(runtime.specCache.getByNameVersion("wf-keep", "1")).not.toBeNull();

    await runtime.abort({ instanceId: inst.instance.instanceId, reason: "done with the test", actorSession: "ops@rig" });
    const later = await unregister({ pruneMissing: true });
    expect(later.body.removed).toEqual([{ name: "wf-keep", version: "1", sourcePath: file }]);
    expect(runtime.specCache.getByNameVersion("wf-keep", "1")).toBeNull();
  });

  it("keeps a spec whose file is still in the workflows folder, because the next scan would register it again", async () => {
    const file = register(workflowsFolder, "in-folder.yaml", "in-folder", "1");

    const { body } = await unregister({ name: "in-folder" });

    expect(body.removed).toEqual([]);
    expect(body.kept).toEqual([{ name: "in-folder", version: "1", sourcePath: file, reason: "scanned" }]);
    expect(registered()).toEqual(["in-folder@1"]);
  });

  it("--prune-missing with a name only touches that name", async () => {
    const a = register(scratch, "a.yaml", "alpha", "1");
    const b = register(scratch, "b.yaml", "beta", "1");
    unlinkSync(a);
    unlinkSync(b);

    const { body } = await unregister({ name: "alpha", pruneMissing: true });

    expect(body.removed.map((row) => row.name)).toEqual(["alpha"]);
    expect(registered()).toEqual(["beta@1"]);
  });

  // #2676 review: existsSync is also false on an access error, so an unreadable parent folder looked like a missing file.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("--prune-missing keeps and names a spec whose file can't be checked (EACCES), and removes a really missing one", async () => {
    const lockedDir = join(scratch, "locked");
    mkdirSync(lockedDir);
    const locked = register(lockedDir, "locked.yaml", "locked-flow", "1");
    const gone = register(scratch, "gone.yaml", "gone-flow", "1");
    unlinkSync(gone);
    chmodSync(lockedDir, 0o000);
    try {
      const { status, body } = await unregister({ pruneMissing: true });

      expect(status).toBe(200);
      expect(body.removed).toEqual([{ name: "gone-flow", version: "1", sourcePath: gone }]);
      expect(body.kept).toEqual([{ name: "locked-flow", version: "1", sourcePath: locked, reason: "unchecked" }]);
      expect(registered()).toEqual(["locked-flow@1"]);
      expect(removedEvents()).toEqual(["gone-flow@1:source_missing"]);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it("an empty version is a usage error and removes nothing (#2676 review)", async () => {
    register(scratch, "flow-v1.yaml", "flow", "1");
    register(scratch, "flow-v2.yaml", "flow", "2");

    const res = await unregister({ name: "flow", version: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("spec_selector_required");
    expect(registered()).toEqual(["flow@1", "flow@2"]);
  });

  it("refuses without a selector and answers 404 for an unknown name", async () => {
    expect((await unregister({})).status).toBe(400);
    expect((await unregister({ version: "1" })).status).toBe(400);
    const missing = await unregister({ name: "nope" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("spec_not_found");
  });
});
