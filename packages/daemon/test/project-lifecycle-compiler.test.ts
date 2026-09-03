import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";

describe("project lifecycle compiler", () => {
  let root: string;
  let missionDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lifecycle-compiler-"));
    missionDir = join(root, "missions", "release-1.0.0");
    mkdirSync(join(missionDir, "slices", "01-build"), { recursive: true });
    writeFileSync(join(root, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
metadata: { id: demo }
missions: { root: missions }
lifecycle: { profile: release-boundary-v0 }
`);
    writeFileSync(join(missionDir, "mission.yaml"), `schema: openrig.mission/v0alpha1
kind: mission
metadata: { name: release-1.0.0 }
composition:
  slices:
    - { ref: slices/01-build/slice.yaml, order: 10, active: true }
`);
    writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `schema: openrig.slice/v0alpha1
kind: slice
metadata: { id: build }
composition: { mission: ../../mission.yaml }
execution:
  actor_role: builder
  preferred_targets: [builder@rig]
  allowed_exits: [done, failed]
`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function runtime() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    const queue = new QueueRepository(db, bus, { validateRig: () => true });
    return { db, runtime: new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue }) };
  }

  it("is deterministic and performs zero database writes", () => {
    const subject = runtime();
    const before = {
      specs: (subject.db.prepare("select count(*) n from workflow_specs").get() as { n: number }).n,
      instances: (subject.db.prepare("select count(*) n from workflow_instances").get() as { n: number }).n,
      queue: (subject.db.prepare("select count(*) n from queue_items").get() as { n: number }).n,
    };
    const first = subject.runtime.compileLifecycle(missionDir, "release-op");
    const second = subject.runtime.compileLifecycle(missionDir, "release-op");
    const differentOperation = subject.runtime.compileLifecycle(missionDir, "another-release-op");
    expect(second).toEqual(first);
    expect(differentOperation.compiledInputDigest).toBe(first.compiledInputDigest);
    expect(differentOperation.workflowSpec?.version).toBe(first.workflowSpec?.version);
    expect(differentOperation.operationKeyInput).toBe("another-release-op");
    expect(first.eligible).toBe(true);
    expect(first.workflowSpec?.version).toMatch(/^1-[a-f0-9]{16}$/);
    expect(first.dependencies).toEqual([{ stepId: "build", dependsOn: [] }]);
    expect({
      specs: (subject.db.prepare("select count(*) n from workflow_specs").get() as { n: number }).n,
      instances: (subject.db.prepare("select count(*) n from workflow_instances").get() as { n: number }).n,
      queue: (subject.db.prepare("select count(*) n from queue_items").get() as { n: number }).n,
    }).toEqual(before);
    subject.db.close();
  });

  it("keeps an invalid dependency graph inspectable but ineligible", () => {
    writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `schema: openrig.slice/v0alpha1
kind: slice
metadata: { id: build }
composition: { mission: ../../mission.yaml }
execution:
  actor_role: builder
  preferred_targets: [builder@rig]
  depends_on: [missing]
  allowed_exits: [done, failed]
`);
    const subject = runtime();
    const result = subject.runtime.compileLifecycle(missionDir, "release-op");
    expect(result.eligible).toBe(false);
    expect(result.unknowns).toEqual(expect.arrayContaining([
      expect.stringContaining("[dependency_step_not_found]"),
      "execution graph has no root step",
    ]));
    subject.db.close();
  });

  it("keeps an active slice without an execution contract inspectable but ineligible", () => {
    writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `schema: openrig.slice/v0alpha1
kind: slice
composition: { mission: ../../mission.yaml }
`);
    const subject = runtime();
    const result = subject.runtime.compileLifecycle(missionDir, "release-op");
    expect(result.eligible).toBe(false);
    expect(result.workflowSpec).toBeNull();
    expect(result.unknowns).toContain("slices/01-build/slice.yaml: execution contract missing");
    subject.db.close();
  });

  it("includes a released slice in provenance without requiring an execution contract", () => {
    mkdirSync(join(missionDir, "slices", "00-released"), { recursive: true });
    writeFileSync(join(missionDir, "slices", "00-released", "slice.yaml"), `schema: openrig.slice/v0alpha1
kind: slice
metadata: { id: released }
composition: { mission: ../../mission.yaml }
`);
    writeFileSync(join(missionDir, "mission.yaml"), `schema: openrig.mission/v0alpha1
kind: mission
metadata: { name: release-1.0.0 }
composition:
  slices:
    - { ref: slices/00-released/slice.yaml, order: 5, active: false }
    - { ref: slices/01-build/slice.yaml, order: 10, active: true }
`);
    const subject = runtime();
    const result = subject.runtime.compileLifecycle(missionDir, "release-op");
    expect(result.eligible).toBe(true);
    expect(result.unknowns).toEqual([]);
    expect(result.dependencies).toEqual([{ stepId: "build", dependsOn: [] }]);
    expect(result.sources.map((source) => realpathSync(source.path))).toContain(
      realpathSync(join(missionDir, "slices", "00-released", "slice.yaml")),
    );
    subject.db.close();
  });

  it.each([
    {
      name: "duplicate",
      members: "    - { ref: slices/01-build/slice.yaml, order: 10 }\n    - { ref: slices/01-build/slice.yaml, order: 20 }",
      code: "lifecycle_membership_duplicate",
    },
    {
      name: "misordered",
      members: "    - { ref: slices/01-build/slice.yaml, order: 20 }\n    - { ref: slices/02-other/slice.yaml, order: 10 }",
      code: "lifecycle_order_invalid",
      second: true,
    },
    {
      name: "escape",
      members: "    - { ref: ../outside.yaml, order: 10 }",
      code: "lifecycle_path_escape",
    },
    {
      name: "missing",
      members: "    - { ref: slices/99-missing/slice.yaml, order: 10 }",
      code: "lifecycle_member_missing",
    },
  ])("refuses $name membership before actuation", ({ members, code, second }) => {
    if (second) {
      mkdirSync(join(missionDir, "slices", "02-other"), { recursive: true });
      writeFileSync(join(missionDir, "slices", "02-other", "slice.yaml"), `schema: openrig.slice/v0alpha1
kind: slice
composition: { mission: ../../mission.yaml }
`);
    }
    writeFileSync(join(missionDir, "mission.yaml"), `schema: openrig.mission/v0alpha1
kind: mission
metadata: { name: release-1.0.0 }
composition:
  slices:
${members}
`);
    const subject = runtime();
    expect(() => subject.runtime.compileLifecycle(missionDir, "release-op")).toThrow(expect.objectContaining({ code }));
    subject.db.close();
  });
});
