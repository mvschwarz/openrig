import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { seatIdentityVerdictsSchema } from "../src/db/migrations/046_seat_identity_verdicts.js";
import { seatIdentityPanePidSchema } from "../src/db/migrations/119_seat_identity_pane_pid.js";
import { seatIdentityProcessEvidenceSchema } from "../src/db/migrations/135_seat_identity_process_evidence.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { SeatIdentityVerdict } from "../src/domain/types.js";

// The last process observed for a seat is kept with its own time, apart from the current verdict, so a verdict that
// couldn't see the seat stays honest without erasing what startup reconcile needs on the next restart.

const T0 = "2026-10-24T05:00:00.000Z";
const T1 = "2026-10-24T05:00:05.000Z";
const verdict = (sessionName: string, observedAt: string, pid: number | null, panePid: number | null = pid): SeatIdentityVerdict => ({
  nodeId: "n1", verdict: pid === null ? "tmux_unavailable" : "verified", evidenceSource: null,
  reason: pid === null ? "tmux_unavailable" : null, sessionName, observedAt,
  evidence: { registeredPane: "%1", observedPid: pid, ...(panePid === null ? {} : { observedPanePid: panePid }), observedCommand: null, matchedLayer: null },
});

describe("a seat's last observed process", () => {
  const withStore = (test: (store: SeatIdentityStore) => void) => {
    const db = new Database(":memory:");
    try {
      migrate(db, [seatIdentityVerdictsSchema, seatIdentityPanePidSchema, seatIdentityProcessEvidenceSchema]);
      test(new SeatIdentityStore(db));
    } finally { db.close(); }
  };

  it("survives a verdict for the same session that saw no process, which itself stays honest", () => withStore((store) => {
    store.upsert(verdict("s@r", T0, 42, 41));
    store.upsert(verdict("s@r", T1, null));
    expect(store.getForNode("n1")).toMatchObject({ verdict: "tmux_unavailable", observedAt: T1, evidence: { observedPid: null } });
    expect(store.getForNode("n1")!.evidence).not.toHaveProperty("observedPanePid");
    expect(store.getProcessEvidence("n1")).toEqual({ sessionName: "s@r", pid: 42, panePid: 41, observedAt: T0 });
  }));

  it("is replaced by the next verdict that observes a process", () => withStore((store) => {
    store.upsert(verdict("s@r", T0, 42, 41));
    store.upsert(verdict("s@r", T1, 52, 51));
    expect(store.getProcessEvidence("n1")).toEqual({ sessionName: "s@r", pid: 52, panePid: 51, observedAt: T1 });
  }));

  it("is cleared by a verdict without a process for another session", () => withStore((store) => {
    store.upsert(verdict("s@r", T0, 42, 41));
    store.upsert(verdict("s2@r", T1, null));
    expect(store.getProcessEvidence("n1")).toBeNull();
  }));

  it("is backfilled at upgrade from verdicts that carried a pid", () => {
    const db = new Database(":memory:");
    try {
      migrate(db, [seatIdentityVerdictsSchema, seatIdentityPanePidSchema]);
      db.prepare(`INSERT INTO seat_identity_verdicts (node_id, verdict, observed_pid, observed_pane_pid, session_name, observed_at)
        VALUES ('n1', 'verified', 42, 41, 's@r', ?), ('n2', 'tmux_unavailable', NULL, NULL, 't@r', ?)`).run(T0, T0);
      migrate(db, [seatIdentityVerdictsSchema, seatIdentityPanePidSchema, seatIdentityProcessEvidenceSchema]);
      const store = new SeatIdentityStore(db);
      expect(store.getProcessEvidence("n1")).toEqual({ sessionName: "s@r", pid: 42, panePid: 41, observedAt: T0 });
      expect(store.getProcessEvidence("n2")).toBeNull();
    } finally { db.close(); }
  });
});
