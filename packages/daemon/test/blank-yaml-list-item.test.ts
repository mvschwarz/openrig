// A blank YAML list item (`- ` with nothing after it) parses to null. The validators
// read `entry["field"]` straight off each list item, so a null entry threw a TypeError
// (a 500 from POST /api/rigs/import/validate) instead of a validation error.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { validateAgentSpec } from "../src/domain/agent-manifest.js";
import { rigspecImportRoutes } from "../src/routes/rigspec.js";

function rigSpec(servicesOverrides: Record<string, unknown> = {}, podOverrides: Record<string, unknown> = {}) {
  return {
    version: "0.2",
    name: "blank-item-rig",
    pods: [{
      id: "dev",
      label: "Development",
      members: [{ id: "impl", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal", cwd: ".", ...podOverrides }],
      edges: [],
    }],
    edges: [],
    services: { kind: "compose", compose_file: "./compose.yaml", ...servicesOverrides },
  };
}

function agentSpec(overrides: Record<string, unknown> = {}) {
  return { version: "0.2", name: "blank-item-agent", ...overrides };
}

describe("a null list item is a validation error, not a TypeError", () => {
  const rigCases: Array<[string, Record<string, unknown>, string]> = [
    ["services.wait_for", { wait_for: [null] }, "services.wait_for[0]"],
    ["services.surfaces.urls", { surfaces: { urls: [null] } }, "surfaces.urls[0]"],
    ["services.surfaces.commands", { surfaces: { commands: [null] } }, "surfaces.commands[0]"],
    ["services.checkpoints", { checkpoints: [null] }, "checkpoints[0]"],
  ];
  for (const [label, services, expected] of rigCases) {
    it(`rig spec: ${label}`, () => {
      const result = RigSpecSchema.validate(rigSpec(services));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes(expected) && e.includes("must be an object")), result.errors.join("\n")).toBe(true);
    });
  }

  it("rig spec: pods[].members[].startup.files", () => {
    const result = RigSpecSchema.validate(rigSpec({}, { startup: { files: [null] } }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("files[0]") && e.includes("must be an object")), result.errors.join("\n")).toBe(true);
  });

  const agentCases: Array<[string, Record<string, unknown>, string]> = [
    ["imports", { imports: [null] }, "imports[0]"],
    ["startup.files", { startup: { files: [null] } }, "files[0]"],
    ["resources.skills", { resources: { skills: [null] } }, "resources.skills[0]"],
    ["resources.guidance", { resources: { guidance: [null] } }, "resources.guidance[0]"],
    ["resources.runtime_resources", { resources: { runtime_resources: [null] } }, "resources.runtime_resources[0]"],
    ["resources.plugins", { resources: { plugins: [null] } }, "resources.plugins[0]"],
  ];
  for (const [label, overrides, expected] of agentCases) {
    it(`agent spec: ${label}`, () => {
      const result = validateAgentSpec(agentSpec(overrides));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes(expected) && e.includes("must be an object")), result.errors.join("\n")).toBe(true);
    });
  }

  it("POST /api/rigs/import/validate answers 200 valid:false for a blank wait_for item, not 500", async () => {
    const app = new Hono();
    app.route("/api/rigs/import", rigspecImportRoutes);
    const yaml = [
      'version: "0.2"', "name: blank-item-rig",
      "pods:", "  - id: dev", "    label: Development", "    members:",
      "      - id: impl", "        agent_ref: builtin:terminal", "        profile: none", "        runtime: terminal", "        cwd: .",
      "    edges: []", "edges: []",
      "services:", "  kind: compose", "  compose_file: ./compose.yaml", "  wait_for:", "    - ", "",
    ].join("\n");
    const res = await app.request("/api/rigs/import/validate", { method: "POST", headers: { "Content-Type": "text/plain" }, body: yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.join("\n")).toContain("wait_for[0]");
  });
});
