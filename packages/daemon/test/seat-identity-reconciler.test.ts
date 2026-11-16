import { ActivityGrantStore } from "../src/domain/activity-grants.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
// OPR.0.4.3.19 — SeatIdentityReconciler unit tests.
//
// The reconciler owns the liveness identity verdict (the THIRD axis, orthogonal
// to slice-15's terminalActive/hasAssignedWork). It reconciles each running
// tmux-bound seat's pane PID/command against the registered binding and
// persists a durable verdict to `seat_identity_verdicts`. It reads ONLY tmux
// pane process identity — NEVER queue/classifier/hook heartbeats.

import { afterEach, describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import {
  SeatIdentityReconciler,
  classifyPaneRuntimeMatch,
} from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

interface TmuxState {
  /** session names tmux reports as live via listSessions(). */
  sessions?: string[];
  /** pane id -> pid (null = pane gone). */
  panePid?: Record<string, number | null>;
  /** pane id -> foreground command. */
  paneCommand?: Record<string, string | null>;
  /** make listSessions throw (tmux entirely unreachable). */
  throwListSessions?: boolean;
}

function makeTmux(state: TmuxState): Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand"> {
  return {
    listSessions: vi.fn(async () => {
      if (state.throwListSessions) throw new Error("no server running");
      return (state.sessions ?? []).map((name) => ({ name })) as never;
    }),
    getPanePid: vi.fn(async (paneId: string) =>
      Object.prototype.hasOwnProperty.call(state.panePid ?? {}, paneId)
        ? state.panePid![paneId]!
        : null,
    ),
    getPaneCommand: vi.fn(async (paneId: string) =>
      Object.prototype.hasOwnProperty.call(state.paneCommand ?? {}, paneId)
        ? state.paneCommand![paneId]!
        : null,
    ),
  };
}

function seedSeat(
  db: Database.Database,
  opts: {
    nodeId: string;
    rigId?: string;
    logicalId?: string;
    runtime?: string;
    sessionName: string;
    status?: string;
    pane?: string | null;
    attachmentType?: string;
  },
): void {
  const rigId = opts.rigId ?? "rig-1";
  const exists = db.prepare("SELECT 1 FROM rigs WHERE id = ?").get(rigId);
  if (!exists) db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, "test-rig");
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, ?, ?)",
  ).run(opts.nodeId, rigId, opts.logicalId ?? `pod.${opts.nodeId}`, opts.runtime ?? "claude-code", "/tmp");
  db.prepare(
    "INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)",
  ).run(`sess-${opts.nodeId}`, opts.nodeId, opts.sessionName, opts.status ?? "running", "ready");
  db.prepare(
    "INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, ?, ?, ?)",
  ).run(`bind-${opts.nodeId}`, opts.nodeId, opts.attachmentType ?? "tmux", opts.sessionName, opts.pane ?? null);
}

const NOW = () => new Date("2026-07-02T12:00:00.000Z");

