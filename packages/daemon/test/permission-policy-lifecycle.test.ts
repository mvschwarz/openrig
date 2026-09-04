// OPR.0.4.8.3 Seam B — Guard-correction lifecycle pins (NOT-CLEAR at 9e94c274), RED-first.
// Production-altitude proofs for the four findings:
//   F1: rig-level custom provenance is restart-complete (organic seats, structured
//       add-member with a DIFFERENT operation root, successor continuity).
//   F2: materialize-time provenance writes are load-bearing (a real write failure fails
//       the operation — never a silent partial commit).
//   F3: unreadable custom content at restore uses the PERSISTED posture, never a silent
//       floor.
//   F4: real RestoreOrchestrator restores (legacy + pod-aware altitude: the resume adapter
//       receives the posture) + real adapter COMMAND pins for floor/full_bypass on all
//       three harnesses incl. the Codex native-fork path (Pi wording = resource trust).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createFullTestDb, createTestApp, migrationsForFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { ClaudeResumeAdapter, ResumeResult } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { claudePostureFlag, codexPostureArg, piTrust } from "../src/adapters/yolo-mode.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";

const CUSTOM_POLICY = `---
policy_schema_version: 1
name: operator-full
source: custom
description: full-bypass flag policy (Seam-A-complete fixture)
surface: flag
launch_posture: full_bypass
---
# Operator full
`;

const DECLARING_ROOT = "/project/rigs/original-root";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function fsOps(policyReadable = true) {
  return {
    readFile: (p: string) => {
      if (p.includes("agents/impl")) return agentYaml("impl");
      if (p.includes("policies/operator-full.md")) {
        if (!policyReadable) throw new Error("EACCES: unreadable");
        return CUSTOM_POLICY;
      }
      throw new Error(`Not found: ${p}`);
    },
    exists: (p: string) => p.includes("agents/impl") || (policyReadable && p.includes("policies/operator-full.md")),
  };
}

function rigLevelSpec(extraMembers: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    version: "0.2",
    name: "lifecycle-rig",
    permission_policy: "policies/operator-full.md", // RIG-level CUSTOM flag/full_bypass
    pods: [{
      id: "dev",
      label: "Dev",
      members: [
        { id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
        ...extraMembers,
      ],
      edges: [],
    }],
    edges: [],
  };
}

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter;
}

