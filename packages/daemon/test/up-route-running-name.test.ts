// S5b final fix, R2 F1 (row r054-s5b-final-fix) — the rig_name_running refusal
// must SURVIVE the real /api/up boundary: structured non-500 (409 conflict),
// top-level code, top-level error carrying the guard's teaching text — instead
// of the pre-fix bare 500 with the code buried in stages[].detail.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const POD_YAML = (name: string) => [
  'version: "0.2"',
  `name: ${name}`,
  "pods:",
  "  - id: crew",
  "    label: Crew",
  "    members:",
  "      - id: a",
  '        agent_ref: "builtin:terminal"',
  '        profile: "none"',
  "        runtime: terminal",
  "        cwd: /",
  "    edges: []",
  "edges: []",
].join("\n");

describe("POST /api/up — running-name refusal crosses the route boundary (S5b F1)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmpDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    // Real-fs upRouter so POST /api/up can resolve the on-disk YAML spec
    // (the harness default fsOps is always-false).
    setup = createTestApp(db, {
      upRouterFsOps: {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, n: number) => {
          const fd = fs.openSync(p, "r");
          try {
            const buf = Buffer.alloc(n);
            const read = fs.readSync(fd, buf, 0, n, 0);
            return buf.subarray(0, read);
          } finally { fs.closeSync(fd); }
        },
      },
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-rnr-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRunningRig(name: string) {
    const rig = setup.rigRepo.createRig(name);
    const node = setup.rigRepo.addNode(rig.id, "crew.a", { runtime: "claude-code", cwd: "/" });
    const session = setup.sessionRegistry.registerSession(node.id, `crew-a@${name}`);
    setup.sessionRegistry.updateStatus(session.id, "running");
    return rig;
  }

  function rigCount(name: string): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE name = ?").get(name) as { c: number }).c;
  }

  it("second up of a RUNNING name: 409, top-level rig_name_running, teaching error, nothing created or launched", async () => {
    const rig = seedRunningRig("dupe-route");
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, POD_YAML("dupe-route"));
    const createSession = (setup.tmuxAdapter as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession;

    const res = await setup.app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });
    const body = await res.json() as Record<string, unknown>;

    // The structured non-500 refusal with the code at the TOP LEVEL.
    expect(res.status).toBe(409);
    expect(body["code"]).toBe("rig_name_running");
    // The teaching content survives to the top-level error field.
    const error = String(body["error"] ?? "");
    expect(error).toContain("dupe-route");
    expect(error).toContain(rig.id);
    expect(error).toMatch(/nothing was created or launched/i);
    expect(error).toMatch(/rig down/);

    // Effect side: nothing created, nothing launched.
    expect(rigCount("dupe-route")).toBe(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("control: up of a fresh name through the same route is not affected", async () => {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, POD_YAML("fresh-route"));

    const res = await setup.app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });

    // Whatever this harness's launch outcome is, the guard refusal must not fire.
    const body = await res.json() as Record<string, unknown>;
    expect(body["code"]).not.toBe("rig_name_running");
    expect(rigCount("fresh-route")).toBe(1);
  });
});
