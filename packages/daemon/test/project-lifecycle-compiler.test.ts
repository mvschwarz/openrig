import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { Hono } from "hono";
import { workflowRoutes } from "../src/routes/workflow.js";

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

  it("keeps a missing project manifest a structured lifecycle 404", async () => {
    rmSync(join(root, "project.yaml"));
    const subject = runtime();
    const app = new Hono();
    const projectPath = join(realpathSync(root), "project.yaml");
    app.use("*", async (c, next) => { c.set("workflowRuntime" as never, subject.runtime as never); await next(); });
    app.route("/api/workflow", workflowRoutes());
    try {
      const response = await app.request("/api/workflow/compile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ missionPath: missionDir, operationKey: "release-op" }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: "lifecycle_manifest_missing", kind: "project",
        message: `project manifest not found at ${projectPath}`,
        path: projectPath,
      });
    } finally { subject.db.close(); }
  });

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

  it.each(["work/initiatives", "."])("finds the owning project for missions.root %s", (missionsRoot) => {
    const parent = join(root, missionsRoot);
    mkdirSync(parent, { recursive: true });
    const moved = join(parent, "release-1.0.0");
    renameSync(missionDir, moved);
    missionDir = moved;
    writeFileSync(join(root, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
metadata: { id: demo }
missions: { root: "${missionsRoot}" }
lifecycle: { profile: release-boundary-v0 }
`);
    const subject = runtime();
    try {
      const compiled = subject.runtime.compileLifecycle(missionDir, "release-op");
      expect(compiled.eligible).toBe(true);
      expect(compiled.identity).toEqual({ project: "demo", mission: "release-1.0.0", lifecycleProfile: "release-boundary-v0" });
      expect(compiled.sources.find(source => source.kind === "project")?.path).toBe(realpathSync(join(root, "project.yaml")));
    } finally { subject.db.close(); }
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

  // #3616: `rig scope slice create|set --execution-depends-on` writes sibling dot-IDs, which a slice declares in its SPEC.md,
  // while a compiled step is named by metadata.id or its folder. Proof readiness's resolver maps the one to the other.
  describe("a dependency named by a sibling's dot-ID", () => {
    const slice = (dir: string, manifest: string, specId?: string) => {
      mkdirSync(join(missionDir, "slices", dir), { recursive: true });
      writeFileSync(join(missionDir, "slices", dir, "slice.yaml"), manifest);
      if (specId) writeFileSync(join(missionDir, "slices", dir, "SPEC.md"), `---\nid: ${specId}\n---\n# ${dir}\n`);
    };
    const contract = (role: string, dependsOn: string[], id?: string) => `schema: openrig.slice/v0alpha1
kind: slice
${id ? `metadata: { id: ${id} }\n` : ""}composition: { mission: ../../mission.yaml }
execution:
  actor_role: ${role}
  depends_on: ${JSON.stringify(dependsOn)}
`;
    const compose = (dirs: string[]) => writeFileSync(join(missionDir, "mission.yaml"), `schema: openrig.mission/v0alpha1
kind: mission
metadata: { name: release-1.0.0 }
composition:
  slices:
${dirs.map((dir, index) => `    - { ref: slices/${dir}/slice.yaml, order: ${(index + 1) * 10}, active: true }`).join("\n")}
`);

    it("resolves to that sibling's step, which proof readiness reads the same way", () => {
      slice("01-build", contract("builder", [], "build"), "DEM.1.0.0.1");
      slice("02-review", contract("reviewer", ["DEM.1.0.0.1"]), "DEM.1.0.0.2");
      compose(["01-build", "02-review"]);
      const subject = runtime();
      try {
        const result = subject.runtime.compileLifecycle(missionDir, "release-op");
        expect(result.unknowns).toEqual([]);
        expect(result.eligible).toBe(true);
        expect(result.dependencies).toEqual([{ stepId: "build", dependsOn: [] }, { stepId: "02-review", dependsOn: ["build"] }]);
        // The SPEC.md the edge resolved through is an input of the compile.
        expect(result.sources.map((source) => source.path)).toContain(realpathSync(join(missionDir, "slices", "01-build", "SPEC.md")));
      } finally { subject.db.close(); }
    });

    it("names no step when two slices declare the dot-ID, and says so", () => {
      slice("01-build", contract("builder", [], "build"), "DEM.1.0.0.1");
      slice("02-review", contract("reviewer", ["DEM.1.0.0.1"]), "DEM.1.0.0.2");
      slice("03-copy", contract("builder", [], "copy"), "DEM.1.0.0.1");
      compose(["01-build", "02-review", "03-copy"]);
      const subject = runtime();
      try {
        const result = subject.runtime.compileLifecycle(missionDir, "release-op");
        expect(result.eligible).toBe(false);
        expect(result.dependencies).toContainEqual({ stepId: "02-review", dependsOn: ["DEM.1.0.0.1"] });
        expect(result.unknowns).toEqual(expect.arrayContaining([expect.stringContaining("[dependency_step_not_found]")]));
        expect(result.advisories).toContain('slice dot-ID "DEM.1.0.0.1" is declared by 2 slices (01-build, 03-copy); a dependency on it names no step');
      } finally { subject.db.close(); }
    });

    it("keeps a step's own name first: a name that is a step id is never read as a dot-ID", () => {
      slice("01-build", contract("builder", [], "build"), "DEM.1.0.0.1");
      slice("02-review", contract("reviewer", ["build"]), "build");
      compose(["01-build", "02-review"]);
      const subject = runtime();
      try {
        const result = subject.runtime.compileLifecycle(missionDir, "release-op");
        expect(result.dependencies).toContainEqual({ stepId: "02-review", dependsOn: ["build"] });
        expect(result.eligible).toBe(true);
      } finally { subject.db.close(); }
    });
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

  // `rig scope slice create --execution-depends-on` records only execution.depends_on (#3615); that alone is not a step contract.
  it("keeps an active slice whose execution names only dependencies inspectable but ineligible", () => {
    writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `schema: openrig.slice/v0alpha1
kind: slice
composition: { mission: ../../mission.yaml }
execution:
  depends_on: ["OPR.1.0.0.1"]
  wave: 1
`);
    const subject = runtime();
    const result = subject.runtime.compileLifecycle(missionDir, "release-op");
    expect(result.eligible).toBe(false);
    expect(result.workflowSpec).toBeNull();
    expect(result.unknowns).toContain("slices/01-build/slice.yaml: execution contract missing");
    subject.db.close();
  });

  it("names the missing actor_role of an authored step contract", () => {
    writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `schema: openrig.slice/v0alpha1
kind: slice
composition: { mission: ../../mission.yaml }
execution:
  preferred_targets: [builder@rig]
  depends_on: ["OPR.1.0.0.1"]
`);
    const subject = runtime();
    expect(() => subject.runtime.compileLifecycle(missionDir, "release-op")).toThrow(/execution\.actor_role must be a non-empty string/);
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