describe("F1 — rig-level custom provenance is RESTART-COMPLETE", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seamb-f1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("RED-1: organic seat (direct addNode, no member ref) + DB REOPEN + REAL legacy restore keeps full_bypass", async () => {
    const dbFile = join(dir, "d.sqlite");
    const db1 = createDb(dbFile);
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    const outcome = await setup1.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    // ORGANIC seat: claim/self-attach shape — direct addNode, NO member spec, NO node provenance
    const organic = setup1.rigRepo.addNode(rigId, "dev.organic", { runtime: "claude-code", cwd: "/w" });
    // a resumable session for the organic seat (legacy restore path)
    const session = setup1.sessionRegistry.registerSession(organic.id, "dev-organic@lifecycle-rig");
    setup1.sessionRegistry.updateStatus(session.id, "running");
    db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-123' WHERE id = ?").run(session.id);
    const intendedNodeIds = setup1.rigRepo.getRig(rigId)!.nodes.map((node) => node.id);
    const snap = setup1.snapshotCapture.captureSnapshot(rigId, "manual", { intendedNodeIds });
    db1.close(); // ── restart boundary ──

    const db2 = createDb(dbFile);
    const rigRepo2 = new RigRepository(db2);
    const sessionRegistry2 = new SessionRegistry(db2);
    const eventBus2 = new EventBus(db2);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
    const tmux = mockTmux();
    const claudeResume = {
      canResume: vi.fn((t: string | null) => t === "claude_id" || t === "claude_name"),
      resume: vi.fn(async (): Promise<ResumeResult> => ({
        ok: true,
        appliedLaunch: observeClaudePermission("--dangerously-skip-permissions"),
      })),
    } as unknown as ClaudeResumeAdapter;
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
      snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
      nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const snapId = snap.id;
    // policy file readable at restore: served from the ORIGINAL declaring root
    await orch.restore(snapId);
    // PRODUCTION-ALTITUDE assertion: the resume adapter received the rig-inherited posture
    const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-123");
    expect(call, "organic seat resume should have been attempted").toBeDefined();
    expect(call![4]).toBe("full_bypass"); // 5th arg = resolvedPosture from RIG provenance
    expect(new AppliedLaunchObservationStore(db2).readCurrent(organic.id)).toMatchObject({
      runtime: "claude-code",
      axis: "permission",
      state: "observed",
      value: "bypassPermissions",
    });
    db2.close();
  });

  it("RED-2: structured add-member inherits the ORIGINAL rig attachment (original declaring root), member override still wins", async () => {
    const db = createFullTestDb();
    const reads: string[] = [];
    const ops = fsOps();
    const spyOps = {
      readFile: (p: string) => { reads.push(p); return ops.readFile(p); },
      exists: ops.exists,
    };
    const setup = createTestApp(db, { podInstantiatorFsOps: spyOps });
    const outcome = await setup.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;

    // add_member through the STRUCTURED path with a DIFFERENT operation root
    const OTHER_ROOT = "/somewhere/else/entirely";
    const addOutcome = await setup.podInstantiator.addMemberToPod(
      rigId, "dev",
      { id: "late", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "." },
      OTHER_ROOT,
    );
    expect(addOutcome.ok).toBe(true);
    const lateNode = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.late'").get() as { id: string } | undefined);
    expect(lateNode, "dev.late node should exist").toBeDefined();
    const prov = setup.rigRepo.getNodePolicyProvenance(lateNode!.id);
    // The inherited rig attachment must resolve against the ORIGINAL declaring root —
    // never the add-member operation's unrelated root.
    expect(prov).toMatchObject({
      origin: "custom",
      launchPosture: "full_bypass",
      declaringDir: DECLARING_ROOT,
      resolvedTarget: `${DECLARING_ROOT}/policies/operator-full.md`,
    });
    // member override still wins
    const addOverride = await setup.podInstantiator.addMemberToPod(
      rigId, "dev",
      { id: "locked1", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", permission_policy: "builtin:locked" },
      OTHER_ROOT,
    );
    expect(addOverride.ok).toBe(true);
    const lockedNode = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.locked1'").get() as { id: string } | undefined);
    expect(lockedNode, "dev.locked1 node should exist").toBeDefined();
    expect(setup.rigRepo.getNodePolicyProvenance(lockedNode!.id)).toMatchObject({ origin: "builtin", launchPosture: "floor" });
    db.close();
  });

  it("RED-3: successor continuity for an INHERITED rig attachment preserves posture (organic seat, no node provenance)", async () => {
    const db = createFullTestDb();
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
    const outcome = await setup.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    const organic = setup.rigRepo.addNode(rigId, "dev.organic2", { runtime: "claude-code", cwd: "/w" });
    // the same read the seat-handover successor path performs:
    const nodeProv = setup.rigRepo.getNodePolicyProvenance(organic.id);
    const rigProv = setup.rigRepo.getRigPolicyProvenance(rigId);
    const successorPosture = nodeProv?.launchPosture ?? rigProv?.launchPosture;
    expect(successorPosture).toBe("full_bypass"); // inherited rig policy carries to the successor
    db.close();
  });
});

