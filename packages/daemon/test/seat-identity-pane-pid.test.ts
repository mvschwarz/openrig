import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { seatIdentityVerdictsSchema } from "../src/db/migrations/046_seat_identity_verdicts.js";
import { seatIdentityPanePidSchema } from "../src/db/migrations/119_seat_identity_pane_pid.js";
import { seatIdentityProcessEvidenceSchema } from "../src/db/migrations/135_seat_identity_process_evidence.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

it("upgrades legacy verdicts without inventing a pane root from the native child PID", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, [seatIdentityVerdictsSchema]);
    db.prepare(`INSERT INTO seat_identity_verdicts
      (node_id, verdict, observed_pid, observed_at) VALUES ('legacy', 'verified', 20, '2026-10-01T00:00:00Z')`).run();
    migrate(db, [seatIdentityVerdictsSchema, seatIdentityPanePidSchema, seatIdentityProcessEvidenceSchema]);
    const store = new SeatIdentityStore(db);
    expect(db.prepare("SELECT observed_pid, observed_pane_pid FROM seat_identity_verdicts").get())
      .toEqual({ observed_pid: 20, observed_pane_pid: null });
    expect(store.getForNode("legacy")!.evidence).not.toHaveProperty("observedPanePid");
    const verdict = { ...store.getForNode("legacy")!, evidence: { registeredPane: "%1", observedPid: 20,
      observedPanePid: 10, observedCommand: "claude", matchedLayer: 1 } };
    store.upsert(verdict);
    expect(store.getForNode("legacy")!.evidence).toEqual(verdict.evidence);
    // A later unavailable observation must clear both PIDs, not retain an old root.
    store.upsert({ ...verdict, verdict: "tmux_unavailable", reason: "tmux_unavailable",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null } });
    expect(db.prepare("SELECT observed_pid, observed_pane_pid FROM seat_identity_verdicts").get())
      .toEqual({ observed_pid: null, observed_pane_pid: null });
  } finally { db.close(); }
});
