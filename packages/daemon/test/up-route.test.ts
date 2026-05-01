import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const VALID_SPEC = `
schema_version: 1
name: r99
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

describe("Up API route", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;
  let rigRepo: RigRepository;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-"));
    // Create test app with real UpCommandRouter fsOps pointing to tmpDir
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    snapshotCapture = setup.snapshotCapture;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // T5: Missing sourceRef -> 400
  it("POST /api/up with missing sourceRef returns 400", async () => {
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // T2: Unknown source -> 400
  it("POST /api/up with nonexistent source returns 400", async () => {
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "/nonexistent/file.yaml" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // T6: Startup wiring
  it("createDaemon wires /api/up route", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });
    try {
      const res = await daemonApp.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400); // Proves route is mounted
    } finally {
      daemonDb.close();
    }
  });

  it("POST /api/up restoring an existing rig name includes rigResult", async () => {
    const rig = rigRepo.createRig("restore-me");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "restore-me" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.rigResult).toBe("partially_restored");
    expect(body.nodes[0].status).toBe("fresh");
  });

  it("POST /api/up restoring an existing rig name returns validation blockers", async () => {
    const rig = rigRepo.createRig("restore-blocked");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    const data = JSON.parse(JSON.stringify(snap.data));
    const node = data.nodes[0];
    const missingPath = `/tmp/openrig-slice7-up-missing-${Date.now()}.md`;
    data.nodeStartupContext[node.id] = {
      projectionEntries: [],
      resolvedStartupFiles: [{
        path: "startup.md",
        absolutePath: missingPath,
        ownerRoot: "/tmp",
        deliveryHint: "guidance_merge",
        required: true,
        appliesOn: ["restore"],
      }],
      startupActions: [],
      runtime: "claude-code",
    };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "restore-blocked" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("not_attempted");
    expect(body.code).toBe("pre_restore_validation_failed");
    expect(body.rigResult).toBe("not_attempted");
    expect(body.blockers[0].path).toBe(missingPath);
  });

  // L3b: rig-name path falls back to manual snapshot when no auto-pre-down exists.
  // Both routes preserve auto-pre-down preference and echo `snapshotKind`.
  describe("L3b snapshot-selection fallback", () => {
    it("auto-pre-down preferred when present; response echoes snapshotKind=auto-pre-down", async () => {
      const rig = rigRepo.createRig("auto-pref");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      // Capture manual first, then auto-pre-down. Auto-pre-down must win.
      snapshotCapture.captureSnapshot(rig.id, "manual");
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "auto-pref" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("auto-pre-down");
    });

    it("falls back to manual snapshot when no auto-pre-down exists; response echoes snapshotKind=manual", async () => {
      const rig = rigRepo.createRig("manual-only");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "manual");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "manual-only" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("manual");
    });

    it("returns 404 with updated 'no restore-usable snapshot' message when no usable snapshot exists", async () => {
      rigRepo.createRig("no-snap");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "no-snap" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("no_snapshot");
      expect(body.error).toContain("restore-usable");
      // Old message specifically said "auto-pre-down" — must NOT anymore.
      expect(body.error).not.toContain("auto-pre-down snapshot");
    });
  });

  // Agent Starter v1 vertical M2 — POST /api/up wiring proof for starter_ref.
  //
  // These tests exercise the spec-resolution path (sourceKind=rig_spec) by
  // injecting a real-fs upRouter into createTestApp. The positive case
  // demonstrates that a pod-aware spec with `starter_ref:` flows through
  // validation cleanly. The two negatives demonstrate that the schema's
  // composition rules surface as 400 responses through the route.
  //
  // The "failed-scan launch abort" negative is intentionally NOT tested at
  // this level — the resolver runs only at apply-time inside the
  // instantiator, and that behavior is already proven in
  // `agent-starter-instantiator.test.ts` ("resolver throw aborts launch").
  // Re-proving it through the HTTP layer would require fully wiring the
  // bootstrap apply path with real fixtures, which is broader than this
  // wiring proof needs.
  describe("M2: POST /api/up with starter_ref", () => {
    let specDir: string;
    let app2: ReturnType<typeof createTestApp>["app"];
    let db2: Database.Database;

    beforeEach(() => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-starter-"));
      db2 = createFullTestDb();
      const fsOps = {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, n: number) => {
          const buf = Buffer.alloc(n);
          const fd = fs.openSync(p, "r");
          try {
            fs.readSync(fd, buf, 0, n, 0);
          } finally {
            fs.closeSync(fd);
          }
          return buf;
        },
      };
      const setup = createTestApp(db2, { upRouterFsOps: fsOps });
      app2 = setup.app;
    });

    afterEach(() => {
      db2.close();
      fs.rmSync(specDir, { recursive: true, force: true });
    });

    function writeSpec(name: string, body: string): string {
      const p = path.join(specDir, name);
      fs.writeFileSync(p, body, "utf-8");
      return p;
    }

    it("accepts a pod-aware spec with starter_ref in plan mode (positive wiring proof)", async () => {
      const yaml = `version: "0.2"
name: starter-positive
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: openrig-builder-base--claude-code
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-positive.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath, plan: true }),
      });
      // The upRouter classifies as rig_spec (validation passed). Bootstrap
      // plan may fail later stages (e.g., agent file resolution against an
      // empty test cwd), but the spec MUST clear validation — proving
      // `starter_ref` does not trip the schema. Status 200/400 are both
      // acceptable wiring proofs as long as the body is NOT a top-level
      // validation_failed error from upRouter.route().
      const body = await res.json();
      expect(body.error ?? "").not.toContain("not a valid rig spec");
      expect(body.error ?? "").not.toContain("does not match composition rules");
    });

    it("rejects fork + starter_ref composition with 400 (terminal-equivalent route surface)", async () => {
      const yaml = `version: "0.2"
name: starter-fork-reject
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: openrig-builder-base--claude-code
        session_source:
          mode: fork
          ref:
            kind: native_id
            value: some-id
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-fork-reject.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath, plan: true }),
      });
      // Pod-aware composition rule (validateStarterRef in rigspec-schema)
      // rejects fork+starter_ref, so the upRouter does NOT classify the
      // YAML as a valid pod-aware rig_spec. The route returns 400.
      // (Pre-existing UX caveat: the error message bubbles from the
      // legacy fallthrough, not from the pod-aware validator — but the
      // contract behavior of REJECTING the spec is what M2 requires.)
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("not a valid rig spec");
    });

    it("rejects terminal + starter_ref composition with 400", async () => {
      const yaml = `version: "0.2"
name: starter-terminal-reject
pods:
  - id: dev
    label: Development
    members:
      - id: t1
        agent_ref: local:agents/t1
        profile: default
        runtime: terminal
        cwd: .
        starter_ref:
          name: openrig-builder-base--claude-code
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-terminal-reject.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath, plan: true }),
      });
      // Pod-aware composition rule rejects terminal+starter_ref. Route
      // returns 400 (same caveat as the fork case above re: error
      // message provenance — the contract behavior of rejection is what
      // M2 requires).
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("not a valid rig spec");
    });
  });
});