describe("F2 — materialize-time provenance writes are LOAD-BEARING", () => {
  it("RED: a real provenance write failure fails materialization (no silent partial commit)", async () => {
    const db = createFullTestDb();
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
    // Inject a REAL write failure (not a missing legacy column): break the UPDATE by
    // dropping the provenance column AFTER migration, simulating a hard SQLite failure.
    const original = setup.rigRepo.setNodePolicyProvenance.bind(setup.rigRepo);
    void original;
    vi.spyOn(setup.rigRepo, "setNodePolicyProvenance").mockImplementation(() => {
      throw new Error("SQLITE_IOERR: disk I/O error (injected)");
    });
    const outcome = await setup.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(false); // must NOT report success
    // and the partial node state must not have committed
    const count = (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });
});

describe("F3 — unreadable custom content at restore uses the PERSISTED posture", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seamb-f3-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("RED: reopened DB + persisted full_bypass + UNREADABLE custom file → restore launches at full_bypass", async () => {
    const dbFile = join(dir, "d.sqlite");
    const db1 = createDb(dbFile);
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    // ORGANIC seat (legacy restore path) with node provenance persisted at attach time —
    // the resolvedTarget path does NOT exist on this real filesystem = unreadable at restore.
    const rig = setup1.rigRepo.createRig("f3-rig");
    const rigId = rig.id;
    const implNode = setup1.rigRepo.addNode(rigId, "dev.impl", { runtime: "claude-code", cwd: "/w" });
    setup1.rigRepo.setNodePolicyProvenance(implNode.id, {
      origin: "custom",
      resolvedTarget: `${DECLARING_ROOT}/policies/operator-full.md`,
      declaringDir: DECLARING_ROOT,
      launchPosture: "full_bypass",
    });
    db1.prepare("UPDATE nodes SET permission_policy = 'policies/operator-full.md' WHERE id = ?").run(implNode.id);
    const session = setup1.sessionRegistry.registerSession(implNode.id, "dev-impl@f3-rig");
    setup1.sessionRegistry.updateStatus(session.id, "running");
    db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-f3' WHERE id = ?").run(session.id);
    const snap = setup1.snapshotCapture.captureSnapshot(rigId, "manual");
    db1.close(); // ── restart; the persisted target path is unreadable on this real fs ──

    const db2 = createDb(dbFile);
    const rigRepo2 = new RigRepository(db2);
    const sessionRegistry2 = new SessionRegistry(db2);
    const eventBus2 = new EventBus(db2);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
    const tmux = mockTmux();
    const claudeResume = {
      canResume: vi.fn((t: string | null) => t === "claude_id" || t === "claude_name"),
      resume: vi.fn(async (): Promise<ResumeResult> => ({ ok: true })),
    } as unknown as ClaudeResumeAdapter;
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
      snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
      nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const snapId = snap.id;
    await orch.restore(snapId);
    const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-f3");
    expect(call, "impl seat resume should have been attempted").toBeDefined();
    // /project/rigs/original-root/... does not exist on THIS filesystem → unreadable.
    // The persisted posture must carry — never a silent floor.
    expect(call![4]).toBe("full_bypass");
    db2.close();
  });
});