describe("A3 Claude shell sampling", () => {
  const databases: Database.Database[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  function fixture(command = "sh", runtime = "claude-code") {
    const db = createFullTestDb(); databases.push(db);
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime });
    db.prepare("UPDATE sessions SET resume_token = 'saved-token'").run();
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 10 }, paneCommand: { "%1": command } });
    const rows = () => [
      { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "sh", command: "sh", startedAt: "start" },
      { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: runtime === "codex" ? "codex" : "claude",
        command: runtime === "codex" ? "codex resume saved-token" : "claude --resume saved-token",
        ...(runtime === "codex" ? { argv: ["codex", "resume", "saved-token"] } : {}), startedAt: "start" },
    ];
    const listProcesses = vi.fn(async () => rows());
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses, now: NOW });
    const verdict = () => new SeatIdentityStore(db).getForNode("n1");
    return { db, tmux, rows, listProcesses, rec, verdict };
  }

  it("does not sample native processes for direct Claude, but still makes the final command/PID observations", async () => {
    const f = fixture("claude");
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("verified");
    expect(f.listProcesses).not.toHaveBeenCalled();
    expect(f.tmux.getPanePid).toHaveBeenCalledTimes(1);
    expect(f.tmux.getPaneCommand).toHaveBeenCalledTimes(2);
  });

  it("does not verify an early direct Claude label that becomes a shell; a later stable sweep recovers", async () => {
    const f = fixture();
    vi.mocked(f.tmux.getPaneCommand).mockResolvedValueOnce("claude");
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("mismatch");
    expect(f.listProcesses).not.toHaveBeenCalled();
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("verified");
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
  });

  it("uses the final direct label when an early wrapper becomes direct Claude", async () => {
    const f = fixture("claude");
    vi.mocked(f.tmux.getPaneCommand).mockResolvedValueOnce("sh");
    await f.rec.reconcileAll();
    expect(f.verdict()).toMatchObject({ verdict: "verified", evidence: { observedCommand: "claude", observedPid: 10 } });
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    expect(f.tmux.getPaneCommand).toHaveBeenCalledTimes(2);
  });

  it.each(["null", "throw"])("keeps an unproved final shell non-green after an unavailable early read: %s", async mode => {
    const f = fixture();
    if (mode === "null") vi.mocked(f.tmux.getPaneCommand).mockResolvedValueOnce(null);
    else vi.mocked(f.tmux.getPaneCommand).mockRejectedValueOnce(new Error("unavailable"));
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("mismatch");
    expect(f.listProcesses).not.toHaveBeenCalled();
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("verified");
  });

  it.each(["null", "throw"])("keeps an unavailable final command unavailable after a successful wrapper proof: %s", async mode => {
    const f = fixture();
    vi.mocked(f.tmux.getPaneCommand).mockResolvedValueOnce("sh");
    if (mode === "null") vi.mocked(f.tmux.getPaneCommand).mockResolvedValueOnce(null);
    else vi.mocked(f.tmux.getPaneCommand).mockRejectedValueOnce(new Error("final read failed"));
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("tmux_unavailable");
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    expect(f.tmux.getPanePid).toHaveBeenCalledTimes(3);
    expect(f.tmux.getPaneCommand).toHaveBeenCalledTimes(2);
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("verified");
  });

  it.each(["sh", "-bash", " ZSH "])("retains two native phases plus final PID/command for an exact wrapper: %s", async command => {
    const f = fixture(command);
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("verified");
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    expect(f.tmux.getPanePid).toHaveBeenCalledTimes(3);
    expect(f.tmux.getPaneCommand).toHaveBeenCalledTimes(2);
  });

  it.each(["token", "fingerprint", "final-pid"])("does not accept changed wrapper identity: %s", async mode => {
    const f = fixture();
    if (mode === "token") f.listProcesses.mockImplementation(async () => { const rows = f.rows(); rows[1]!.command = "claude --resume different"; return rows; });
    if (mode === "fingerprint") f.listProcesses.mockResolvedValueOnce(f.rows()).mockImplementation(async () => { const rows = f.rows(); rows[1]!.startedAt = "changed"; return rows; });
    if (mode === "final-pid") vi.mocked(f.tmux.getPanePid).mockResolvedValueOnce(10).mockResolvedValueOnce(10).mockResolvedValueOnce(12);
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("mismatch");
  });

  // #1077 — launched as `--resume saved-token`, continued as `rotated-token`; the SessionStart hook
  // recorded the new id with how it began. Only a current-generation resume proves the seat.
  it.each([
    ["resume", "saved-token", "verified"],
    ["clear", null, "mismatch"],
    ["startup", null, "mismatch"],
    ["resume", "other-token", "mismatch"],
  ] as const)("a rotated stored token with source %s (replaced %s) reads %s", async (_source, rotatedFrom, expected) => {
    const f = fixture();
    // The registry records resume_rotated_from only for a resume into a new id; other sources leave it null.
    // The rotation names the process that qualified it: the pane's Claude (11).
    f.db.prepare("UPDATE sessions SET resume_token = 'rotated-token', resume_provenance = 'hook', resume_rotated_from = ?, resume_rotated_process = ?, resume_launch_process = ?")
      .run(rotatedFrom, rotatedFrom ? JSON.stringify({ pid: 11, startedAt: "start" }) : null,
        JSON.stringify({ token: "saved-token", pid: 11, startedAt: "start" }));
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe(expected);
  });

  it("does not accept a recorded resume once the stored token is an operator's", async () => {
    const f = fixture();
    f.db.prepare("UPDATE sessions SET resume_token = 'rotated-token', resume_provenance = 'operator', resume_rotated_from = 'saved-token', resume_rotated_process = ?, resume_launch_process = ?")
      .run(JSON.stringify({ pid: 11, startedAt: "start" }), JSON.stringify({ token: "saved-token", pid: 11, startedAt: "start" }));
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("mismatch");
  });

  it("leaves Codex sampling and command count unchanged", async () => {
    const f = fixture("codex", "codex");
    await f.rec.reconcileAll();
    expect(f.verdict()?.verdict).toBe("verified");
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    expect(f.tmux.getPanePid).toHaveBeenCalledTimes(3);
    expect(f.tmux.getPaneCommand).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], ["codex", "resume", "saved-token", "bad\0argument"]])(
    "does not mark a Codex identity verified from an opaque argv: %j", async argv => {
      const f = fixture("codex", "codex");
      f.listProcesses.mockImplementation(async () => f.rows().map(row => row.executableName === "codex" ? { ...row, argv } : row));
      await f.rec.reconcileAll();
      expect(f.verdict()?.verdict).toBe("mismatch");
    });

  it("fences a stop during the early command observation before process sampling or publication", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.tmux.getPaneCommand).mockImplementationOnce(async () => { await gate; return "sh"; });
    const pending = f.rec.reconcileAll();
    await new Promise(resolve => setImmediate(resolve));
    f.rec.stop(); release(); await pending;
    expect(f.verdict()).toBeNull();
    expect(f.listProcesses).not.toHaveBeenCalled();
  });
});

