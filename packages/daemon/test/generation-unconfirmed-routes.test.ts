// #141: a YAML import refused because a same-name rig could not be confirmed stopped is a 409 conflict with
// its actionable message on both import routes, not a 500. Same stubbed seam as the running-name route tests.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

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

describe("#141 generation_unconfirmed crosses both import routes as a 409", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmpDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    // The earlier rig's tmux session is reported present, so it can't be confirmed stopped.
    const tmux = Object.assign(mockTmuxAdapter(), { probeSession: vi.fn(async () => ({ state: "present" })) }) as unknown as TmuxAdapter;
    setup = createTestApp(db, {
      tmux,
      upRouterFsOps: {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, n: number) => {
          const fd = fs.openSync(p, "r");
          try { const buf = Buffer.alloc(n); return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0)); } finally { fs.closeSync(fd); }
        },
      },
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-unconfirmed-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedStoppedRig(name: string) {
    const rig = setup.rigRepo.createRig(name);
    const node = setup.rigRepo.addNode(rig.id, "crew.a", { runtime: "claude-code", cwd: "/" });
    const session = setup.sessionRegistry.registerSession(node.id, `crew-a@${name}`);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: `crew-a@${name}` });
    setup.sessionRegistry.updateStatus(session.id, "detached");
    return rig;
  }

  const rigCount = (name: string) => (db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE name = ?").get(name) as { c: number }).c;

  it("POST /api/rigs/import: 409, top-level code, actionable error naming the earlier rig, nothing created", async () => {
    const rig = seedStoppedRig("gen-import");
    const res = await setup.app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Rig-Root": "/tmp" },
      body: POD_YAML("gen-import"),
    });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body["code"]).toBe("generation_unconfirmed");
    expect(String(body["error"])).toContain(rig.id);
    expect(String(body["error"])).toMatch(/nothing was created/i);
    expect(rigCount("gen-import")).toBe(1);
  });

  it("POST /api/up: 409, top-level code, actionable error naming the earlier rig, nothing created", async () => {
    const rig = seedStoppedRig("gen-up");
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, POD_YAML("gen-up"));
    const res = await setup.app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body["code"]).toBe("generation_unconfirmed");
    expect(String(body["error"])).toContain(rig.id);
    expect(rigCount("gen-up")).toBe(1);
  });
});
