import { afterEach, describe, expect, it, vi } from "vitest";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatAttentionReconciler, rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { verifyClaudePaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";

// Same foreground/OS/argv specimen as the #197 diagnosis. These are process
// observations, not a provider, a conversation, or evidence of input consumption.
const startedAt = "Fri Oct  2 20:00:00 2026";
const root = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, command: "/bin/bash wrapper.sh", executableName: "bash", startedAt };
const child = { pid: 101, ppid: 100, pgid: 100, tpgid: 100, command: "/tmp/review/.local/share/claude/versions/2.1.1 --session-id review-token", executableName: "2.1.1", startedAt };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(token: string | null = null) {
  const db = createFullTestDb(); databases.push(db);
  const repo = new RigRepository(db), registry = new SessionRegistry(db), bus = new EventBus(db);
  const activity = new AgentActivityStore({ db, eventBus: bus }), store = new SeatIdentityStore(db);
  const rig = repo.createRig("review197"), name = "worker@review197", pane = "%197";
  const node = repo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
  const session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id, "running");
  registry.updateStartupStatus(session.id, "attention_required");
  db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run(token, session.id);
  registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane });
  store.upsert({ nodeId: node.id, verdict: "mismatch", evidenceSource: "pane_process", reason: "process_identity_mismatch",
    evidence: { registeredPane: pane, observedPid: 100, observedCommand: "bash", matchedLayer: null }, sessionName: name, observedAt: new Date().toISOString() });
  const tmux = {
    listSessions: vi.fn(async () => [{ name }] as never),
    listPanes: vi.fn(async () => [{ id: pane }] as never),
    getPanePid: vi.fn(async (): Promise<number | null> => 100),
    getPaneCommand: vi.fn(async (): Promise<string | null> => "bash"),
  };
  const listProcesses = vi.fn(async (): Promise<NativeProcessRow[]> => [root, child]);
  const sendVerify = vi.fn(async () => { throw new Error("no input allowed"); });
  const deps = { db, sessionRegistry: registry, eventBus: bus, agentActivityStore: activity, tmux, listProcesses, sendVerify };
  const clear = new SeatAttentionReconciler(deps);
  const poll = new SeatIdentityReconciler({ db, tmux, listProcesses });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("seatAttentionReconciler" as never, clear as never); c.set("terminalBearerToken" as never, "fixture" as never); await next(); });
  app.route("/api/sessions", sessionAdminRoutes);
  const post = async () => {
    const response = await app.request(`/api/sessions/${encodeURIComponent(name)}/clear-attention`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" }, body: "{}",
    });
    return { status: response.status, body: await response.json() };
  };
  const verify = (strict = false) => rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id,
    sessionName: name, runtime: "claude-code", expectedResumeToken: token, requireExactResumeLineage: strict, listProcesses });
  const startup = () => (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string }).startup_status;
  return { db, registry, bus, rig, node, session, name, pane, tmux, listProcesses, sendVerify, clear, poll, store, post, verify, startup };
}

