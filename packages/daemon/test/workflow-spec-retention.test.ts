// #511: deleting or renaming a workflow spec file must not remove a cached version that an
// unfinished workflow instance is pinned to. The deleted file still leaves the library; the
// pinned version stays readable by name and version until that work ends.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync, utimesSync } from "node:fs";
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
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { scanWorkflowSpecFolder, scanWorkflowSpecs } from "../src/domain/spec-library-workflow-scanner.js";

const spec = (version: string) => `workflow:
  id: wf-keep
  version: '${version}'
  objective: retention fixture
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

describe("workflow spec file removal keeps versions pinned by unfinished work (#511)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let cache: WorkflowSpecCache;
  let folder: string;
  let file: string;
  let tick: number;
  const base = Math.floor(Date.now() / 1000) - 1000;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
    tick = 0;
    // Each scan caches one second after the latest write, as the scanner sees files on disk.
    cache = new WorkflowSpecCache(db, () => new Date((base + tick + 1) * 1000));
    folder = mkdtempSync(join(tmpdir(), "wf-keep-"));
    file = join(folder, "flow.yaml");
  });
  afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

  const touch = (path: string) => { tick += 10; utimesSync(path, base + tick, base + tick); };
  const write = (path: string, content: string) => { writeFileSync(path, content); touch(path); };
  const scan = () => scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus: bus });
  const version = (v: string) => { const row = cache.getByNameVersion("wf-keep", v); return row ? { specId: row.specId, steps: row.spec.steps.length } : null; };
  const library = () => scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: null }).map((entry) => `${entry.version}@${entry.sourcePath.split("/").pop()}`).sort();
  const removedEvents = () => (db.prepare(`SELECT payload FROM events WHERE type = 'workflow_spec.removed'`).all() as { payload: string }[])
    .map((row) => (JSON.parse(row.payload) as { specVersion: string }).specVersion).sort();

  /** v1 cached, an active instance pinned to v1, then v2 cached from the same file. */
  async function activeOnV1() {
    write(file, spec("1"));
    scan();
    const inst = await runtime.instantiate({ specPath: file, rootObjective: "retention", createdBySession: "ops@rig" });
    write(file, spec("2"));
    scan();
    return { inst, v1: version("1"), v2: version("2") };
  }
  async function projects(inst: Awaited<ReturnType<typeof activeOnV1>>["inst"]) {
    try {
      await runtime.project({ instanceId: inst.instance.instanceId, currentPacketId: inst.entryQitemId, exit: "handoff", actorSession: "anyone@rig", resultNote: "retention" });
      return "ok";
    } catch (err) {
      return (err as { code?: string }).code ?? String(err);
    }
  }

  it("delete keeps the pinned version for the active instance and removes the file from the library", async () => {
    const { inst, v1 } = await activeOnV1();
    unlinkSync(file);
    scan();

    expect(version("1")).toEqual(v1);
    expect(await projects(inst)).toBe("ok");
    expect(version("2")).toBeNull();
    expect(library()).toEqual([]);
    expect(removedEvents()).toEqual(["2"]);
  });

  it("rename keeps the current and the pinned version and never empties the cache", async () => {
    const { inst, v1, v2 } = await activeOnV1();
    const renamed = join(folder, "flow-renamed.yaml");
    renameSync(file, renamed);
    touch(renamed);
    scan();

    expect(version("2")).toEqual(v2);
    expect(version("1")).toEqual(v1);
    expect(library()).toEqual(["2@flow-renamed.yaml"]);
    expect(removedEvents()).toEqual([]);
    expect(await projects(inst)).toBe("ok");
  });

  // An install upgraded from a release whose diagnostic writer blanked a cached version's name,
  // version and steps but kept its stored spec: that row is the only copy of the pinned version.
  it("delete keeps a pinned version the previous diagnostic writer blanked, with its spec ID and stored spec", async () => {
    const { inst, v1 } = await activeOnV1();
    const storedSpec = () => (db.prepare("SELECT spec_json FROM workflow_specs WHERE spec_id = ?").get(v1!.specId) as { spec_json: string } | undefined)?.spec_json;
    const storedBefore = storedSpec();
    expect(storedBefore).toBeTruthy();
    db.prepare(
      `UPDATE workflow_specs SET status = 'error', error_message = 'old parse error', name = 'flow.yaml', version = '',
         purpose = NULL, target_rig = NULL, roles_json = '{}', steps_json = '[]', coordination_terminal_turn_rule = 'hot_potato'
       WHERE spec_id = ?`,
    ).run(v1!.specId);

    unlinkSync(file);
    scan();
    expect(storedSpec()).toBe(storedBefore);
    expect(cache.getByIdOrThrow(v1!.specId).spec.version).toBe("1");
    expect(library()).toEqual([]);
    expect(removedEvents()).toEqual(["2"]);

    // Once that work has finished, the next scan removes it like any other vanished version.
    db.prepare(`UPDATE workflow_instances SET status = 'completed' WHERE instance_id = ?`).run(inst.instance.instanceId);
    scan();
    expect(storedSpec()).toBeUndefined();
  });

  it("a retained blanked version's file returning malformed is recorded per file and the scan goes on", async () => {
    const { v1 } = await activeOnV1();
    const storedSpec = () => (db.prepare("SELECT spec_json FROM workflow_specs WHERE spec_id = ?").get(v1!.specId) as { spec_json: string } | undefined)?.spec_json;
    const storedBefore = storedSpec();
    db.prepare(
      `UPDATE workflow_specs SET status = 'error', error_message = 'old parse error', name = 'flow.yaml', version = '',
         purpose = NULL, target_rig = NULL, roles_json = '{}', steps_json = '[]', coordination_terminal_turn_rule = 'hot_potato'
       WHERE spec_id = ?`,
    ).run(v1!.specId);
    unlinkSync(file);
    scan();

    write(file, "workflow:\n  id: wf-keep\n  version: [unterminated\n");
    write(join(folder, "z-good.yaml"), spec("1").replace("id: wf-keep", "id: wf-other"));
    let result: ReturnType<typeof scan> | undefined;
    expect(() => { result = scan(); }).not.toThrow();
    expect(result).toMatchObject({ errors: 1, valid: 1 });

    expect(storedSpec()).toBe(storedBefore);
    expect((db.prepare("SELECT status FROM workflow_specs WHERE spec_id = ?").get(v1!.specId) as { status: string }).status).toBe("retained");
    const diagnostics = db.prepare("SELECT spec_id, name FROM workflow_specs WHERE source_path = ? AND status = 'error'").all(file) as { spec_id: string; name: string }[];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.spec_id).not.toBe(v1!.specId);
    expect(cache.getByNameVersion("wf-other", "1")).not.toBeNull();
  });

  it("still removes an old version that no unfinished instance uses", () => {
    write(file, spec("1"));
    scan();
    write(file, spec("2"));
    scan();
    unlinkSync(file);
    expect(scan().removed).toBe(2);
    expect([version("1"), version("2")]).toEqual([null, null]);
    expect(removedEvents()).toEqual(["1", "2"]);
  });

  // A failed instance can still be resumed, and resume reads its pinned spec.
  it.each([
    ["completed", "releases", false],
    ["aborted", "releases", false],
    ["waiting", "keeps", true],
    ["failed", "keeps", true],
  ])("an instance with status %s %s its version once the file is gone", async (status, _verb, keeps) => {
    const { inst, v1 } = await activeOnV1();
    unlinkSync(file);
    scan();
    expect(version("1")).toEqual(v1);

    db.prepare(`UPDATE workflow_instances SET status = ? WHERE instance_id = ?`).run(status, inst.instance.instanceId);
    scan();
    expect(version("1")).toEqual(keeps ? v1 : null);
    expect(removedEvents()).toEqual(keeps ? ["2"] : ["1", "2"]);
  });
});