describe("classifyPaneRuntimeMatch", () => {
  it("no command signal is never a mismatch (present pane, unknown command)", () => {
    expect(classifyPaneRuntimeMatch(null, "claude-code")).toBe("match");
  });

  it("host process `node` for a live claude seat is a MATCH (no false-mismatch)", () => {
    expect(classifyPaneRuntimeMatch("node", "claude-code")).toBe("match");
  });

  it("positive same-runtime command matches", () => {
    expect(classifyPaneRuntimeMatch("claude", "claude-code")).toBe("match");
    expect(classifyPaneRuntimeMatch("codex", "codex")).toBe("match");
  });

  it("a different agent runtime occupying the pane is a MISMATCH", () => {
    expect(classifyPaneRuntimeMatch("codex", "claude-code")).toBe("mismatch");
    expect(classifyPaneRuntimeMatch("claude", "codex")).toBe("mismatch");
  });

  it("a bare shell where an agent was expected is a MISMATCH (dead process / orphan squat)", () => {
    expect(classifyPaneRuntimeMatch("zsh", "claude-code")).toBe("mismatch");
    expect(classifyPaneRuntimeMatch("-bash", "codex")).toBe("mismatch");
  });

  it("a shell for a terminal (infrastructure) node is expected — MATCH", () => {
    expect(classifyPaneRuntimeMatch("zsh", "terminal")).toBe("match");
  });
});

