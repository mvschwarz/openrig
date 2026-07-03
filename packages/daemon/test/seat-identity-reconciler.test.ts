// OPR.0.4.3.19 — SeatIdentityReconciler unit tests.
//
// The reconciler owns the liveness identity verdict (the THIRD axis, orthogonal
// to slice-15's terminalActive/hasAssignedWork). It reconciles each running
// tmux-bound seat's pane PID/command against the registered binding and
// persists a durable verdict to `seat_identity_verdicts`. It reads ONLY tmux
// pane process identity — NEVER queue/classifier/hook heartbeats.

import { describe, it, expect, vi } from "vitest";
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
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": null } });
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

  it("liveness is NOT derived from heartbeats — a dead pane stays non-green regardless of any heartbeat", async () => {
    // The reconciler never reads queue/classifier/hook state; a seat whose pane
    // is gone yields pane_missing even if (hypothetically) work/heartbeats exist.
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // Simulate an active queue heartbeat for the seat (must not upgrade liveness).
    db.prepare(
      "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("q1", "2026-07-02T12:00:00Z", "2026-07-02T12:00:00Z", "op@rig", "s1@rig", "pending", "do work");
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": null } });
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
