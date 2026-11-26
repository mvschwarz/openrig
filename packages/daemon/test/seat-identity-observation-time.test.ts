import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";

describe("identity verdict time belongs to its evidence sample", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });
  const time = (ms: number) => new Date(ms).toISOString();

  function fixture() {
    const repo = new RigRepository(db), registry = new SessionRegistry(db), store = new SeatIdentityStore(db);
    const rig = repo.createRig("timing");
    const node = repo.addNode(rig.id, "dev.a", { runtime: "claude-code" });
    const name = "dev-a@timing";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const verified = { nodeId: node.id, verdict: "verified" as const, evidenceSource: "pane_process" as const,
      reason: null, sessionName: name, observedAt: time(2_000),
      evidence: { registeredPane: "%1", observedPid: 42, observedCommand: "claude", matchedLayer: 1 } };
    return { repo, registry, store, rig, node, name, verified };
  }

  it("a completion read of absence supersedes a later-started sweep's earlier runtime sample", async () => {
    const f = fixture();
    let clock = 1_000;
    await rebindAndVerifyPaneIdentity({ db, sessionRegistry: f.registry, nodeId: f.node.id, sessionName: f.name,
      runtime: "claude-code", now: () => new Date(clock), tmux: {
        listPanes: async () => { f.store.upsert(f.verified); clock = 3_000; return []; },
        getPanePid: async () => 42, getPaneCommand: async () => "claude",
      } });
    expect(f.store.getForNode(f.node.id)).toMatchObject({ verdict: "pane_missing", observedAt: time(3_000) });
  });

  it("a periodic final command read supersedes an earlier positive runtime observation", async () => {
    const f = fixture();
    let clock = 1_000, commands = 0;
    await new SeatIdentityReconciler({ db, now: () => new Date(clock), tmux: {
      listSessions: async () => [{ name: f.name }], getPanePid: async () => 42,
      listPanes: async () => [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }],
      getPaneCommand: async () => {
        if (++commands === 1) return "claude";
        f.store.upsert(f.verified); clock = 3_000; return "codex";
      },
    } }).reconcileAll();
    expect(f.store.getForNode(f.node.id)).toMatchObject({ verdict: "mismatch", observedAt: time(3_000), reason: "process_identity_mismatch" });
  });

  it("processing an earlier batch late does not relabel its sample as newer evidence", async () => {
    const f = fixture();
    const other = f.repo.addNode(f.rig.id, "dev.b", { runtime: "claude-code" });
    const otherName = "dev-b@timing";
    const session = f.registry.registerSession(other.id, otherName);
    f.registry.updateStatus(session.id, "running");
    f.registry.updateBinding(other.id, { tmuxSession: otherName, tmuxPane: "%2" });
    let clock = 1_000;
    await new SeatIdentityReconciler({ db, now: () => new Date(clock), tmux: {
      listSessions: async () => [{ name: f.name }, { name: otherName }],
      readAllPaneProcesses: async () => new Map([
        ["%1", { pid: 42, command: "claude", dead: true }], ["%2", { pid: 84, command: "claude" }],
      ]),
      listPanes: async () => {
        f.store.upsert({ ...f.verified, nodeId: other.id, sessionName: otherName, verdict: "mismatch", reason: "process_identity_mismatch" });
        clock = 3_000;
        return [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }];
      },
      getPanePid: async () => 42, getPaneCommand: async () => "claude",
    } }).reconcileAll();
    expect(f.store.getForNode(other.id)).toMatchObject({ verdict: "mismatch", observedAt: time(2_000) });
  });

  it.each([false, true])("a pane recheck cannot restamp native proof over a newer mismatch (strict=%s)", async strict => {
    const f = fixture();
    let clock = 1_000, paneReads = 0;
    const result = await rebindAndVerifyPaneIdentity({ db, sessionRegistry: f.registry, nodeId: f.node.id,
      sessionName: f.name, runtime: "claude-code", expectedResumeToken: "saved-token",
      requireExactResumeLineage: strict, now: () => new Date(clock),
      tmux: {
        listPanes: async () => {
          if (++paneReads === 2) {
            f.registry.updateBinding(f.node.id, { tmuxSession: f.name, tmuxPane: "%2" });
            f.store.upsert({ ...f.verified, verdict: "mismatch", reason: "process_identity_mismatch",
              evidence: { ...f.verified.evidence, registeredPane: "%2" } });
            clock = 3_000;
          }
          return [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }];
        },
        getPanePid: async () => 42, getPaneCommand: async () => strict ? "claude" : "sh",
      },
      listProcesses: async () => [
        { pid: 42, ppid: 1, pgid: 42, tpgid: 43, executableName: "sh", command: "sh", startedAt: "start" },
        { pid: 43, ppid: 42, pgid: 43, tpgid: 43, executableName: "claude", command: "claude --resume saved-token", startedAt: "start" },
      ],
    });
    expect(result).toMatchObject({ ok: false, reason: "identity_unverified" });
    expect(f.registry.getBindingForNode(f.node.id)?.tmuxPane).toBe("%2");
    expect(f.store.getForNode(f.node.id)).toMatchObject({
      verdict: "mismatch", observedAt: time(2_000), evidence: { registeredPane: "%2" },
    });
  });

  it.each([
    { runtime: "claude-code", command: "sh", exact: false },
    { runtime: "claude-code", command: "claude", exact: true },
    { runtime: "codex", command: "node", exact: true },
  ])("reports an unavailable process listing for $runtime in $command", async ({ runtime, command, exact }) => {
    const f = fixture();
    const result = await rebindAndVerifyPaneIdentity({
      db, sessionRegistry: f.registry, nodeId: f.node.id, sessionName: f.name, runtime,
      expectedResumeToken: "saved-token", requireExactResumeLineage: exact,
      tmux: {
        listPanes: async () => [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }],
        getPanePid: async () => 42,
        getPaneCommand: async () => command,
      },
      listProcesses: async () => { throw new Error("fixture process listing failed"); },
    });
    expect(result).toMatchObject({ ok: false, reason: "tmux_unavailable", detail: expect.stringContaining("fixture process listing failed") });
    expect(f.store.getForNode(f.node.id)).toMatchObject({ reason: "tmux_unavailable" });
  });

  it.each(["normal", "read failure", "session absent"].flatMap(mode => [false, true].map(sessionChanged => ({ mode, sessionChanged }))))("a sweep drops an old selection after $mode (sessionChanged=$sessionChanged)", async ({ mode, sessionChanged }) => {
    const f = fixture();
    let clock = 1_000;
    const replace = () => {
      if (sessionChanged) {
        const successor = f.registry.registerSession(f.node.id, f.name);
        f.registry.updateStatus(successor.id, "running");
      } else f.registry.updateBinding(f.node.id, { tmuxSession: f.name, tmuxPane: "%2" });
      f.store.upsert({ ...f.verified, evidence: { ...f.verified.evidence, registeredPane: sessionChanged ? "%1" : "%2" } });
      clock = 3_000;
    };
    await new SeatIdentityReconciler({ db, now: () => new Date(clock), tmux: {
      listSessions: async () => mode === "session absent" ? [] : [{ name: f.name }],
      probeSession: async () => { replace(); return { state: "absent", sessionName: f.name }; },
      getPanePid: async () => {
        replace();
        if (mode === "read failure") throw new Error("fixture pane read failed");
        return null;
      },
      getPaneCommand: async () => "claude",
      listPanes: async () => [{ id: "%2", index: 0, cwd: "/project", width: 80, height: 24, active: true }],
    } }).reconcileAll();
    expect(f.store.getForNode(f.node.id)).toMatchObject({ verdict: "verified", observedAt: time(2_000), evidence: { registeredPane: sessionChanged ? "%1" : "%2" } });
  });

  // 0.7.23 r2 C7-X: the periodic sweep stored a newer verdict while a new Codex seat's startup check ran, and rig up
  // reported the healthy seat as attention_required ("A newer pane identity observation superseded this check").
  it.each([
    { newerPid: 43, confirmed: true },
    { newerPid: 99, confirmed: false },
  ])("a newer sweep verdict for process $newerPid during a Codex check: confirmed=$confirmed", async ({ newerPid, confirmed }) => {
    const f = fixture();
    let clock = 1_000, reads = 0;
    const result = await rebindAndVerifyPaneIdentity({ db, sessionRegistry: f.registry, nodeId: f.node.id,
      sessionName: f.name, runtime: "codex", now: () => new Date(clock),
      tmux: {
        listPanes: async () => [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }],
        getPanePid: async () => 42, getPaneCommand: async () => "codex",
      },
      listProcesses: async () => {
        // Between the check's two process samples, the sweep verifies a native process in the same pane.
        if (++reads === 2) {
          f.store.upsert({ ...f.verified, observedAt: time(3_000),
            evidence: { registeredPane: "%1", observedPanePid: 42, observedPid: newerPid, observedCommand: "codex -C /project", matchedLayer: 1 } });
          clock = 4_000;
        }
        return [
          { pid: 42, ppid: 1, pgid: 42, tpgid: 43, executableName: "sh", command: "sh", startedAt: "start" },
          { pid: 43, ppid: 42, pgid: 43, tpgid: 43, executableName: "codex", command: "codex -C /project", argv: ["codex", "-C", "/project"], startedAt: "start" },
        ];
      },
    });
    expect(result).toMatchObject(confirmed
      ? { ok: true, pane: "%1", pid: 42, nativeProcess: { pid: 43 } }
      : { ok: false, reason: "identity_unverified", detail: "A newer pane identity observation superseded this check" });
    // The newer verdict stays stored either way.
    expect(f.store.getForNode(f.node.id)).toMatchObject({ verdict: "verified", observedAt: time(3_000), evidence: { observedPid: newerPid } });
  });

  const paneStart = "pane-start";
  const nativeStart = "native-start";
  const exactResumeProcesses = [
    { pid: 42, ppid: 1, pgid: 42, tpgid: 43, executableName: "bash", command: "bash", startedAt: paneStart },
    { pid: 43, ppid: 42, pgid: 43, tpgid: 43, executableName: "claude", command: "claude --resume conv-1",
      argv: ["claude", "--resume", "conv-1"], startedAt: nativeStart },
  ];
  it.each([
    { sweepPanePid: 42, confirmed: true },
    { sweepPanePid: 77, confirmed: false },
  ])("a sweep during a Claude exact-resume check, seeing pane process $sweepPanePid: confirmed=$confirmed", async ({ sweepPanePid, confirmed }) => {
    const f = fixture();
    let clock = 1_000, paneLists = 0;
    const sweep = new SeatIdentityReconciler({ db, now: () => new Date(clock), tmux: {
      listSessions: async () => [{ name: f.name }], getPanePid: async () => sweepPanePid, getPaneCommand: async () => "claude",
      listPanes: async () => [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }],
    } });
    const result = await rebindAndVerifyPaneIdentity({ db, sessionRegistry: f.registry, nodeId: f.node.id,
      sessionName: f.name, runtime: "claude-code", expectedResumeToken: "conv-1", requireExactResumeLineage: true,
      now: () => new Date(clock),
      tmux: {
        listPanes: async () => {
          // The check's pane recheck, after its process read: the periodic sweep runs and stores its newer verdict.
          if (++paneLists === 2) { clock = 3_000; await sweep.reconcileAll(); clock = 1_000; }
          return [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }];
        },
        getPanePid: async () => 42, getPaneCommand: async () => "claude",
      },
      listProcesses: async () => exactResumeProcesses,
    });
    const newer = f.store.getForNode(f.node.id);
    expect(newer).toMatchObject({ verdict: "verified", observedAt: time(3_000), evidence: { observedPid: sweepPanePid } });
    expect(newer?.evidence.observedPanePid).toBeUndefined();
    expect(result).toMatchObject(confirmed
      ? { ok: true, pane: "%1", pid: 42, nativeProcess: { pid: 43, startedAt: nativeStart } }
      : { ok: false, reason: "identity_unverified", detail: "A newer pane identity observation superseded this check" });
  });

  const matchingEvidence = { observedPanePid: 42, observedPid: 43, observedPanePidStartedAt: paneStart, observedPidStartedAt: nativeStart };
  it.each([
    {
      process: "the same pane process alone",
      evidence: { observedPid: 42, observedPidStartedAt: paneStart },
      confirmed: true,
    },
    {
      process: "a reused pane PID alone",
      evidence: { observedPid: 42, observedPidStartedAt: nativeStart },
      confirmed: false,
    },
    {
      process: "the same pane and native processes",
      evidence: matchingEvidence,
      confirmed: true,
    },
    {
      process: "a reused pane PID with the same native process",
      evidence: { ...matchingEvidence, observedPanePidStartedAt: "new-pane-start" },
      confirmed: false,
    },
    {
      process: "the same pane process with a reused native PID",
      evidence: { ...matchingEvidence, observedPidStartedAt: "new-native-start" },
      confirmed: false,
    },
    {
      process: "another native Claude process",
      evidence: { observedPanePid: 42, observedPid: 99, observedCommand: "claude --resume other" },
      confirmed: false,
    },
  ])("a newer verdict naming $process in the same pane: confirmed=$confirmed", async ({ evidence, confirmed }) => {
    const f = fixture();
    let paneLists = 0;
    const result = await rebindAndVerifyPaneIdentity({ db, sessionRegistry: f.registry, nodeId: f.node.id,
      sessionName: f.name, runtime: "claude-code", expectedResumeToken: "conv-1", requireExactResumeLineage: true,
      now: () => new Date(1_000),
      tmux: {
        listPanes: async () => {
          if (++paneLists === 2) {
            f.store.upsert({ ...f.verified, observedAt: time(3_000),
              evidence: { ...f.verified.evidence, ...evidence } });
          }
          return [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }];
        },
        getPanePid: async () => 42, getPaneCommand: async () => "claude",
      },
      listProcesses: async () => exactResumeProcesses,
    });
    expect(f.store.getForNode(f.node.id)).toMatchObject({ verdict: "verified", observedAt: time(3_000), evidence });
    expect(result).toMatchObject(confirmed
      ? { ok: true, pane: "%1", pid: 42, nativeProcess: { pid: 43, startedAt: nativeStart } }
      : { ok: false, reason: "identity_unverified", detail: "A newer pane identity observation superseded this check" });
  });
});