describe("SeatIdentityReconciler.reconcileAll", () => {
  it("shares two native observations across wrapped Codex seats and rejects later stale or missing proof", async () => {
    const db = createFullTestDb();
    for (const n of [1, 2]) {
      seedSeat(db, { nodeId: `c${n}`, sessionName: `c${n}@rig`, pane: `%${n}`, runtime: "codex" });
      db.prepare("UPDATE sessions SET resume_token = ? WHERE node_id = ?").run(`thread-${n}`, `c${n}`);
    }
    const tmux = makeTmux({ sessions: ["c1@rig", "c2@rig"], panePid: { "%1": 10, "%2": 20 }, paneCommand: { "%1": "bash", "%2": "node" } });
    const rows = [1, 2].flatMap(n => [
      { pid: n * 10, ppid: 1, pgid: n * 10, tpgid: n * 10 + 1, executableName: "bash", command: "bash", startedAt: "Sat Jan  1 12:00:00 2000" },
      { pid: n * 10 + 1, ppid: n * 10, pgid: n * 10 + 1, tpgid: n * 10 + 1, executableName: "codex",
        command: `codex resume thread-${n}`, argv: ["codex", "resume", `thread-${n}`], startedAt: "Sat Jan  1 12:00:00 2000" },
    ]);
    const listProcesses = vi.fn(async () => rows);
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses, now: NOW });
    const store = new SeatIdentityStore(db);
    await rec.reconcileAll();
    expect(listProcesses).toHaveBeenCalledTimes(2);
    for (const n of [1, 2]) expect(store.getForNode(`c${n}`)).toMatchObject({ verdict: "verified", evidence: { observedPid: n * 10 + 1 } });

    // A reused native PID during the next sweep cannot retain the old green.
    listProcesses.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.map(r => r.pid === 11 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r));
    await rec.reconcileAll();
    expect(store.getForNode("c1")?.verdict).toBe("mismatch");
    expect(store.getForNode("c2")?.verdict).toBe("verified");

    db.prepare("UPDATE sessions SET resume_token = 'wrong' WHERE node_id = 'c1'").run();
    await rec.reconcileAll();
    expect(store.getForNode("c1")?.verdict).toBe("mismatch");
    listProcesses.mockResolvedValue([]);
    await rec.reconcileAll();
    for (const n of [1, 2]) expect(store.getForNode(`c${n}`)?.verdict).toBe("mismatch");
    db.close();
  });

  it("keeps fresh Codex distinct from resume, and cannot verify an unavailable pane", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "c1", sessionName: "c1@rig", pane: "%1", runtime: "codex" });
    const tmux = makeTmux({ sessions: ["c1@rig"], panePid: { "%1": 10 }, paneCommand: { "%1": "codex" } });
    const listProcesses = vi.fn(async () => [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "codex",
      command: "codex -m configured-model", argv: ["codex", "-m", "configured-model"], startedAt: "Sat Jan  1 12:00:00 2000" }]);
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses, now: NOW });
    await rec.reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("c1")?.verdict).toBe("verified");
    vi.mocked(tmux.listSessions).mockRejectedValue(new Error("unavailable"));
    await rec.reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("c1")?.verdict).toBe("mismatch");
    db.close();
  });

  it("VERIFIED — matching pane pid + command persists a verified verdict", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 4242 }, paneCommand: { "%1": "node" } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("verified");
    expect(v?.evidence.observedPid).toBe(4242);
    expect(v?.evidence.registeredPane).toBe("%1");
    expect(v?.reason).toBeNull();
    db.close();
  });

  it("MISMATCH — orphan/squat process (shell) persists a process_identity_mismatch verdict", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // Same session name still live (squat), but the pane now runs a bare shell.
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 9999 }, paneCommand: { "%1": "zsh" } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("mismatch");
    expect(v?.reason).toBe("process_identity_mismatch");
    expect(v?.evidenceSource).toBe("pane_process");
    expect(v?.evidence.observedCommand).toBe("zsh");
    db.close();
  });

  it("PANE_MISSING (pane gone, session alive) → pane_pid_gone", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // session listed live, but the registered pane no longer resolves.
    const tmux = { ...makeTmux({ sessions: ["s1@rig"], panePid: { "%1": null } }),
      listPanes: async () => [{ id: "%2" }] as never };
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("pane_missing");
    expect(v?.reason).toBe("pane_pid_gone");
    expect(v?.evidenceSource).toBe("pane_process");
    db.close();
  });

  it("PANE_MISSING (session gone entirely) → session_missing", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // Another session is live (tmux is up), but s1@rig is gone.
    const tmux = makeTmux({ sessions: ["other@rig"], panePid: { "%1": null } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("pane_missing");
    expect(v?.reason).toBe("session_missing");
    expect(v?.evidenceSource).toBe("tmux_session");
    db.close();
  });

  it("NULL pane + live target → named binding_absent, not tmux_unavailable", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: null, runtime: "claude-code" });
    const tmux = makeTmux({ sessions: ["s1@rig"] });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("binding_absent");
    expect(v?.reason).toBe("binding_pane_missing");
    expect(v?.evidence.registeredPane).toBeNull();
    db.close();
  });

  it("NULL pane + absent target while tmux has another session → down-ranking session_missing", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: null, runtime: "claude-code" });
    const tmux = makeTmux({ sessions: ["other@rig"] });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("pane_missing");
    expect(v?.reason).toBe("session_missing");
    expect(v?.evidence.registeredPane).toBeNull();
    db.close();
  });

  it("TMUX BLIP GUARD — listSessions throws → tmux_unavailable, never down-ranks", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    const tmux = makeTmux({ throwListSessions: true });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("tmux_unavailable");
    expect(v?.reason).toBe("tmux_unavailable");
    db.close();
  });

  it("TMUX BLIP GUARD — zero live sessions while seats exist → tmux_unavailable (not session_missing for all)", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    const tmux = makeTmux({ sessions: [], panePid: { "%1": null } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("tmux_unavailable");
    db.close();
  });

  it("non-running seats are pruned; only running tmux-bound seats get verdicts", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    seedSeat(db, { nodeId: "n2", sessionName: "s2@rig", pane: "%2", runtime: "claude-code", status: "exited" });
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 1 }, paneCommand: { "%1": "node" } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const store = new SeatIdentityStore(db);
    expect(store.getForNode("n1")?.verdict).toBe("verified");
    expect(store.getForNode("n2")).toBeNull();
    db.close();
  });

  it("keeps a released seat's recorded process through the prune, and still prunes a stopped one", async () => {
    // rig unclaim leaves the latest row detached with origin claimed, and the process running. A fresh launch reads
    // that process's record before reopening a tmux server, so the 5 s sweep mustn't drop it.
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", status: "detached" });
    db.prepare("UPDATE sessions SET origin = 'claimed' WHERE node_id = 'n1'").run();
    seedSeat(db, { nodeId: "n2", sessionName: "s2@rig", pane: "%2", status: "exited" });
    const store = new SeatIdentityStore(db);
    for (const [nodeId, sessionName, pid] of [["n1", "s1@rig", 5151], ["n2", "s2@rig", 6161]] as const) {
      store.upsert({ nodeId, verdict: "verified", evidenceSource: null, reason: null,
        evidence: { registeredPane: "%1", observedPid: pid, observedPanePid: pid - 1, observedCommand: "claude", matchedLayer: 1 },
        sessionName, observedAt: NOW().toISOString() });
    }
    const rec = new SeatIdentityReconciler({ db, tmux: makeTmux({ sessions: [] }), now: NOW });

    await rec.reconcileAll();

    expect(store.getProcessEvidence("n1")).toEqual({ sessionName: "s1@rig", pid: 5151, panePid: 5150, observedAt: NOW().toISOString() });
    expect(store.getForNode("n2")).toBeNull();
    db.close();
  });

  it("liveness is NOT derived from heartbeats — a dead pane stays non-green regardless of any heartbeat", async () => {
    // The reconciler never reads queue/classifier/hook state; a seat whose pane
    // is gone yields pane_missing even if (hypothetically) work/heartbeats exist.
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // Simulate an active queue heartbeat for the seat (must not upgrade liveness).
    db.prepare(
      "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("q1", "2026-07-02T12:00:00Z", "2026-07-02T12:00:00Z", "op@rig", "s1@rig", "pending", "do work");
    const tmux = { ...makeTmux({ sessions: ["s1@rig"], panePid: { "%1": null } }),
      listPanes: async () => [{ id: "%2" }] as never };
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    expect(new SeatIdentityStore(db).getForNode("n1")?.verdict).toBe("pane_missing");
    db.close();
  });
});

