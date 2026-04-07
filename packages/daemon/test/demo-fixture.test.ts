import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { parseAgentSpec } from "../src/domain/agent-manifest.js";

const DEMO_ROOT = path.resolve(__dirname, "../../../demo");

describe("Demo fixture validation", () => {
  // Test 1: Demo rig.yaml validates
  it("demo rig.yaml passes RigSpecSchema validation", () => {
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const raw = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);
    if (!validation.valid) {
      console.error("Validation errors:", validation.errors);
    }
  });

  // Test 2: All demo agent specs validate
  it("all demo agent specs parse and validate", () => {
    const agentDirs = fs.readdirSync(path.join(DEMO_ROOT, "agents"));
    expect(agentDirs.length).toBeGreaterThanOrEqual(6);

    for (const dir of agentDirs) {
      const specPath = path.join(DEMO_ROOT, "agents", dir, "agent.yaml");
      expect(fs.existsSync(specPath)).toBe(true);
      const yaml = fs.readFileSync(specPath, "utf-8");
      const result = parseAgentSpec(yaml);
      expect(result.name).toBe(dir);
    }
  });

  // Test 3: Demo rig spec has correct topology
  it("demo rig has 4 pods with 8 members total", () => {
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const raw = RigSpecCodec.parse(yaml);
    const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
    expect(spec.pods).toHaveLength(4);
    const totalMembers = spec.pods.reduce((sum, pod) => sum + pod.members.length, 0);
    expect(totalMembers).toBe(8);
  });

  it("demo infra.ui startup binds the dev server to 127.0.0.1 for rig ui open", () => {
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const raw = RigSpecCodec.parse(yaml);
    const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
    const infraPod = spec.pods.find((pod) => pod.id === "infra");
    const uiMember = infraPod?.members.find((member) => member.id === "ui");
    const startupAction = uiMember?.startup?.actions?.[0];

    expect(startupAction?.value).toBe("npm run dev -- --host 127.0.0.1");
  });

  // Test 4: Demo rig-root inference resolves correctly
  it("rig-root infers to demo/ directory from rig.yaml path", () => {
    const rigYamlPath = path.join(DEMO_ROOT, "rig.yaml");
    const inferredRoot = path.dirname(rigYamlPath);
    expect(inferredRoot).toBe(DEMO_ROOT);
    // Agent refs should resolve from this root
    expect(fs.existsSync(path.join(inferredRoot, "agents", "lead", "agent.yaml"))).toBe(true);
  });

  // Test 5: No absolute paths or path traversal in fixture
  it("demo fixture has no absolute paths or path traversal", () => {
    const rigYaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    expect(rigYaml).not.toMatch(/path:\s*\//); // No absolute paths
    expect(rigYaml).not.toContain("../"); // No path traversal

    const agentDirs = fs.readdirSync(path.join(DEMO_ROOT, "agents"));
    for (const dir of agentDirs) {
      const specYaml = fs.readFileSync(path.join(DEMO_ROOT, "agents", dir, "agent.yaml"), "utf-8");
      expect(specYaml).not.toMatch(/path:\s*\//);
      expect(specYaml).not.toContain("../");
    }
  });

  // Test 6: Culture file exists
  it("demo culture.md exists", () => {
    expect(fs.existsSync(path.join(DEMO_ROOT, "culture.md"))).toBe(true);
  });

  // Test 7: Demo rig preflight resolves all agent refs
  it("demo rig preflight resolves all agent refs", async () => {
    const { rigPreflight } = await import("../src/domain/rigspec-preflight.js");
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const fsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
    };
    const result = rigPreflight({ rigSpecYaml: yaml, rigRoot: DEMO_ROOT, fsOps });
    const agentErrors = result.errors.filter((e: string) => e.includes("agent_ref resolution failed"));
    expect(agentErrors).toHaveLength(0);
    // Full preflight should pass (may have runtime warnings in test env, but ready should be true
    // if only runtime availability is the issue)
    const nonRuntimeErrors = result.errors.filter((e: string) => !e.includes("unsupported runtime") && !e.includes("not available"));
    expect(nonRuntimeErrors).toHaveLength(0);
    // Demo rig preflight should pass — all agent specs exist and runtimes are supported
    expect(result.ready).toBe(true);
  });

  // Test 8: Demo teardown leaves clean state (via RigTeardownOrchestrator mock)
  it("demo rig teardown cleans up sessions and bindings", async () => {
    const { createFullTestDb } = await import("./helpers/test-app.js");
    const { RigRepository } = await import("../src/domain/rig-repository.js");
    const { SessionRegistry } = await import("../src/domain/session-registry.js");
    const { EventBus } = await import("../src/domain/event-bus.js");
    const { SnapshotCapture } = await import("../src/domain/snapshot-capture.js");
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const { CheckpointStore } = await import("../src/domain/checkpoint-store.js");
    const { RigTeardownOrchestrator } = await import("../src/domain/rig-teardown.js");

    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });

    // Create a rig with a session (simulating demo state)
    const rig = rigRepo.createRig("demo-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "orch-lead@demo-rig");
    sessionRegistry.updateStatus(session.id, "running");

    const tmux = {
      killSession: async () => ({ ok: true as const }),
      createSession: async () => ({ ok: true as const }),
      listSessions: async () => [],
      hasSession: async () => false,
      sendText: async () => ({ ok: true as const }),
      sendKeys: async () => ({ ok: true as const }),
      listWindows: async () => [],
      listPanes: async () => [],
    } as any;

    const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus });
    const result = await teardown.teardown(rig.id);

    expect(result.sessionsKilled).toBe(1);
    expect(result.snapshotId).toBeTruthy(); // auto-pre-down snapshot created
    expect(result.errors).toHaveLength(0);

    // Session should be exited
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const latest = sessions[sessions.length - 1];
    expect(latest?.status).toBe("exited");

    db.close();
  });
});
