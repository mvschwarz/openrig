import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux-transport.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { expandRigRelativeTarget, isRigRelativeTarget } from "../src/domain/workflow-rig-placeholder.js";

// A reusable workflow spec can write `member@{rig}` in preferred_targets;
// `{rig}` resolves to the instance's bound rig (--rig), so one spec
// addresses that rig's seat, including a terminal member.

const SPEC_RIG_RELATIVE = `workflow:
  id: rig-relative-targets
  version: 1
  objective: member@{rig} resolves against the bound rig
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{rig}
    finisher:
      preferred_targets:
        - ops-finisher@{rig}
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
      next_hop:
        mode: require
        suggested_roles:
          - finisher
    - id: finish
      actor_role: finisher
      allowed_exits:
        - done
`;

const SPEC_LITERAL = `workflow:
  id: literal-targets
  version: 1
  objective: literal member@rig is unchanged
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@rig-a
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - done
`;

describe("workflow preferred_targets: member@{rig}", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let relativePath: string;
  let literalPath: string;

  function seedRig(id: string, name: string, member: string, runtimeName: string): void {
    db.prepare(`INSERT INTO rigs (id, name) VALUES (?, ?)`).run(id, name);
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)`)
      .run(`n-${id}`, id, `ops.${member}`, runtimeName);
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`)
      .run(`s-${id}`, `n-${id}`, `ops-${member}@${name}`);
  }

  function entryOwner(instanceId: string): string {
    const row = db.prepare(`SELECT destination_session FROM queue_items WHERE qitem_id = (
      SELECT json_extract(current_frontier_json, '$[0]') FROM workflow_instances WHERE instance_id = ?)`)
      .get(instanceId) as { destination_session: string } | undefined;
    expect(row).toBeDefined();
    return row!.destination_session;
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    seedRig("r-a", "rig-a", "watcher", "claude-code");
    seedRig("r-b", "rig-b", "watcher", "terminal");
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-orch', 'orch')`).run();
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-rigrel-"));
    relativePath = join(tmp, "relative.yaml");
    writeFileSync(relativePath, SPEC_RIG_RELATIVE);
    literalPath = join(tmp, "literal.yaml");
    writeFileSync(literalPath, SPEC_LITERAL);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const instantiate = (specPath: string, targetRig?: string) =>
    runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@orch", ...(targetRig ? { targetRig } : {}) });

  it("--rig A resolves ops-watcher@{rig} to ops-watcher@rig-a", async () => {
    const r = await instantiate(relativePath, "rig-a");
    expect(entryOwner(r.instance.instanceId)).toBe("ops-watcher@rig-a");
  });

  it("--rig B resolves the same spec to ops-watcher@rig-b, a terminal member", async () => {
    const r = await instantiate(relativePath, "rig-b");
    expect(entryOwner(r.instance.instanceId)).toBe("ops-watcher@rig-b");
  });

  it("literal member@rig entries behave as before, bound or not", async () => {
    const unbound = await instantiate(literalPath);
    expect(entryOwner(unbound.instance.instanceId)).toBe("ops-watcher@rig-a");
    const bound = await instantiate(literalPath, "rig-b");
    expect(entryOwner(bound.instance.instanceId)).toBe("ops-watcher@rig-a");
  });

  it("later hops use the bound rig too (the stored binding drives every read)", async () => {
    const r = await instantiate(relativePath, "rig-b");
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('n-f', 'r-b', 'ops.finisher', 'claude-code')`).run();
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-f', 'n-f', 'ops-finisher@rig-b', 'running')`).run();
    const packetId = r.instance.currentFrontier[0] ?? (db.prepare(`SELECT qitem_id FROM queue_items LIMIT 1`).get() as { qitem_id: string }).qitem_id;
    const projected = await runtime.project({
      instanceId: r.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "ops-watcher@rig-b",
      resultNote: "next",
    } as never);
    const next = (projected as { nextOwnerSession?: string | null }).nextOwnerSession;
    expect(next).toBe("ops-finisher@rig-b");
  });

  it("validate on an unbound spec keeps a {rig} exception target 'unregistered' and says it needs a bound rig", () => {
    const specPath = join(tmp, "exception.yaml");
    writeFileSync(specPath, SPEC_RIG_RELATIVE + "  exception_routing:\n    orchestrator_role: watcher\n");
    const { exceptionReadiness } = runtime.validate(specPath);
    expect(exceptionReadiness.routes.length).toBeGreaterThan(0);
    for (const route of exceptionReadiness.routes) {
      expect(route.destinationSession).toBe("ops-watcher@{rig}");
      expect(route.identity).toBe("unregistered");
      expect(route.state).toBe("unregistered");
      expect(route.message).toMatch(/needs a bound rig \(--rig\) or a literal rig name/);
    }
  });

  // --- instance reads: each path below reads the spec for a bound instance ---

  const SPEC_FAILABLE = `workflow:
  id: rig-relative-failable
  version: 1
  objective: a failed step re-resolves a {rig} target on resume
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{rig}
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
        - failed
        - done
  exception_routing:
    orchestrator_role: watcher
`;

  function failedInstance(targetRig: string) {
    const specPath = join(tmp, "failable.yaml");
    writeFileSync(specPath, SPEC_FAILABLE);
    return instantiate(specPath, targetRig).then(async (r) => {
      const packetId = r.instance.currentFrontier[0]!;
      await runtime.project({
        instanceId: r.instance.instanceId,
        currentPacketId: packetId,
        exit: "failed",
        actorSession: `ops-watcher@${targetRig}`,
        resultNote: "boom",
      });
      return { instanceId: r.instance.instanceId, packetId };
    });
  }

  it("resume re-resolves the failed step's {rig} target on the bound rig", async () => {
    const { instanceId } = await failedInstance("rig-b");
    const resumed = await runtime.resume({ instanceId, actorSession: "orch@orch" });
    expect(resumed.ownerSession).toBe("ops-watcher@rig-b");
  });

  it("an unmapped failure's exception item goes to the {rig} target on the bound rig", async () => {
    const { instanceId } = await failedInstance("rig-b");
    const row = db.prepare(`SELECT destination_session FROM queue_items WHERE json_valid(tags)
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`).get(`instance:${instanceId}`) as { destination_session: string } | undefined;
    expect(row?.destination_session).toBe("ops-watcher@rig-b");
  });

  it("resolveExceptionRouteFor expands {rig} with the instance's bound rig", async () => {
    await failedInstance("rig-a");
    const route = runtime.resolveExceptionRouteFor("rig-relative-failable", "1", "unmapped_failed", "rig-b");
    expect(route?.destinationSession).toBe("ops-watcher@rig-b");
  });

  it("exceptionReadiness reads the bound instance's target, not the literal {rig}", async () => {
    const { instanceId } = await failedInstance("rig-b");
    const readiness = runtime.exceptionReadiness(instanceId)!;
    for (const route of readiness.routes) {
      expect(route.destinationSession).toBe("ops-watcher@rig-b");
      expect(route.identity).toBe("declared-member");
    }
  });

  it("route re-targets a {rig} instance's frontier packet", async () => {
    const r = await instantiate(relativePath, "rig-b");
    const routed = await runtime.route({
      instanceId: r.instance.instanceId, toSession: "other@orch", actorSession: "orch@orch", reason: "move",
    });
    expect(routed.fromSession).toBe("ops-watcher@rig-b");
    expect(routed.toSession).toBe("other@orch");
  });

  it("abort closes a {rig} instance and records the step's role", async () => {
    const r = await instantiate(relativePath, "rig-b");
    const aborted = await runtime.abort({ instanceId: r.instance.instanceId, reason: "stop", actorSession: "orch@orch" });
    expect(aborted.status).toBe("aborted");
    const trail = db.prepare(`SELECT step_role FROM workflow_step_trails WHERE instance_id = ?`).get(r.instance.instanceId) as { step_role: string };
    expect(trail.step_role).toBe("watcher");
  });

  it("the slice view of a bound instance shows the seat the packet went to, not the literal {rig}", async () => {
    const sliceRoot = join(tmp, "slices");
    mkdirSync(join(sliceRoot, "rr-slice"), { recursive: true });
    writeFileSync(join(sliceRoot, "rr-slice", "README.md"), "---\nslice: rr-slice\nrail-item: PL-test\nstatus: active\n---\n# rr-slice\n");
    const r = await runtime.instantiate({ specPath: relativePath, rootObjective: "rr-slice work", createdBySession: "orch@orch", targetRig: "rig-b" });
    const indexer = new SliceIndexer({ slicesRoot: sliceRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
    const detail = projector.project(indexer.get("rr-slice")!);
    expect(detail.workflowBinding?.instanceId).toBe(r.instance.instanceId);
    expect(detail.topology.specGraph?.nodes.find((n) => n.role === "watcher")?.preferredTarget).toBe("ops-watcher@rig-b");
  });

  it("an occurrence-local resume (dependency graph) re-resolves the {rig} target too", async () => {
    const specPath = join(tmp, "graph.yaml");
    writeFileSync(specPath, `workflow:
  id: rig-relative-graph
  version: 1
  entry: {role: watcher}
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{rig}
  exception_routing: {orchestrator_role: watcher}
  steps:
    - id: root
      actor_role: watcher
      depends_on: []
      allowed_exits: [done, failed]
    - id: left
      actor_role: watcher
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: right
      actor_role: watcher
      depends_on: [root]
      allowed_exits: [done, failed]
`);
    const started = await instantiate(specPath, "rig-b");
    const instanceId = started.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: started.entryQitemId, actorSession: "ops-watcher@rig-b", exit: "done" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!.packetId;
    await runtime.project({ instanceId, currentPacketId: left, actorSession: "ops-watcher@rig-b", exit: "failed", resultNote: "boom" });
    expect(runtime.inspect(instanceId).failures).toHaveLength(1);
    const resumed = await runtime.resume({ instanceId, occurrenceId: left, actorSession: "orch@orch" });
    expect(resumed.ownerSession).toBe("ops-watcher@rig-b");
  });
});