describe("seat_identity_verdicts schema (migration 046)", () => {
  it("the table exists with the expected columns", () => {
    const db = createFullTestDb();
    const cols = (db.pragma("table_info(seat_identity_verdicts)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "node_id", "verdict", "evidence_source", "reason", "registered_pane",
        "observed_pid", "observed_command", "matched_layer", "session_name", "observed_at",
      ]),
    );
    db.close();
  });

  it("upsert is last-writer-wins per node_id", () => {
    const db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1','r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1','rig-1','p.n1','claude-code','/tmp')").run();
    const store = new SeatIdentityStore(db);
    const base = {
      nodeId: "n1",
      evidenceSource: "pane_process" as const,
      reason: null,
      evidence: { registeredPane: "%1", observedPid: 1, observedCommand: "node", matchedLayer: 1 },
      sessionName: "s1@rig",
      observedAt: "2026-07-02T12:00:00.000Z",
    };
    store.upsert({ ...base, verdict: "verified" });
    store.upsert({ ...base, verdict: "mismatch", reason: "process_identity_mismatch" });
    expect(store.getForNode("n1")?.verdict).toBe("mismatch");
    expect(db.prepare("SELECT COUNT(*) c FROM seat_identity_verdicts").get()).toEqual({ c: 1 });
    db.close();
  });
});


