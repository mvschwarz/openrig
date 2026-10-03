import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { compileProjectLifecycle } from "../src/domain/project-lifecycle-compiler.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { buildExecutionView } from "../src/domain/execution-view.js";

const example = parse(readFileSync(new URL("../../../docs/reference/project-release-profile.yaml", import.meta.url), "utf8"));
// Authored outcome inventory: do not derive the expected set from the fixture under test.
const ids = ["mission-outcome", "exact-release-candidate", "capability-delta", "exact-cut-substance",
  "release-verification", "git-canonicalization", "public-release", "parent-adoption", "record-shipped", "release-boundary"];

describe("project-owned boundary profile", () => {
  let root: string;
  let missionPath: string;
  let project: typeof example;
  let mission: Record<string, unknown>;
  const compile = () => compileProjectLifecycle({ missionPath, operationKey: "release" });
  function save() {
    writeFileSync(join(root, "project.yaml"), stringify(project));
    writeFileSync(join(missionPath, "mission.yaml"), stringify(mission));
  }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "project-boundary-")));
    missionPath = join(root, "missions", "release-0.5.11");
    mkdirSync(missionPath, { recursive: true });
    project = structuredClone(example);
    mission = { kind: "mission", metadata: { name: "release-0.5.11" }, composition: { slices: [] } };
    save();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("inherits every named obligation with digest, source binding and stable absolute addresses", () => {
    const first = compile();
    expect(first.eligible).toBe(true);
    expect(first.workflowSpec?.steps.map((s) => s.id)).toEqual(ids);
    expect(first.graphSource).toEqual({ mode: "project-profile", profileSource: `${root}/project.yaml#lifecycle.profiles.release-boundary-v0`, missionSource: null, requiredSteps: ids });
    expect(first.sources.map((s) => s.kind)).toEqual(["project", "mission"]);
    expect(first.workflowSpec?.steps[0]).toMatchObject({ re_present_after_seconds: 300, re_present_max_seconds: 3600 });
    expect(compileProjectLifecycle({ missionPath: resolve(missionPath, "./mission.yaml"), operationKey: "different" }).compiledInputDigest).toBe(first.compiledInputDigest);
    project.lifecycle.profiles["release-boundary-v0"].workflow.steps[0].objective = "Revised policy";
    save();
    expect(compile().compiledInputDigest).not.toBe(first.compiledInputDigest);
  });

  it("binds directory aliases to the same source/digest without accepting symlink manifests", () => {
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    expect(compileProjectLifecycle({ missionPath: join(alias, "missions", "release-0.5.11"), operationKey: "release" })).toEqual(compile());
    const link = join(missionPath, "linked.yaml");
    symlinkSync(join(missionPath, "mission.yaml"), link);
    expect(() => compileProjectLifecycle({ missionPath: link, operationKey: "release" })).toThrow(expect.objectContaining({ code: "lifecycle_manifest_symlink" }));
  });

  it.each(ids)("refuses missing required step %s", (id) => {
    const profile = project.lifecycle.profiles["release-boundary-v0"];
    profile.workflow.steps = profile.workflow.steps.filter((s: { id: string }) => s.id !== id);
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_required_step_missing", details: { missing: [id] } }));
  });

  it("extends with a ready successor without copying the release graph", () => {
    mission.lifecycle = { profile: "release-boundary-v0", mode: "extend", workflow: {
      context_refs: ["SPEC.md"], steps: [{ id: "activate-successor", actor_role: "orchestrator", depends_on: ["release-boundary"], objective: "Judge the authored ready successor and explicitly activate it", allowed_exits: ["done", "waiting", "failed"] }],
    } };
    save();
    expect(compile()).toMatchObject({ eligible: true, graphSource: { mode: "mission-extend" } });
    expect(compile().workflowSpec?.steps.map((s) => s.id)).toEqual([...ids, "activate-successor"]);
    expect(compile().workflowSpec?.context_refs).toContain(join(missionPath, "SPEC.md"));
  });

  it("permits an explicit override but preserves required IDs and prerequisite order", () => {
    const workflow = structuredClone(project.lifecycle.profiles["release-boundary-v0"].workflow);
    workflow.roles.orchestrator.preferred_targets = ["other@example"];
    mission.lifecycle = { profile: "release-boundary-v0", mode: "override", workflow };
    save();
    expect(compile()).toMatchObject({ eligible: true, graphSource: { mode: "mission-override" } });
    workflow.steps.find((s: { id: string }) => s.id === "public-release").depends_on = ["mission-outcome"];
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_required_order_changed" }));
    workflow.steps = workflow.steps.filter((s: { id: string }) => s.id !== "exact-cut-substance");
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_required_step_missing" }));
  });

  it.each([undefined, 100])("refuses an override retaining required ancestry but adding a prerequisite cycle, max_hops=%s", (maxHops) => {
    const workflow = structuredClone(project.lifecycle.profiles["release-boundary-v0"].workflow);
    workflow.steps.find((step: { id: string }) => step.id === "record-shipped").depends_on.push("release-boundary");
    if (maxHops !== undefined) workflow.loop_guards = { max_hops: maxHops };
    mission.lifecycle = { profile: "release-boundary-v0", mode: "override", workflow };
    save();
    const result = compile();
    expect(result.eligible).toBe(false);
    expect(result.unknowns.some((issue) => issue.includes("[dependency_cycle]"))).toBe(true);
  });

  it.each([
    ["ambiguous", { workflow: example.lifecycle.profiles["release-boundary-v0"].workflow }, "lifecycle_override_ambiguous"],
    ["unknown mode", { mode: "merge", workflow: {} }, "lifecycle_override_ambiguous"],
    ["empty mode", { mode: "extend" }, "lifecycle_manifest_shape_invalid"],
    ["unknown key", { workflow_ref: "ignored.yaml" }, "lifecycle_boundary_unknown_key"],
    ["step collision", { mode: "extend", workflow: { steps: [{ id: "exact-cut-substance" }] } }, "lifecycle_extension_collision"],
  ])("refuses %s without silently falling back", (_name, settings, code) => {
    mission.lifecycle = { profile: "release-boundary-v0", ...settings as object };
    save();
    expect(compile).toThrow(expect.objectContaining({ code }));
  });

  it("refuses inert project workflow fields and a selected missing profile", () => {
    project.lifecycle.workflow = {};
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_boundary_unknown_key" }));
    delete project.lifecycle.workflow;
    project.lifecycle.profile = "absent";
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_profile_not_found" }));
  });

  it("preserves legacy mission precedence explicitly until a project graph is installed", () => {
    const workflow = project.lifecycle.profiles["release-boundary-v0"].workflow;
    delete project.lifecycle.profiles;
    mission.lifecycle = { profile: "release-boundary-v0", workflow };
    save();
    expect(compile()).toMatchObject({ eligible: true, graphSource: { mode: "legacy-mission", requiredSteps: [] } });
    project.lifecycle.profiles = structuredClone(example.lifecycle.profiles);
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_override_ambiguous" }));
  });

  it.each([false, true])("executes the full boundary, receipts and optional successor=%s", async (successor) => {
    if (successor) mission.lifecycle = { profile: "release-boundary-v0", mode: "extend", workflow: {
      steps: [{ id: "activate-successor", actor_role: "orchestrator", depends_on: ["release-boundary"], allowed_exits: ["done", "waiting", "failed"] }],
    } };
    save();
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const bus = new EventBus(db);
      const queue = new QueueRepository(db, bus, { validateRig: () => true });
      const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
      const created = await runtime.instantiateLifecycle({ missionPath, operationKey: "release", rootObjective: "Ship release", createdBySession: "orch@example" });
      const instanceId = created.instance.instanceId;
      expect(runtime.inspect(instanceId).boundaryObligations.map((s) => s.stepId)).toEqual(successor ? [...ids, "activate-successor"] : ids);
      expect(runtime.inspect(instanceId).boundaryObligations.every((s) => s.receipt === null)).toBe(true);
      const start = runtime.inspect(instanceId).frontier[0]!;
      const mutationCount = () => db.prepare("SELECT total_changes() n").get();
      const before = mutationCount();
      await expect(runtime.project({ instanceId, currentPacketId: start.packetId, exit: "handoff", actorSession: "orch@example" })).rejects.toMatchObject({ code: "lifecycle_receipt_required" });
      expect(mutationCount()).toEqual(before);
      // Wait is a continuation, not acceptance, and needs no success receipt.
      await runtime.project({ instanceId, currentPacketId: start.packetId, exit: "waiting", actorSession: "orch@example", blockedOn: "await exact evidence" });
      expect(runtime.inspect(instanceId).boundaryObligations[0]).toMatchObject({ state: "waiting", receiptState: "missing" });
      for (const id of ids) {
        const packet = runtime.inspect(instanceId).frontier[0]!;
        expect(packet.stepId).toBe(id);
        if (id === "release-boundary") {
          const body = queue.getByIdOrThrow(packet.packetId).body;
          for (const area of ["seat renewal and re-prime", "memory distillation", "destination queue sweep",
            "substrate teardown or retention", "board freeze and clean-box baseline", "capability-delta absorption and expiry", "packaged-product discoverability"]) {
            expect(body).toContain(area);
          }
          expect(body).toContain("not seven daemon gates");
          expect(runtime.inspect(instanceId).instance.status).toBe("active");
        }
        await runtime.project({ instanceId, currentPacketId: packet.packetId, exit: id === "release-boundary" ? "done" : "handoff", actorSession: "orch@example", closureEvidence: { evidence_ref: `proof/${id}.md` } });
      }
      let view = runtime.inspect(instanceId);
      expect(view.boundaryObligations.filter((s) => s.required).every((s) => s.receiptState === "recorded")).toBe(true);
      if (successor) {
        expect(view.frontier.map((p) => p.stepId)).toEqual(["activate-successor"]);
        expect(view.instance.status).toBe("active");
        await runtime.project({ instanceId, currentPacketId: view.frontier[0]!.packetId, exit: "done", actorSession: "orch@example" });
        view = runtime.inspect(instanceId);
      }
      expect(view.instance.status).toBe("completed");
      const projected = await buildExecutionView({ db, slicesRoot: () => join(root, "missions"), buildInfo: { semver: null, commit: null, dirty: null, builtAt: null } }, { mission: "release-0.5.11" }) as { lifecycle_instances: Array<{ boundary_obligations: unknown }> };
      expect(projected.lifecycle_instances[0]?.boundary_obligations).toEqual(view.boundaryObligations);
      const replay = await runtime.instantiateLifecycle({ missionPath, operationKey: "release", rootObjective: "Ship release", createdBySession: "orch@example" });
      expect(replay.replayed).toBe(true);
      expect(replay.instance.instanceId).toBe(instanceId);
    } finally { db.close(); }
  });
});