// The same starts through the daemon's real wiring: startup.ts's rig-registry
// admission check, not a `validateRig: () => true` fixture, so a literal
// `{rig}` destination is refused exactly as it is in production.
describe("member@{rig} through the real admission path", () => {
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  let tmp: string;

  beforeAll(async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    daemon = await createDaemon({ cmuxFactory, tmuxExec });
    for (const name of ["rig-a", "rig-b", "prefix-rig-b", "orch"]) daemon.deps.rigRepo.createRig(name);
    tmp = mkdtempSync(join(tmpdir(), "wf-rigrel-http-"));
  });

  afterAll(() => {
    daemon.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const watchStep = `    - id: watch
      actor_role: watcher
      allowed_exits:
        - done
`;
  const withDefault = (yaml: string, defaultRig: string | null) =>
    defaultRig === null ? yaml : yaml.replace("  entry:", `  target:\n    rig: ${defaultRig}\n  entry:`);
  const specYaml = (id: string, roles: string, steps = watchStep) => `workflow:
  id: ${id}
  version: 1
  objective: member@{rig} through admission
  entry:
    role: watcher
  roles:
${roles}  steps:
${steps}`;

  let n = 0;
  function writeSpec(yaml: string): string {
    const path = join(tmp, `spec-${++n}.yaml`);
    writeFileSync(path, yaml);
    return path;
  }

  const count = (table: string) => (daemon.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const entryDestination = (instanceId: string) => (daemon.db.prepare(`SELECT destination_session FROM queue_items WHERE qitem_id = (
    SELECT json_extract(current_frontier_json, '$[0]') FROM workflow_instances WHERE instance_id = ?)`)
    .get(instanceId) as { destination_session: string }).destination_session;

  async function start(yaml: string, extra: Record<string, string> = {}) {
    const res = await daemon.app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: writeSpec(yaml), rootObjective: "t", createdBySession: "orch@orch", ...extra }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  // The four shapes whose {rig} is never the entry target actually used.
  const STARTS: Record<string, { yaml: string; extra?: Record<string, string> }> = {
    "a literal entry with {rig} only in a later role": {
      yaml: specYaml("start-later-role", `    watcher:
      preferred_targets:
        - ops-watcher@rig-a
    finisher:
      preferred_targets:
        - ops-finisher@{rig}
`, `    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
      next_hop:
        mode: require
        suggested_roles:
          - finisher
    - id: finish
      actor_role: finisher
      allowed_exits:
        - done
`),
    },
    "a literal entry with {rig} only in a role that never runs": {
      yaml: specYaml("start-unused-role", `    watcher:
      preferred_targets:
        - ops-watcher@rig-a
    spare:
      preferred_targets:
        - ops-spare@{rig}
`),
    },
    "a literal first preferred target with {rig} second": {
      yaml: specYaml("start-literal-first", `    watcher:
      preferred_targets:
        - ops-watcher@rig-a
        - ops-watcher@{rig}
`),
    },
    "a {rig} role with an explicit entryOwnerSession": {
      yaml: specYaml("start-explicit-owner", `    watcher:
      preferred_targets:
        - ops-watcher@{rig}
`),
      extra: { entryOwnerSession: "ops-watcher@rig-a" },
    },
  };

  const UNBOUND: Array<[string, string | null]> = [
    ["no binding", null],
    ["a spec default rig that is not registered", "vanished-rig"],
  ];

  describe.each(Object.entries(STARTS))("%s", (_name, shape) => {
    it.each(UNBOUND)("still starts with %s: one instance, one entry packet, owner on rig-a", async (_label, defaultRig) => {
      const instances = count("workflow_instances");
      const packets = count("queue_items");
      const { status, body } = await start(withDefault(shape.yaml, defaultRig), shape.extra);
      expect(status).toBe(201);
      expect(body.instance.boundRig).toBeNull();
      expect(count("workflow_instances")).toBe(instances + 1);
      expect(count("queue_items")).toBe(packets + 1);
      expect(entryDestination(body.instance.instanceId)).toBe("ops-watcher@rig-a");
    });
  });

  const ENTRY_RIG_RELATIVE = specYaml("start-entry-rig-relative", `    watcher:
      preferred_targets:
        - ops-watcher@{rig}
`);

  it("a bound start expands the selected {rig} entry target", async () => {
    const { status, body } = await start(ENTRY_RIG_RELATIVE, { targetRig: "rig-b" });
    expect(status).toBe(201);
    expect(body.instance.boundRig).toBe("rig-b");
    expect(entryDestination(body.instance.instanceId)).toBe("ops-watcher@rig-b");
  });

  it.each(UNBOUND)("an unbound start whose selected entry target is member@{rig} is still 400 unknown_destination_rig with %s, and nothing is created", async (_label, defaultRig) => {
    const instances = count("workflow_instances");
    const packets = count("queue_items");
    const { status, body } = await start(withDefault(ENTRY_RIG_RELATIVE, defaultRig));
    expect(status).toBe(400);
    expect(body.error).toBe("unknown_destination_rig");
    expect(body.message).toContain("ops-watcher@{rig}");
    expect(count("workflow_instances")).toBe(instances);
    expect(count("queue_items")).toBe(packets);
  });

  it("an unbound later hop that selects member@{rig} fails at its own hop, with main's error", async () => {
    const yaml = specYaml("start-later-hop", `    watcher:
      preferred_targets:
        - ops-watcher@rig-a
    finisher:
      preferred_targets:
        - ops-finisher@{rig}
`, `    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
      next_hop:
        mode: require
        suggested_roles:
          - finisher
    - id: finish
      actor_role: finisher
      allowed_exits:
        - done
`);
    const started = await start(yaml);
    expect(started.status).toBe(201);
    const res = await daemon.app.request("/api/workflow/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: started.body.instance.instanceId,
        currentPacketId: started.body.entryQitemId,
        exit: "handoff",
        actorSession: "ops-watcher@rig-a",
        resultNote: "next",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("unknown_destination_rig");
  });

  describe("only a trailing @{rig} is the form", () => {
    const roles = (target: string) => `    watcher:
      preferred_targets:
        - ${target}
`;

    it("braces in the member part stay literal: ops-{rig}@rig-a keeps its destination when bound", async () => {
      const { status, body } = await start(specYaml("start-member-braces", roles("ops-{rig}@rig-a")), { targetRig: "rig-b" });
      expect(status).toBe(201);
      expect(entryDestination(body.instance.instanceId)).toBe("ops-{rig}@rig-a");
    });

    // `prefix-rig-b` is registered, so replacing `{rig}` inside the rig name would reach it.
    it.each([["bound", { targetRig: "rig-b" }], ["unbound", {}]])(
      "a partial rig name stays literal and is refused as on main (%s): ops-watcher@prefix-{rig}",
      async (_label, extra) => {
        const instances = count("workflow_instances");
        const { status, body } = await start(specYaml("start-partial-rig", roles("ops-watcher@prefix-{rig}")), extra);
        expect(status).toBe(400);
        expect(body.error).toBe("unknown_destination_rig");
        expect(count("workflow_instances")).toBe(instances);
      },
    );
  });
});

describe("member@{rig} helper", () => {
  it("detects and expands only a trailing @{rig}", () => {
    expect(isRigRelativeTarget("ops-watcher@{rig}")).toBe(true);
    expect(isRigRelativeTarget("ops-{rig}@rig-a")).toBe(false);
    expect(isRigRelativeTarget("ops-watcher@prefix-{rig}")).toBe(false);
    expect(isRigRelativeTarget("ops-watcher@{rig}-suffix")).toBe(false);
    expect(expandRigRelativeTarget("ops-watcher@{rig}", "rig-b")).toBe("ops-watcher@rig-b");
    expect(expandRigRelativeTarget("{rig}@{rig}", "rig-b")).toBe("{rig}@rig-b");
    expect(expandRigRelativeTarget("ops-{rig}@rig-a", "rig-b")).toBe("ops-{rig}@rig-a");
    expect(expandRigRelativeTarget("ops-watcher@prefix-{rig}", "rig-b")).toBe("ops-watcher@prefix-{rig}");
    expect(expandRigRelativeTarget("ops-watcher@{rig}", null)).toBe("ops-watcher@{rig}");
  });
});
