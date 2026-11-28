import { beforeEach, afterEach, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { BootstrapRepository } from "../src/domain/bootstrap-repository.js";

let root: string;
let db: ReturnType<typeof createFullTestDb>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "project-cwd-errors-"));
  vi.stubEnv("OPENRIG_WORKSPACE_CATALOG_PATH", path.join(root, "absent-catalog.yaml"));
  db = createFullTestDb();
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

it("legacy Codex preflight reports one project error, without throwing again in its reach advisory", async () => {
  const check = new RigSpecPreflight({ rigRepo: new RigRepository(db), tmuxAdapter: mockTmuxAdapter(), exec: vi.fn(async () => "codex 1.0"), cmuxExec: vi.fn(async () => "") });
  const result = await check.check({ schemaVersion: 1, name: "legacy", version: "1.0", nodes: [{ id: "worker", runtime: "codex", cwd: "${project:missing}" }], edges: [] });
  expect(result.ready).toBe(false);
  expect(result.errors).toEqual([expect.stringContaining("Register that project or supply --cwd")]);
});

it.each(["rig_spec", "rig_bundle"] as const)("legacy %s bootstrap classifies project resolution as preflight, not a read/parse error", async sourceKind => {
  const specPath = path.join(root, "rig.yaml");
  fs.writeFileSync(specPath, JSON.stringify({ schema_version: 1, name: "legacy", version: "1.0", nodes: [{ id: "worker", runtime: "codex", cwd: "${project:missing}" }], edges: [] }));
  const bootstrap = new BootstrapOrchestrator({ db, bootstrapRepo: new BootstrapRepository(db), runtimeVerifier: { db }, installExecutor: { db }, packageInstallService: { db }, fsOps: { readFile: p => fs.readFileSync(p, "utf8"), exists: fs.existsSync }, bundleSourceResolver: { resolve: async () => ({ specPath, tempDir: root, manifest: {} }), cleanup: vi.fn() } } as ConstructorParameters<typeof BootstrapOrchestrator>[0]);
  const result = await bootstrap.bootstrap({ sourceKind, sourceRef: sourceKind === "rig_spec" ? specPath : path.join(root, "fixture.rigbundle"), mode: "plan" });
  expect(result.status).toBe("failed");
  expect(result.errors).toEqual([expect.stringContaining("Register that project or supply --cwd")]);
  expect(result.stages.at(-1)).toMatchObject({ stage: "preflight", status: "blocked", detail: { code: "preflight_failed" } });
});

it("materialize-only returns preflight_failed and rolls back the transaction; an explicit cwd still materializes", async () => {
  const app = createTestApp(db);
  const source = JSON.stringify({ version: "0.2", name: "materialized-project", pods: [{ id: "dev", label: "Dev", members: [{ id: "worker", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "${project:missing}" }], edges: [] }], edges: [] });
  const result = await app.podInstantiator.materialize(source, root);
  expect(result).toMatchObject({ ok: false, code: "preflight_failed", errors: [expect.stringContaining("Register that project or supply --cwd")] });
  expect(app.rigRepo.listRigs()).toHaveLength(0);
  const override = await app.podInstantiator.materialize(source, root, { cwdOverride: root });
  expect(override.ok, JSON.stringify(override)).toBe(true);
  if (override.ok) expect(app.rigRepo.getRig(override.result.rigId)?.nodes[0]?.cwd).toBe(root);
});