describe("Claude wrapper manual attention recovery", () => {
  it.each(["kernel", "team"])("periodic identity and clear-attention accept inline %s settings", async authority => {
    const settings = operationalLaunchArgs("claude-code", authority === "kernel"
      ? { kernelAuthority: true } : { teamPermissionDefault: true });
    const setup = () => {
      const f = fixture("review-token");
      f.listProcesses.mockResolvedValue([root, { ...child,
        command: ["/tmp/review/.local/share/claude/versions/2.1.1", "--permission-mode", "acceptEdits",
          ...settings, "--session-id", "review-token", "--name", f.name].join(" "),
      }]);
      return f;
    };
    const periodic = setup();
    await periodic.poll.reconcileAll();
    expect(periodic.store.getForNode(periodic.node.id)?.verdict).toBe("verified");
    // Periodic identity does not erase a separate startup attention marker.
    expect(periodic.startup()).toBe("attention_required");
    // Exercise clear-attention from its own still-active identity mismatch.
    const f = setup();
    const result = await f.post();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.evidence.kind).toBe("pane_identity_reverified");
    expect(f.startup()).toBe("ready");
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it.each(["valid", "no token", "wrong token", "missing path", "background", "unrelated", "ambiguous", "PID reused", "unavailable"])("numeric Claude pane identity clear: %s", async mode => {
    const f = fixture(mode === "no token" ? null : "review-token");
    f.tmux.getPaneCommand.mockResolvedValue("2.1.289");
    const native = { ...child, executableName: "2.1.289", command: `claude --session-id ${mode === "wrong token" ? "other" : "review-token"}`,
      executablePath: mode === "missing path" ? undefined : "/fixture/.local/share/claude/versions/2.1.289" };
    f.listProcesses.mockImplementation(async () => {
      if (mode === "unavailable") throw new Error("process observation unavailable");
      return [root, { ...native,
        ...(mode === "background" ? { pgid: 200 } : {}),
        ...(mode === "unrelated" ? { ppid: 1 } : {}),
        ...(mode === "PID reused" && f.listProcesses.mock.calls.length === 2 ? { startedAt: "later" } : {}),
      }, ...(mode === "ambiguous" ? [{ ...native, pid: 102 }] : [])];
    });
    const result = await f.post();
    expect(result.status).toBe(mode === "valid" ? 200 : 422);
    expect(f.startup()).toBe(mode === "valid" ? "ready" : "attention_required");
    expect(f.store.getForNode(f.node.id)?.verdict).toBe(mode === "valid" ? "verified" : "mismatch");
    if (mode === "valid") {
      expect(result.body.evidence.kind).toBe("pane_identity_reverified");
      expect(f.listProcesses).toHaveBeenCalledTimes(2);
    }
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it.each([null, "review-token", "different-token"])("batched wrapper proof retains saved-token semantics (%s)", async token => {
    const f = fixture(token);
    const batch = vi.fn(async () => new Map([[f.pane, { pid: 100, command: "bash" }]]));
    Object.assign(f.tmux, { readAllPaneProcesses: batch });
    await f.poll.reconcileAll();
    expect(batch).toHaveBeenCalledTimes(3); // selection/first sample, second sample, final verdict
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    expect(f.tmux.getPaneCommand).not.toHaveBeenCalled();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe(token === "different-token" ? "mismatch" : "verified");
    expect(f.startup()).toBe("attention_required");
  });

  it.each(["pid", "command"])("uses the fresh final batch after native proof (%s changed)", async changed => {
    const f = fixture();
    const batch = vi.fn(async () => new Map([[f.pane, { pid: 100, command: "bash" as string | null }]]));
    batch.mockResolvedValueOnce(new Map([[f.pane, { pid: 100, command: "bash" }]]))
      .mockResolvedValueOnce(new Map([[f.pane, { pid: 100, command: "bash" }]]))
      .mockResolvedValue(new Map([[f.pane, { pid: changed === "pid" ? 999 : 100, command: changed === "command" ? null : "bash" }]]));
    Object.assign(f.tmux, { readAllPaneProcesses: batch });
    await f.poll.reconcileAll();
    expect(batch).toHaveBeenCalledTimes(3);
    expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
    expect(f.startup()).toBe("attention_required");
  });

  it.each([null, "review-token"])("clears with positive occupancy then stays coherent on the next sweep (saved token: %s)", async token => {
    const f = fixture(token);
    const result = await f.post();
    expect(result.status).toBe(200);
    expect(result.body.evidence.kind).toBe("pane_identity_reverified");
    expect(f.startup()).toBe("ready");
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.listProcesses).toHaveBeenCalledTimes(4);
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it("periodic tokenless occupancy does not clear startup attention or invent a token", async () => {
    const f = fixture(); await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.startup()).toBe("attention_required");
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(f.session.id)).toEqual({ resume_token: null });
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it("never falls back from a wrong saved token to runtime-only proof", async () => {
    const f = fixture("different-token");
    expect((await f.post()).status).toBe(422);
    expect((await f.verify()).ok).toBe(false);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("mismatch");
    expect(f.startup()).toBe("attention_required");
  });

  it.each([null, "different-token"])("strict restore cannot use runtime-only evidence (%s)", async token => {
    const f = fixture(token);
    expect((await f.verify(true)).ok).toBe(false);
    expect(await verifyClaudePaneProcess({ target: f.pane, tmux: f.tmux, listProcesses: f.listProcesses, expectedToken: token })).toBeNull();
    expect(f.startup()).toBe("attention_required");
  });

  it("retains the exact saved-token strict wrapper path", async () => {
    expect((await fixture("review-token").verify(true)).ok).toBe(true);
  });

  it("keeps full restore outcome reconciliation ahead of runtime occupancy", async () => {
    const f = fixture();
    f.bus.emit({ type: "restore.started", rigId: f.rig.id, snapshotId: "snapshot" } as never);
    f.bus.emit({ type: "restore.completed", rigId: f.rig.id, snapshotId: "snapshot", result: {
      snapshotId: "snapshot", preRestoreSnapshotId: "before", rigResult: "failed",
      nodes: [{ nodeId: f.node.id, logicalId: "worker", status: "failed" }], warnings: [],
    } } as never);
    const result = await f.post();
    expect(result.status).toBe(422);
    expect(result.body.detail).toContain("strict restore reconciler is unavailable");
    expect(f.listProcesses).not.toHaveBeenCalled();
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.startup()).toBe("attention_required");
    expect((await f.post()).status).toBe(422);
  });

  const invalid: [string, NativeProcessRow[]][] = [
    ["empty", []], ["bare shell", [root]], ["wrong runtime", [root, { ...child, command: "codex", executableName: "codex" }]],
    ["background", [root, { ...child, pgid: 200 }]], ["unrelated", [root, { ...child, ppid: 1 }]],
    ["duplicate candidates", [root, child, { ...child, pid: 102 }]], ["wrong OS executable", [root, { ...child, executableName: "python3" }]],
    ["missing start", [root, { ...child, startedAt: undefined }]], ["missing foreground", [{ ...root, tpgid: undefined }, child]],
  ];
  it.each(invalid)("does not clear or periodically verify %s", async (_name, rows) => {
    const f = fixture(); f.listProcesses.mockResolvedValue(rows);
    expect((await f.verify()).ok).toBe(false);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
    expect(f.startup()).toBe("attention_required");
  });

  it("rejects process PID reuse between the two observations", async () => {
    const f = fixture(); f.listProcesses.mockResolvedValueOnce([root, child]).mockResolvedValue([root, { ...child, startedAt: "later" }]);
    expect((await f.verify()).ok).toBe(false);
  });
  it("keeps unavailable process evidence non-positive", async () => {
    const f = fixture(); f.listProcesses.mockRejectedValue(new Error("ps unavailable"));
    expect((await f.verify()).ok).toBe(false);
    await f.poll.reconcileAll(); expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
  });
  it.each(["pane", "pid", "extra pane", "unavailable"])("rejects a final %s change after process proof", async mode => {
    const f = fixture();
    f.listProcesses.mockImplementation(async () => {
      if (f.listProcesses.mock.calls.length === 2) {
        if (mode === "pane") f.tmux.listPanes.mockResolvedValue([{ id: "%replacement" }] as never);
        if (mode === "pid") f.tmux.getPanePid.mockResolvedValue(999);
        if (mode === "extra pane") f.tmux.listPanes.mockResolvedValue([{ id: f.pane }, { id: "%extra" }] as never);
        if (mode === "unavailable") f.tmux.listPanes.mockRejectedValue(new Error("tmux unavailable"));
      }
      return [root, child];
    });
    expect((await f.verify()).ok).toBe(false);
  });

  it.each(["pane", "pid", "extra pane", "unavailable", "null command"])("periodic runtime proof also rejects a final %s change", async mode => {
    const f = fixture();
    f.listProcesses.mockImplementation(async () => {
      if (f.listProcesses.mock.calls.length === 2) {
        if (mode === "pane") f.tmux.listPanes.mockResolvedValue([{ id: "%replacement" }] as never);
        if (mode === "pid") f.tmux.getPanePid.mockResolvedValue(999);
        if (mode === "extra pane") f.tmux.listPanes.mockResolvedValue([{ id: f.pane }, { id: "%extra" }] as never);
        if (mode === "unavailable") f.tmux.listPanes.mockRejectedValue(new Error("tmux unavailable"));
        if (mode === "null command") f.tmux.getPaneCommand.mockResolvedValue(null);
      }
      return [root, child];
    });
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
    expect(f.startup()).toBe("attention_required");
  });
});