describe("SeatIdentityReconciler — bounded polling", () => {
  it("holds one sweep through delayed listing and verdict reads, then observes a changed occupant", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1" });
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 42 }, paneCommand: { "%1": "zsh" } });
    let releaseList!: () => void;
    let releaseCommand!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    const commandGate = new Promise<void>((resolve) => { releaseCommand = resolve; });
    vi.mocked(tmux.listSessions).mockImplementationOnce(async () => {
      await listGate;
      return [{ name: "s1@rig", windows: 1, created: "", attached: false }];
    });
    // This tokenless legacy fixture has no sole-pane capability, so its one
    // verdict read sees Claude during the held sweep; the next sees the shell.
    vi.mocked(tmux.getPaneCommand).mockImplementationOnce(async () => { await commandGate; return "claude"; });
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses: async () => [] });
    const store = new SeatIdentityStore(db);
    rec.start(100);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      // Twenty ticks, but the first availability read is still outstanding.
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);
      expect(store.getForNode("n1")).toBeNull();
      releaseList();
      await vi.advanceTimersByTimeAsync(1000);
      // The guard covers the whole sweep, not only its availability probe.
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);
      expect(tmux.getPaneCommand).toHaveBeenCalledTimes(1);
      expect(store.getForNode("n1")).toBeNull();
      releaseCommand();
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.getForNode("n1")?.verdict).toBe("verified");
      await vi.advanceTimersByTimeAsync(100);
      expect(tmux.listSessions).toHaveBeenCalledTimes(2);
      expect(store.getForNode("n1")?.verdict).toBe("mismatch");
    } finally {
      rec.stop(); releaseList(); releaseCommand();
      await new Promise((resolve) => setImmediate(resolve));
      vi.useRealTimers(); db.close();
    }
  });

  it("stop/restart fences a pending native observation without releasing its flight early", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "c1", sessionName: "c1@rig", pane: "%1", runtime: "codex" });
    const tmux = makeTmux({ sessions: ["c1@rig"], panePid: { "%1": 10 }, paneCommand: { "%1": "codex" } });
    const rows = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "codex", command: "codex", argv: ["codex"],
      startedAt: "Sat Jan  1 12:00:00 2000" }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const listProcesses = vi.fn(async () => rows).mockImplementationOnce(async () => { await gate; return rows; });
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses });
    const store = new SeatIdentityStore(db);
    rec.start(100);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(listProcesses).toHaveBeenCalledTimes(1);
      rec.stop(); rec.start(100);
      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.getForNode("c1")).toBeNull();
      expect(listProcesses).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(listProcesses).toHaveBeenCalledTimes(3); // two fresh observations
      expect(store.getForNode("c1")?.verdict).toBe("verified");
    } finally {
      rec.stop(); release();
      await new Promise((resolve) => setImmediate(resolve));
      vi.useRealTimers(); db.close();
    }
  });

  it("releases after availability and per-seat failures and recovers on a later sweep", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1" });
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 42 }, paneCommand: { "%1": "claude" } });
    vi.mocked(tmux.listSessions).mockRejectedValueOnce(new Error("unavailable"));
    vi.mocked(tmux.getPaneCommand).mockRejectedValueOnce(new Error("final pane read failed"));
    const rec = new SeatIdentityReconciler({ db, tmux });
    const store = new SeatIdentityStore(db);
    try {
      await rec.reconcileAll();
      expect(store.getForNode("n1")?.verdict).toBe("tmux_unavailable");
      await rec.reconcileAll();
      expect(store.getForNode("n1")?.verdict).toBe("tmux_unavailable");
      await rec.reconcileAll();
      expect(store.getForNode("n1")?.verdict).toBe("verified");
    } finally { rec.stop(); db.close(); }
  });
});

