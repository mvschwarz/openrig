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
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const CUSTOM_POLICY = `---
name: operator-full
version: "1"
description: full-bypass flag policy (lifecycle pins)
surface: flag
launch_posture: full_bypass
allowed_actions: []
ask_actions: []
denied_actions: []
watch_actions: []
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
    db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-123' WHERE id = ?").run(session.id);
    const snap = setup1.snapshotCapture.captureSnapshot(rigId, "manual");
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
    // policy file readable at restore: served from the ORIGINAL declaring root
    await orch.restore(snapId);
    // PRODUCTION-ALTITUDE assertion: the resume adapter received the rig-inherited posture
    const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-123");
    expect(call, "organic seat resume should have been attempted").toBeDefined();
    expect(call![4]).toBe("full_bypass"); // 5th arg = resolvedPosture from RIG provenance
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
        await adapter.launchHarness(binding(posture), { name: "dev-impl@test-rig" });
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain(expected);
        if (posture === "floor") expect(cmd).not.toContain("--dangerously-skip-permissions");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("Codex FRESH + NATIVE-FORK: binding posture drives -s danger-full-access vs the workspace-write floor", async () => {
    const codexFs = { readFile: () => { throw new Error("nf"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] };
    // fresh
    for (const [posture, expected, absent] of [["full_bypass", " -s danger-full-access", ""], ["floor", " -s workspace-write", "danger-full-access"]] as const) {
      const tmux = mockTmux();
      await new CodexRuntimeAdapter({ tmux, fsOps: codexFs as never }).launchHarness(binding(posture), { name: "dev-qa@test-rig" });
      const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
      expect(cmd).toContain(expected);
      if (absent) expect(cmd).not.toContain(absent);
    }
    // native fork (the Slice-02 helper remains the only flag translator)
    for (const [posture, expected] of [["full_bypass", " -s danger-full-access"], ["floor", " -s workspace-write"]] as const) {
      const tmux = mockTmux();
      await new CodexRuntimeAdapter({ tmux, fsOps: codexFs as never }).launchHarness(binding(posture), { name: "dev-qa@test-rig", forkSource: { kind: "native_id", value: "parent-thread-1" } as never });
      const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
      expect(cmd).toContain("fork");
      expect(cmd).toContain(expected);
    }
  });

  it("Claude RESUME: the threaded posture drives the resume command (floor pins acceptEdits under env YOLO)", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const { ClaudeResumeAdapter: RealClaudeResume } = await import("../src/adapters/claude-resume.js");
      for (const [posture, expected] of [["full_bypass", "--dangerously-skip-permissions"], ["floor", "--permission-mode acceptEdits"]] as const) {
        const tmux = mockTmux();
        const adapter = new RealClaudeResume(tmux);
        await adapter.resume("s1", "claude_id", "tok-1", "/w", posture);
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain("claude");
        expect(cmd).toContain("--resume");
        expect(cmd).toContain(expected);
      }
    } finally { vi.unstubAllEnvs(); }
  });
});
