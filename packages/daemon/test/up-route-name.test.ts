import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const SPEC = `
version: "0.2"
name: solo
pods:
  - id: work
    label: Work
    members:
      - {id: worker, agent_ref: "builtin:terminal", runtime: terminal, profile: none, cwd: .}
    edges: []
edges: []
`.trim();

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = createFullTestDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-name-"));
  tmpDirs.push(dir);
  const specPath = path.join(dir, "rig.yaml");
  fs.writeFileSync(specPath, SPEC);
  const app = createTestApp(db, {
    upRouterFsOps: {
      exists: (p: string) => fs.existsSync(p),
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
    },
  });
  const post = (route: string, body: Record<string, unknown>) => app.app.request(route, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { db, app, specPath, post };
}

describe("POST /api/up rigName", () => {
  it("hands rigName to bootstrap in plan mode", async () => {
    const { db, app, specPath, post } = setup();
    const bootstrap = vi.spyOn(app.bootstrapOrchestrator, "bootstrap").mockResolvedValue({
      runId: "run", status: "planned", rigId: "rig", stages: [], errors: [], warnings: [],
    } as never);
    const res = await post("/api/up", { sourceRef: specPath, rigName: "alpha", plan: true });
    expect(res.status).toBe(200);
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan", rigName: "alpha" }));
    db.close();
  });

  it.each([["absent", undefined], ["not a string", 3], ["empty", ""]])("launches under the spec's name when rigName is %s", async (_label, rigName) => {
    const { db, app, specPath, post } = setup();
    const bootstrap = vi.spyOn(app.bootstrapOrchestrator, "bootstrap").mockResolvedValue({
      runId: "run", status: "completed", rigId: "rig", stages: [], errors: [], warnings: [],
    } as never);
    const res = await post("/api/up", { sourceRef: specPath, ...(rigName === undefined ? {} : { rigName }) });
    expect(res.status).toBe(201);
    expect(bootstrap.mock.calls[0]![0].rigName).toBeUndefined();
    db.close();
  });

  it.each([["apply", false], ["plan", true]] as const)("answers 400 rig_name_compose_project in %s mode for a spec that sets services.project_name", async (_mode, plan) => {
    const { db, specPath, post } = setup();
    fs.writeFileSync(specPath, SPEC.replace("pods:", "services:\n  kind: compose\n  compose_file: compose.yaml\n  project_name: shared-db\npods:"));
    const res = await post("/api/up", { sourceRef: specPath, rigName: "alpha", ...(plan ? { plan: true } : {}) });
    expect(res.status).toBe(400);
    const body = await res.json() as { stages: Array<{ stage: string; detail?: { code?: string } }> };
    expect(body.stages.find((s) => s.stage === "resolve_spec")?.detail?.code).toBe("rig_name_compose_project");
    db.close();
  });

  // Known limitation, kept on purpose: the launch lock is per source, so two simultaneous launches of one
  // spec answer 409 even under different names. Launched one after the other, both succeed.
  it("two simultaneous launches of one spec under different names: the second answers 409", async () => {
    const { db, app, specPath, post } = setup();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(app.bootstrapOrchestrator, "bootstrap").mockImplementation(async () => {
      await held;
      return { runId: "run", status: "completed", rigId: "rig", stages: [], errors: [], warnings: [] } as never;
    });
    const first = post("/api/up", { sourceRef: specPath, rigName: "alpha" });
    await vi.waitFor(() => expect(app.bootstrapOrchestrator.bootstrap).toHaveBeenCalled());
    const second = await post("/api/up", { sourceRef: specPath, rigName: "beta" });
    expect(second.status).toBe(409);
    finish();
    expect((await first).status).toBe(201);
    expect((await post("/api/up", { sourceRef: specPath, rigName: "beta" })).status).toBe(201);
    db.close();
  });
});
