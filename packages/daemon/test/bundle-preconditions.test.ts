import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { bundleRoutes } from "../src/routes/bundles.js";
import { describeBundleBehaviour } from "../src/domain/bundle-behaviour.js";
import { normalizePreconditionsBlock } from "../src/domain/bundle-types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const spec = `version: "0.2"
name: setup-fixture
docs: [{path: README.md}]
pods:
  - id: team
    label: Team
    members:
      - {id: shell, runtime: terminal, agent_ref: "builtin:terminal", profile: none, cwd: "."}
    edges: []
edges: []
`;
const legacySpec = `schema_version: 1
name: setup-fixture
version: "1.0"
nodes:
  - {id: shell, runtime: terminal}
edges: []
`;

function createFixture(rigSpec: string, author: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-preconditions-")); roots.push(root);
  fs.writeFileSync(path.join(root, "rig.yaml"), rigSpec);
  fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(root, "bundle.yaml"), stringify(author));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, { emit() {} } as never); await next(); });
  app.route("/api/bundles", bundleRoutes);
  const post = (route: string, body: unknown) => app.request(`/api/bundles/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const bundlePath = path.join(root, "fixture.rigbundle");
  return {
    create: () => post("create", { specPath: path.join(root, "rig.yaml"), rigRoot: root, bundleName: "fixture", bundleVersion: "1.0.0", outputPath: bundlePath }),
    inspect: () => post("inspect", { bundlePath }),
  };
}

describe("authored bundle setup preconditions", () => {
  it.each([false, true])("carries declarations through create and inspect (link source=%s), without executing them", async linked => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-preconditions-")); roots.push(root);
    fs.writeFileSync(path.join(root, "rig.yaml"), spec);
    fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
    const marker = path.join(root, "must-not-run");
    const preconditions = [{ name: "Prepare the source clone first.", commands: [`touch ${marker}`, "cd openrig", "npm ci", "npm run build"] }, { name: "Sign in to the selected runtimes." }];
    fs.writeFileSync(path.join(root, "bundle.yaml"), stringify({ preconditions }));
    const source = { repository: "https://github.com/example/team", folder: "rig", requestedRef: "main", resolvedCommit: "a".repeat(40), canonicalUrl: `https://github.com/example/team/tree/${"a".repeat(40)}/rig` };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, { emit() {} } as never); await next(); });
    app.route("/api/bundles", bundleRoutes);
    const post = async (route: string, body: unknown) => app.request(`/api/bundles/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const bundlePath = path.join(root, "fixture.rigbundle");
    const created = await post("create", { specPath: path.join(root, "rig.yaml"), rigRoot: root, bundleName: "fixture", bundleVersion: "1.0.0", outputPath: bundlePath, ...(linked ? { provenance: { source } } : {}) });
    expect(created.status, await created.clone().text()).toBe(201);
    const creation = await created.json();
    // Inspection must use the archive even when its author's files are gone.
    fs.unlinkSync(path.join(root, "bundle.yaml"));
    fs.unlinkSync(path.join(root, "rig.yaml"));
    const response = await post("inspect", { bundlePath });
    expect(response.status).toBe(200);
    const inspected = await response.json();
    expect(inspected.manifest.preconditions).toEqual(preconditions);
    expect(inspected.behaviour.needs.filter((n: { kind: string }) => n.kind === "precondition")).toEqual(preconditions.map((p, i) => ({ ...p, kind: "precondition", status: "not_checked", sourceRefs: [{ path: "bundle.yaml", field: `preconditions[${i}]` }] })));
    expect(inspected.integrityResult.passed).toBe(true);
    expect(inspected.archiveHash).toBe(creation.archiveHash);
    expect(inspected.packageDigest).toEqual(creation.packageDigest);
    expect(inspected.source).toEqual(linked ? source : null);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([null, "run setup", [{ name: "" }], [{ name: "Setup", commands: [42] }], [{ name: "Setup", commands: ["cd clone\nnpm ci"] }]])("keeps malformed setup metadata diagnostic: %j", preconditions => {
    expect(normalizePreconditionsBlock(preconditions)).toBeUndefined();
    const view = describeBundleBehaviour({ files: new Map([["rig.yaml", spec]]), manifest: { schema_version: 2, rig_spec: "rig.yaml", preconditions }, generator: { openrigVersion: "test" }, digestValid: true, filesVerified: true });
    expect(view.state).toBe("generated");
    if (view.state !== "generated") throw new Error(view.reason);
    expect(view.needs.filter(n => n.kind === "precondition")).toEqual([]);
    expect(view.unknownBeforeLaunch).toContainEqual(expect.objectContaining({ subject: "Bundle preconditions" }));
  });

  describe.each([{ branch: "pod", rigSpec: spec }, { branch: "legacy", rigSpec: legacySpec }])("$branch creation", ({ rigSpec }) => {
    it.each([
      { preconditions: null, reason: "preconditions must be an array" },
      { preconditions: "run setup", reason: "preconditions must be an array" },
      { preconditions: [{ name: "" }], reason: "preconditions[0].name" },
      { preconditions: [{ name: "Setup", commands: [42] }], reason: "preconditions[0].commands" },
      { preconditions: [{ name: "Setup", commands: ["cd clone\nnpm ci"] }], reason: "preconditions[0].commands" },
      { preconditions: [{ name: "Valid first entry" }, null], reason: "preconditions[1].name" },
    ])("warns and omits the whole malformed block: $reason", async ({ preconditions, reason }) => {
      const fixture = createFixture(rigSpec, { preconditions });
      const created = await fixture.create();
      expect(created.status, await created.clone().text()).toBe(201);
      expect((await created.json()).warning).toContain(`${reason}`);
      const response = await fixture.inspect();
      expect(response.status, await response.clone().text()).toBe(200);
      const inspected = await response.json();
      expect(inspected.manifest).not.toHaveProperty("preconditions");
      expect(inspected.integrityResult.passed).toBe(true);
    });

    it("warns about shell operators but retains the declarations as data", async () => {
      const preconditions = [{ name: "Author setup", commands: ["echo one; echo two", "echo one && echo two", "echo one | cat", "echo $(pwd)", "echo `pwd`", "echo one > output", "cat < input"] }];
      const fixture = createFixture(rigSpec, { preconditions });
      const created = await fixture.create();
      expect(created.status, await created.clone().text()).toBe(201);
      expect((await created.json()).warning).toContain("preconditions[0].commands contains shell operators; retained as data");
      const response = await fixture.inspect();
      expect(response.status, await response.clone().text()).toBe(200);
      const inspected = await response.json();
      expect(inspected.manifest.preconditions).toEqual(preconditions);
      expect(inspected.integrityResult.passed).toBe(true);
    });

    it("still refuses a missing declared skill even when preconditions are malformed", async () => {
      const created = await createFixture(rigSpec, { preconditions: null, skills: ["skills/absent/SKILL.md"] }).create();
      expect(created.status).toBe(500);
      expect((await created.json()).error).toContain("does not exist in source");
    });
  });
});
