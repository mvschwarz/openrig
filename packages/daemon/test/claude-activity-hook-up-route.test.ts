// OPR activity-hook r3 Part 3 — route altitude: the managed-activity-hook delivery-gap warning
// must cross the REAL /api/up route. An apply of a claude-code member that selects
// claude_activity_hooks with the delivery assets unavailable must SUCCEED (rc0 — rigId returned,
// no hard failure) AND carry the exact nonfatal warning in the response body.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
  runtime_resources:
    - id: claude-activity-hooks
      path: runtime/claude-activity-hooks.json
      runtime: claude-code
      type: claude_activity_hooks
profiles:
  default:
    uses:
      skills: []
      runtime_resources: [claude-activity-hooks]
`;

const RIG_YAML = `version: "0.2"
name: activity-warn-route
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;

describe("/api/up — managed activity-hook delivery-gap warning crosses the route (rc0)", () => {
  let db: Database.Database;
  let specDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-up-route-"));
    const agentDir = path.join(specDir, "agents", "impl");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "agent.yaml"), AGENT_YAML);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(specDir, { recursive: true, force: true });
  });

  const realFs = {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readHead: (p: string, n: number) => {
      const buf = Buffer.alloc(n);
      const fd = fs.openSync(p, "r");
      try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
      return buf;
    },
  };

  it("apply of a claude_activity_hooks seat with MISSING delivery assets → rc0 + exact warning in the response", async () => {
    const { app } = createTestApp(db, {
      upRouterFsOps: realFs,
      podInstantiatorFsOps: { exists: (p: string) => fs.existsSync(p), readFile: (p: string) => fs.readFileSync(p, "utf-8") },
      claudeActivityAssets: { relayPath: "/nope/relay.cjs", manifestPath: "/nope/claude.json" },
    });
    const specPath = path.join(specDir, "rig.yaml");
    fs.writeFileSync(specPath, RIG_YAML);

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });
    const body = await res.json();

    // rc0: the apply SUCCEEDED (a rigId came back) — the delivery gap did not gate startup.
    expect(res.status, JSON.stringify(body)).toBeLessThan(400);
    expect(body.rigId, JSON.stringify(body)).toBeDefined();
    // The exact nonfatal warning crossed the route.
    const warnings: string[] = body.warnings ?? [];
    expect(warnings.some((w) => /managed Claude activity hooks cannot be delivered/.test(w)), JSON.stringify(body)).toBe(true);
    expect(warnings.some((w) => w.includes("dev.impl"))).toBe(true);
  });
});
