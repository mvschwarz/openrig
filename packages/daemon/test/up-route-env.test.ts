import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const SPEC = `
version: "0.2"
name: env-flag-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = createFullTestDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-env-"));
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

// What a request with `envOverride` was answered with before the field meant anything.
const NOT_USABLE: Array<[string, unknown]> = [
  ["null", null],
  ["a list", ["A=1"]],
  ["a string", "A=1"],
  ["a reserved name", { OPENRIG_URL: "http://elsewhere" }],
  ["a lowercase name", { lower: "x" }],
  ["a non-string value", { COUNT: 3 }],
  ["an empty value", { EMPTY: "" }],
  ["one good entry and one bad", { GOOD: "1", bad: "2" }],
];

describe("POST /api/up envOverride", () => {
  it("hands a valid override to the launch", async () => {
    const { db, app, specPath, post } = setup();
    const bootstrap = vi.spyOn(app.bootstrapOrchestrator, "bootstrap").mockResolvedValue({
      runId: "run", status: "completed", rigId: "rig", stages: [], errors: [],
    } as never);
    const res = await post("/api/up", { sourceRef: specPath, envOverride: { DEBUG: "1" } });
    expect(res.status).toBe(201);
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ mode: "apply", envOverride: { DEBUG: "1" } }));
    db.close();
  });

  it.each(NOT_USABLE)("answers a spec request with %s as it does without the field, and launches without an override", async (_label, envOverride) => {
    const { db, app, specPath, post } = setup();
    const bootstrap = vi.spyOn(app.bootstrapOrchestrator, "bootstrap").mockResolvedValue({
      runId: "run", status: "completed", rigId: "rig", stages: [], errors: [],
    } as never);
    const without = await post("/api/up", { sourceRef: specPath });
    const withField = await post("/api/up", { sourceRef: specPath, envOverride });
    expect(withField.status).toBe(without.status);
    expect(withField.status).toBe(201);
    expect(await withField.json()).toEqual(await without.json());
    for (const [call] of bootstrap.mock.calls) expect(call.envOverride).toBeUndefined();
    db.close();
  });

  it.each([["a valid override", { DEBUG: "1" }], ["null", null]])("answers a restore by rig name with %s as it does without the field", async (_label, envOverride) => {
    const { db, app, post } = setup();
    app.rigRepo.createRig("already-here");
    const without = await post("/api/up", { sourceRef: "already-here" });
    const withField = await post("/api/up", { sourceRef: "already-here", envOverride });
    expect(withField.status).toBe(without.status);
    expect(await withField.json()).toEqual(await without.json());
    db.close();
  });
});

describe("POST /api/bundles/install envOverride", () => {
  it.each(NOT_USABLE)("answers a request with %s as it does without the field", async (_label, envOverride) => {
    const { db, post } = setup();
    const bundlePath = path.join(tmpDirs[0]!, "absent.rigbundle");
    const without = await post("/api/bundles/install", { bundlePath, plan: true });
    const withField = await post("/api/bundles/install", { bundlePath, plan: true, envOverride });
    expect(withField.status).toBe(without.status);
    const answer = await withField.json();
    expect(answer).toEqual(await without.json());
    expect(answer.code).not.toBe("invalid_env");
    db.close();
  });
});