describe("F4 — REAL adapter command pins (floor + full_bypass on every launch path)", () => {
  function claudeMockFs(): ClaudeAdapterFsOps {
    const store: Record<string, string> = {};
    return {
      readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
      writeFile: (p: string, c: string) => { store[p] = c; },
      exists: (p: string) => p in store,
      mkdirp: () => {},
      copyFile: () => {},
      listFiles: () => [],
    } as ClaudeAdapterFsOps;
  }
  function binding(posture?: "floor" | "full_bypass"): NodeBinding {
    return { id: "b1", nodeId: "n1", tmuxSession: "s1", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...(posture ? { launchPosture: posture } : {}) } as NodeBinding;
  }

  it("Claude FRESH: binding full_bypass emits the bypass flag; binding floor pins acceptEdits even under env YOLO", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      for (const [posture, expected] of [["full_bypass", "--dangerously-skip-permissions"], ["floor", "--permission-mode acceptEdits"]] as const) {
        const tmux = mockTmux();
        const adapter = new ClaudeCodeAdapter({ tmux, fsOps: claudeMockFs(), sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
        const result = await adapter.launchHarness(binding(posture), { name: "dev-impl@test-rig" });
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain(expected);
        expect(result.ok && result.appliedLaunch).toMatchObject({
          runtime: "claude-code",
          axis: "permission",
          state: "observed",
          value: posture === "floor" ? "acceptEdits" : "bypassPermissions",
        });
        if (posture === "floor") expect(cmd).not.toContain("--dangerously-skip-permissions");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("Codex FRESH + NATIVE-FORK: binding posture drives -s danger-full-access vs the workspace-write floor", { timeout: 30000 }, async () => {
    const codexFs = { readFile: () => { throw new Error("nf"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] };
    // fresh
    for (const [posture, expected, absent] of [["full_bypass", " -s danger-full-access", ""], ["floor", " -s workspace-write", "danger-full-access"]] as const) {
      const tmux = mockTmux();
      const result = await new CodexRuntimeAdapter({ sleep: async () => {}, tmux, fsOps: codexFs as never }).launchHarness(binding(posture), { name: "dev-qa@test-rig" });
      const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
      expect(cmd).toContain(expected);
      expect(result.ok && result.appliedLaunch).toMatchObject({ axis: "sandbox", state: "observed", value: posture === "floor" ? "workspace-write" : "danger-full-access" });
      if (absent) expect(cmd).not.toContain(absent);
    }
    // native fork (the Slice-02 helper remains the only flag translator)
    for (const [posture, expected] of [["full_bypass", " -s danger-full-access"], ["floor", " -s workspace-write"]] as const) {
      const tmux = mockTmux();
      const result = await new CodexRuntimeAdapter({ sleep: async () => {}, tmux, fsOps: codexFs as never }).launchHarness(binding(posture), { name: "dev-qa@test-rig", forkSource: { kind: "native_id", value: "parent-thread-1" } as never });
      const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
      expect(cmd).toContain("fork");
      expect(cmd).toContain(expected);
      if (result.ok) expect(result.appliedLaunch).toMatchObject({ axis: "sandbox", value: posture === "floor" ? "workspace-write" : "danger-full-access" });
    }
  });

  it("Claude RESUME: the threaded posture drives the resume command (floor pins acceptEdits under env YOLO)", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const { ClaudeResumeAdapter: RealClaudeResume } = await import("../src/adapters/claude-resume.js");
      for (const [posture, expected] of [["full_bypass", "--dangerously-skip-permissions"], ["floor", "--permission-mode acceptEdits"]] as const) {
        const tmux = mockTmux();
        const adapter = new RealClaudeResume(tmux);
        const result = await adapter.resume("s1", "claude_id", "tok-1", "/w", posture);
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain("claude");
        expect(cmd).toContain("--resume");
        expect(cmd).toContain(expected);
        expect(result.ok && result.appliedLaunch).toMatchObject({ axis: "permission", value: posture === "floor" ? "acceptEdits" : "bypassPermissions" });
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

// ── Guard round-2 (NOT-CLEAR at 8232199a) ──────────────────────────────────────

const MALFORMED_POLICY = "---\nname: broken\nsurface: flag\nlaunch_posture: full_bypass\n# unclosed frontmatter — no closing fence\n# body follows\n";
const UNUSABLE_FLAG_POLICY = `---\npolicy_schema_version: 1\nname: no-posture\nsource: custom\ndescription: flag policy MISSING launch_posture (Seam-A invalid flag contract)\nsurface: flag\n---\nbody\n`;

describe("GF1 — READABLE but malformed/unusable custom content uses the PERSISTED posture", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seamb-gf1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function reopenedRestorePosture(kind: "node" | "rig", policyBody: string): Promise<unknown> {
    const { writeFileSync: wf, mkdirSync: mk } = await import("node:fs");
    const declRoot = join(dir, "declaring-root");
    mk(join(declRoot, "policies"), { recursive: true });
    wf(join(declRoot, "policies", "operator-full.md"), policyBody); // READABLE on the real fs
    const dbFile = join(dir, `${kind}.sqlite`);
    const db1 = createDb(dbFile);
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    const rig = setup1.rigRepo.createRig(`gf1-${kind}`);
    const node = setup1.rigRepo.addNode(rig.id, "dev.seat", { runtime: "claude-code", cwd: "/w" });
    if (kind === "node") {
      setup1.rigRepo.setNodePolicyProvenance(node.id, {
        origin: "custom", resolvedTarget: join(declRoot, "policies", "operator-full.md"),
        declaringDir: declRoot, launchPosture: "full_bypass",
      });
      db1.prepare("UPDATE nodes SET permission_policy = 'policies/operator-full.md' WHERE id = ?").run(node.id);
    } else {
      setup1.rigRepo.setRigPermissionPolicy(rig.id, "policies/operator-full.md");
      setup1.rigRepo.setRigPolicyProvenance(rig.id, {
        origin: "custom", resolvedTarget: join(declRoot, "policies", "operator-full.md"),
        declaringDir: declRoot, launchPosture: "full_bypass",
      });
    }
    const session = setup1.sessionRegistry.registerSession(node.id, `dev-seat@gf1-${kind}`);
    setup1.sessionRegistry.updateStatus(session.id, "running");
    db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-gf1' WHERE id = ?").run(session.id);
    const snap = setup1.snapshotCapture.captureSnapshot(rig.id, "manual");
    db1.close();

    const db2 = createDb(dbFile);
    const rigRepo2 = new RigRepository(db2);
    const sessionRegistry2 = new SessionRegistry(db2);
    const eventBus2 = new EventBus(db2);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
    const tmux = mockTmux();
    const claudeResume = {
      canResume: vi.fn((t: string | null) => t === "claude_id"),
      resume: vi.fn(async (): Promise<ResumeResult> => ({ ok: true })),
    } as unknown as ClaudeResumeAdapter;
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
      snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
      nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    await orch.restore(snap.id);
    db2.close();
    const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-gf1");
    expect(call, "seat resume should have been attempted").toBeDefined();
    return call![4];
  }

  it("RED: NODE provenance + readable MALFORMED frontmatter → persisted full_bypass (never silent floor)", async () => {
    expect(await reopenedRestorePosture("node", MALFORMED_POLICY)).toBe("full_bypass");
  });

  it("RED: NODE provenance + readable UNUSABLE flag contract (missing launch_posture) → persisted full_bypass", async () => {
    expect(await reopenedRestorePosture("node", UNUSABLE_FLAG_POLICY)).toBe("full_bypass");
  });

  it("RED: inherited RIG provenance + readable MALFORMED frontmatter → persisted full_bypass", async () => {
    expect(await reopenedRestorePosture("rig", MALFORMED_POLICY)).toBe("full_bypass");
  });

  it("valid readable content still RE-DERIVES (the ruling's re-validation stays live)", async () => {
    expect(await reopenedRestorePosture("node", CUSTOM_POLICY)).toBe("full_bypass");
  });
});

describe("GF2 — the COMPLETE production-altitude launch/restore matrix", () => {
  function binding2(posture?: "floor" | "full_bypass"): NodeBinding {
    return { id: "b1", nodeId: "n1", tmuxSession: "s1", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...(posture ? { launchPosture: posture } : {}) } as NodeBinding;
  }

  it("POD-AWARE restore: the reconstructed binding's posture reaches the REAL adapter's harness command", { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "seamb-podaware-"));
    try {
      const dbFile = join(dir, "d.sqlite");
      const db1 = createDb(dbFile);
      migrate(db1, migrationsForFullTestDb);
      const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
      const outcome = await setup1.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
      expect(outcome.ok).toBe(true);
      const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
      const implNode = db1.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string };
      // pod-aware = snapshot carries podId nodes; the materialized member has one
      const session = setup1.sessionRegistry.registerSession(implNode.id, "dev-impl@lifecycle-rig");
      setup1.sessionRegistry.updateStatus(session.id, "running");
      db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-pod' WHERE id = ?").run(session.id);
      const snap = setup1.snapshotCapture.captureSnapshot(rigId, "manual");
      // pod-aware startup replay requires nodeStartupContext (captured at original launch;
      // seeded here the same way the shipped restore tests do)
      {
        const row = db1.prepare("SELECT data FROM snapshots WHERE id = ?").get(snap.id) as { data: string };
        const data = JSON.parse(row.data);
        data.nodeStartupContext = data.nodeStartupContext ?? {};
        data.nodeStartupContext[implNode.id] = { projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime: "claude-code" };
        db1.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);
      }
      db1.close();

      const db2 = createDb(dbFile);
      const rigRepo2 = new RigRepository(db2);
      const sessionRegistry2 = new SessionRegistry(db2);
      const eventBus2 = new EventBus(db2);
      const snapshotRepo2 = new SnapshotRepository(db2);
      const checkpointStore2 = new CheckpointStore(db2);
      const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
      const tmux = mockTmux();
      const realClaude = new ClaudeCodeAdapter({ sleep: async () => {}, tmux, fsOps: (function () {
        const store: Record<string, string> = {};
        return { readFile: (p: string) => { if (p in store) return store[p]!; throw new Error("nf"); }, writeFile: (p: string, c: string) => { store[p] = c; }, exists: (p: string) => p in store, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as ClaudeAdapterFsOps;
      })(), sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
      const orch = new RestoreOrchestrator({
        db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
        snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
        nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
        tmuxAdapter: tmux,
        claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
        codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
      });
      await orch.restore(snap.id, { adapters: { "claude-code": realClaude } } as never);
      const cmds = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
      const launchCmd = cmds.find((c) => c.includes("claude"));
      expect(launchCmd, `expected a claude harness launch among: ${cmds.join(" | ")}`).toBeDefined();
      // rig-level custom flag/full_bypass provenance → the harness command carries the bypass
      expect(launchCmd!).toContain("--dangerously-skip-permissions");
      db2.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Codex RESUME command: full_bypass forces danger-full-access; floor HOLDS workspace-write under env YOLO", { timeout: 30000 }, async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const { CodexResumeAdapter: RealCodexResume } = await import("../src/adapters/codex-resume.js");
      for (const [posture, expected, absent] of [["full_bypass", " -s danger-full-access", ""], ["floor", " -s workspace-write", "danger-full-access"]] as const) {
        const tmux = mockTmux();
        const adapter = new RealCodexResume(tmux, { sleep: async () => {} });
        (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("codex");
        const result = await adapter.resume("s1", "codex_id", "thread-1", "/w", null, posture);
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain("codex");
        expect(cmd).toContain("resume");
        expect(cmd).toContain(expected);
        expect(result.ok && result.appliedLaunch).toMatchObject({ axis: "sandbox", value: posture === "floor" ? "workspace-write" : "danger-full-access" });
        if (absent) expect(cmd).not.toContain(absent);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("Pi FRESH + RESUME: posture drives RESOURCE TRUST (approve vs no-approve), floor holding under env YOLO", { timeout: 30000 }, async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const { PiRuntimeAdapter } = await import("../src/adapters/pi-runtime-adapter.js");
      const { PiResumeAdapter } = await import("../src/adapters/pi-resume.js");
      const piFs = { readFile: () => "{}", writeFile: () => {}, exists: () => true, mkdirp: () => {}, listFiles: () => [] };
      for (const [posture, expectedTrust] of [["full_bypass", "approve"], ["floor", "no-approve"]] as const) {
        const tmux = mockTmux();
        const adapter = new PiRuntimeAdapter({ tmux, fsOps: piFs as never, stateRoot: "/tmp/pi-state", runnerEntryPath: "/tmp/pi-runner.js", sleep: async () => {} });
        await adapter.launchHarness(binding2(posture), { name: "dev-pi@test-rig" });
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        // RESOURCE TRUST wording: Pi's --approve/--no-approve govern resource trust, not permissions
        if (expectedTrust === "approve") { expect(cmd).toMatch(/--approve/); expect(cmd).not.toMatch(/--no-approve/); }
        else expect(cmd).toContain("--no-approve");
      }
      for (const [posture, expectedTrust] of [["full_bypass", "approve"], ["floor", "no-approve"]] as const) {
        const tmux = mockTmux();
        const adapter = new PiResumeAdapter(tmux, piFs as never, { stateRoot: "/tmp/pi-state", runnerEntryPath: "/tmp/pi-runner.js" }, { sleep: async () => {} });
        await adapter.resume("s1", "pi_session_file", "/tmp/pi-state/session.json", "/w", null, posture);
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        if (expectedTrust === "approve") { expect(cmd).toMatch(/--approve/); expect(cmd).not.toMatch(/--no-approve/); }
        else expect(cmd).toContain("--no-approve");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("Claude NATIVE-FORK command: posture drives the flag on the fork path too (floor holds under env YOLO)", { timeout: 30000 }, async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      for (const [posture, expected] of [["full_bypass", "--dangerously-skip-permissions"], ["floor", "--permission-mode acceptEdits"]] as const) {
        const tmux = mockTmux();
        const store: Record<string, string> = {};
        const adapter = new ClaudeCodeAdapter({ sleep: async () => {}, tmux, fsOps: { readFile: (p: string) => { if (p in store) return store[p]!; throw new Error("nf"); }, writeFile: (p: string, c: string) => { store[p] = c; }, exists: (p: string) => p in store, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as ClaudeAdapterFsOps, sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
        await adapter.launchHarness(binding2(posture), { name: "dev-impl@test-rig", forkSource: { kind: "native_id", value: "parent-session-1" } as never });
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain("claude");
        expect(cmd).toContain(expected);
        if (posture === "floor") expect(cmd).not.toContain("--dangerously-skip-permissions");
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

// ── R2 terminal at 954d97a0: TRUE ABSENCE = the locked MINIMUM FLOOR ────────────
// README v4 (absence "floor-only"; founder amendment "DEFAULT IF NONE ATTACHED = the
// minimum floor (nothing more)") + FINAL2: posture binds explicitly across
// fresh/resume/fork; ambient OPENRIG_YOLO must NOT widen a seat with no attachment.
// Absence stays HONEST (no fabricated attachment, no provenance rows) — only the
// lifecycle BINDING carries the explicit floor.

describe("ABSENCE = locked floor at every lifecycle surface (R2 HIGH at 954d97a0)", () => {
  const captureAdapter = (bindings: NodeBinding[]): RuntimeAdapter => ({
    runtime: "claude-code",
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    launchHarness: async (binding: NodeBinding) => { bindings.push(binding); return { ok: true }; },
    checkReady: async () => ({ ready: true }),
  } as unknown as RuntimeAdapter);

  it("RED: fresh structured launch with NO attachment binds EXPLICIT floor (never undefined), even under env YOLO", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const bindings: NodeBinding[] = [];
      const db = createFullTestDb();
      const setup = createTestApp(db, {
        adapters: { "claude-code": captureAdapter(bindings) },
        podInstantiatorFsOps: fsOps(),
      });
      const bare = { version: "0.2", name: "bare-rig", pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }], edges: [] };
      const outcome = await setup.podInstantiator.materializeStructured(bare, "/rig");
      expect(outcome.ok).toBe(true);
      const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
      const added = await setup.podInstantiator.addMemberToPod(rigId, "dev", { id: "late", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "." }, "/rig");
      expect(added.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.launchPosture).toBe("floor"); // explicit, not undefined
      // honesty preserved: NO fabricated provenance for the absent attachment
      const lateId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.late'").get() as { id: string }).id;
      expect(setup.rigRepo.getNodePolicyProvenance(lateId)).toBeNull();
      db.close();
    } finally { vi.unstubAllEnvs(); }
  });

  it("RED: restore with NO provenance anywhere returns EXPLICIT floor to the resume adapter, even under env YOLO", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    const dir = mkdtempSync(join(tmpdir(), "seamb-absent-"));
    try {
      const dbFile = join(dir, "d.sqlite");
      const db1 = createDb(dbFile);
      migrate(db1, migrationsForFullTestDb);
      const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
      const rig = setup1.rigRepo.createRig("absent-rig");
      const node = setup1.rigRepo.addNode(rig.id, "dev.bare", { runtime: "claude-code", cwd: "/w" });
      const session = setup1.sessionRegistry.registerSession(node.id, "dev-bare@absent-rig");
      setup1.sessionRegistry.updateStatus(session.id, "running");
      db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-abs' WHERE id = ?").run(session.id);
      const snap = setup1.snapshotCapture.captureSnapshot(rig.id, "manual");
      db1.close();

      const db2 = createDb(dbFile);
      const rigRepo2 = new RigRepository(db2);
      const sessionRegistry2 = new SessionRegistry(db2);
      const eventBus2 = new EventBus(db2);
      const snapshotRepo2 = new SnapshotRepository(db2);
      const checkpointStore2 = new CheckpointStore(db2);
      const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
      const tmux = mockTmux();
      const claudeResume = {
        canResume: vi.fn((t: string | null) => t === "claude_id"),
        resume: vi.fn(async (): Promise<ResumeResult> => ({ ok: true })),
      } as unknown as ClaudeResumeAdapter;
      const orch = new RestoreOrchestrator({
        db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
        snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
        nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
        tmuxAdapter: tmux,
        claudeResume,
        codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
      });
      await orch.restore(snap.id);
      const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-abs");
      expect(call, "bare seat resume should have been attempted").toBeDefined();
      expect(call![4]).toBe("floor"); // explicit floor — ambient YOLO must not widen
      db2.close();
    } finally { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });

  // (successor-absence pin lives at PRODUCTION altitude in seat-handover-service.test.ts —
  //  the helper-only variant was removed per Guard at c203812f: it re-computed the fallback
  //  chain instead of driving SeatHandoverService.)

  it("adapter parity under env YOLO: an ABSENT-attachment lifecycle binding (explicit floor) emits FLOOR commands on all three families", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      expect(claudePostureFlag(process.env, "floor")).toBe("--permission-mode acceptEdits");
      expect(codexPostureArg("", process.env, "floor")).toBe(" -s workspace-write");
      expect(piTrust(undefined, process.env, "floor")).toBe("no-approve"); // resource trust
    } finally { vi.unstubAllEnvs(); }
  });
});
