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
});
