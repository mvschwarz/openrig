import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { validateRigSpecImport } from "../src/domain/spec-validation-service.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const sourceRef = resolve(import.meta.dirname, "../assets/openshell/rig.yaml");
const yaml = readFileSync(sourceRef, "utf8");
afterEach(() => vi.restoreAllMocks());
it("the shipped OpenShell example parses and validates with its edge inside the pod", () => {
  expect(validateRigSpecImport(yaml)).toMatchObject({ valid: true, errors: [] });
  const spec = RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>);
  expect(spec.pods[0]!.edges).toContainEqual({ kind: "delegates_to", from: "coordinator", to: "worker" });
  expect(spec.edges ?? []).toEqual([]);
});
it("the ordinary up plan classifies the shipped example without launching seats", async () => {
  const db = createFullTestDb();
  try {
    const f = createTestApp(db, { upRouterFsOps: {
      exists: (path: string) => path === sourceRef,
      readFile: () => yaml,
      readHead: (_path: string, bytes: number) => Buffer.from(yaml).subarray(0, bytes),
    } });
    const plan = vi.spyOn(f.bootstrapOrchestrator, "bootstrap").mockResolvedValue({ runId: "plan", status: "planned", stages: [], errors: [], warnings: [] } as never);
    const result = await f.app.request("/api/up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceRef, plan: true }) });
    expect(result.status, await result.text()).toBe(200);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan", sourceRef }));
    expect(f.tmuxAdapter.createSession).not.toHaveBeenCalled();
  } finally { db.close(); }
});
