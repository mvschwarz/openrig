import { expect, it } from "vitest";
import { Hono } from "hono";
import { rigspecImportRoutes } from "../src/routes/rigspec.js";
import { validateRigSpecImport } from "../src/domain/spec-validation-service.js";

it.each([
  ['version: "0.2"\nname: pods\npods: [{ id: dev, label: Dev, members: [{ id: worker, agent_ref: "local:worker", profile: default, runtime: claude-code, cwd: . }], edges: [] }]\nedges: []\n', true],
  ['version: "1"\nname: legacy\nnodes: []\nedges: []\n', true],
  ['version: "0.2"\nname: invalid\npods: []\nunknown_field: true\n', false],
  ['version: "1"\nname: advisory\nnodes: [{ id: worker, runtime: claude-code, model: fable }]\n', true],
])("HTTP validation preserves shared local results: %s", async (yaml, valid) => {
  const app = new Hono().route("/api/rigs/import", rigspecImportRoutes);
  const response = await app.request("/api/rigs/import/validate", { method: "POST", body: yaml });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.valid).toBe(valid);
  expect(result).toEqual(validateRigSpecImport(yaml));
  if (yaml.includes("model: fable")) expect(result.advisories.join("\n")).toContain("claude-fable-5");
  if (yaml.includes("unknown_field")) expect(result.errors.join("\n")).toContain("unknown_field");
});

it("preserves the HTTP parse-error status and parser message", async () => {
  const yaml = "pods: [";
  const app = new Hono().route("/api/rigs/import", rigspecImportRoutes);
  const response = await app.request("/api/rigs/import/validate", { method: "POST", body: yaml });
  expect(response.status).toBe(400);
  const result = await response.json();
  expect(result.valid).toBe(false);
  expect(() => validateRigSpecImport(yaml)).toThrow(result.errors[0]);
});