describe("definitive Core exit ends exact run authority", () => {

  it.each(["present", "unreadable"] as const)("does not revoke on unreadable pane PID when session census is %s, then recovers", async census => {
    const db = createFullTestDb();
    try {
      seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", runtime: "pi", pane: "%1" });
      const generation = new SessionRegistry(db).mintOccupantTenure("n1", "initial").generationUuid;
      const grants = new ActivityGrantStore(db);
      const grant = grants.issue({ nodeId: "n1", generation, issuedBy: "launch", run: { runId: "current", sessionId: "sess-n1",
        binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
      grants.activate(grant.grantId);
      const state = { sessions: ["s1@rig"], panePid: { "%1": null as number | null }, paneCommand: { "%1": "node" } };
      const tmux = { ...makeTmux(state), listPanes: async () => {
        if (census === "unreadable") throw new Error("transport unavailable");
        return [{ id: "%1" }] as never;
      } };
      const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });
      await rec.reconcileAll();
      expect(new SeatIdentityStore(db).getForNode("n1")?.verdict).toBe("tmux_unavailable");
      expect(grants.get(grant.grantId)?.revokedAt).toBeNull();
      state.panePid["%1"] = 101;
      await rec.reconcileAll();
      expect(grants.standing(grant.grantId)).toBe("current");
    } finally { db.close(); }
  });

  it.each(["no reader", "unreadable", "missing", "stale", "pending", "ready", "exited"] as const)("requires current launch evidence before shell exit revocation: %s", async launch => {
    const db = createFullTestDb();
    try {
      seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", runtime: "pi", pane: "%1" });
      const generation = new SessionRegistry(db).mintOccupantTenure("n1", "initial").generationUuid;
      const grants = new ActivityGrantStore(db);
      const grant = grants.issue({ nodeId: "n1", generation, issuedBy: "launch", run: { runId: "current", sessionId: "sess-n1",
        binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
      grants.activate(grant.grantId);
      const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 101 }, paneCommand: { "%1": "sh" } });
      const readPiRunnerState = () => {
        if (launch === "unreadable") throw new Error("sidecar unavailable");
        return launch === "missing" ? null : {
          launchId: launch === "stale" ? "predecessor" : "current", ready: launch === "ready" || launch === "stale",
          updatedAt: NOW().toISOString(), ...(launch === "exited" ? { exited: { code: 1, at: NOW().toISOString() } } : {}),
        };
      };
      await new SeatIdentityReconciler({ db, tmux, now: NOW, ...(launch === "no reader" ? {} : { readPiRunnerState }) }).reconcileAll();
      expect(grants.standing(grant.grantId)).toBe(launch === "ready" || launch === "exited" ? "revoked" : "current");
      // Readiness limits irreversible authority cleanup; it does not turn the shell into a live agent verdict.
      expect(new SeatIdentityStore(db).getForNode("n1")?.verdict).toBe("mismatch");
    } finally { db.close(); }
  });

  it.each([false, true])("preserves a starting grant through bootstrap and revokes it only on a later established shell exit, late ready=%s", async lateReady => {
    const db = createFullTestDb();
    try {
      seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", runtime: "pi", pane: "%1" });
      const generation = new SessionRegistry(db).mintOccupantTenure("n1", "initial").generationUuid;
      const grants = new ActivityGrantStore(db);
      const grant = grants.issue({ nodeId: "n1", generation, issuedBy: "launch", run: { runId: "current", sessionId: "sess-n1",
        binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
      grants.activate(grant.grantId);
      const state = { sessions: ["s1@rig"], panePid: { "%1": 101 }, paneCommand: { "%1": "sh" } };
      let ready = false;
      const tmux = makeTmux(state);
      if (lateReady) vi.mocked(tmux.listSessions).mockImplementationOnce(async () => {
        ready = true; return [{ name: "s1@rig" }] as never;
      });
      const rec = new SeatIdentityReconciler({ db, tmux, now: NOW,
        readPiRunnerState: () => ({ launchId: "current", ready, updatedAt: NOW().toISOString() }) });
      await rec.reconcileAll();
      expect(grants.standing(grant.grantId)).toBe("current");
      ready = true; state.paneCommand["%1"] = "node";
      await rec.reconcileAll();
      expect(grants.standing(grant.grantId)).toBe("current");
      state.paneCommand["%1"] = "sh";
      await rec.reconcileAll();
      expect(grants.standing(grant.grantId)).toBe("revoked");
    } finally { db.close(); }
  });

  it.each([true, false])("preserves authority on transient or unconfirmed observations, transient=%s", async transient => {
    const db = createFullTestDb();
    try {
      seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", runtime: "synth", pane: "%1" });
      db.prepare("UPDATE sessions SET agent_app = 'synth', agent_runner = 1 WHERE node_id = 'n1'").run();
      const generation = new SessionRegistry(db).mintOccupantTenure("n1", "initial").generationUuid;
      const grants = new ActivityGrantStore(db);
      const grant = grants.issue({ nodeId: "n1", generation, issuedBy: "launch", run: { runId: "current", sessionId: "sess-n1",
        binding: { runtime: "synth", runner: 1, pane: "%1", panePid: 101 } } });
      expect(grants.activate(grant.grantId)).toBe(true);
      const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 101 }, paneCommand: { "%1": "node" }, throwListSessions: transient });
      await new SeatIdentityReconciler({ db, tmux, now: NOW }).reconcileAll();
      expect(grants.get(grant.grantId)?.revokedAt).toBeNull();
      expect(new SeatIdentityStore(db).getForNode("n1")?.verdict).toBe(transient ? "tmux_unavailable" : "unconfirmed");
    } finally { db.close(); }
  });

  it.each([false, true])("revokes the sampled run without touching a replacement during the await, replacement=%s", async replace => {
    const db = createFullTestDb();
    try {
      seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", runtime: "pi", pane: "%1" });
      const generation = new SessionRegistry(db).mintOccupantTenure("n1", "initial").generationUuid;
      const grants = new ActivityGrantStore(db);
      const issue = (runId: string) => grants.issue({ nodeId: "n1", generation, issuedBy: "launch", run: {
        runId, sessionId: "sess-n1", binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
      const first = issue("first"); grants.activate(first.grantId);
      let successor: ReturnType<typeof issue> | undefined;
      const tmux = makeTmux({ sessions: ["another@rig"] });
      tmux.listSessions = vi.fn(async () => {
        if (replace) { successor = issue("successor"); grants.activate(successor.grantId); }
        return [{ name: "another@rig" }] as never;
      });
      await new SeatIdentityReconciler({ db, tmux, now: NOW }).reconcileAll();
      expect(grants.standing(first.grantId)).toBe("revoked");
      if (successor) expect(grants.standing(successor.grantId)).toBe("current");
    } finally { db.close(); }
  });
});
