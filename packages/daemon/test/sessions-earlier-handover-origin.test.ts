// #4003: before 0.7.9 a handover OpenRig launched registered its successor as adopted (origin=claimed), so stop, restart,
// clean and rig down refused or released a session OpenRig had launched. The upgrade records those successors as launched,
// as 0.7.9 and later record them (#2440), and leaves every session OpenRig truly didn't launch as it is.
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const BEFORE_UPGRADE = ALL_MIGRATIONS.filter((migration) => migration.name !== "200_sessions_earlier_handover_origin.sql");
const HANDOVER_AT = "2026-11-01T10:00:00.000Z";

/** A seat whose rows look the way a daemon before 0.7.9 left them, then the upgrade's migrations. */
function upgrade(seats: Array<{ id: string; continuity?: string | null; handover?: boolean; sessions: Array<{ origin: string; createdAt: string; status?: string }> }>) {
  const db = createDb();
  migrate(db, BEFORE_UPGRADE);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
  for (const seat of seats) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, 'rig-1', ?)").run(seat.id, seat.id);
    if (seat.handover !== false) {
      db.prepare("UPDATE nodes SET handover_result = 'complete', continuity_outcome = ?, handover_at = ? WHERE id = ?")
        .run(seat.continuity === undefined ? "fresh" : seat.continuity, HANDOVER_AT, seat.id);
    }
    seat.sessions.forEach((session, index) => db.prepare("INSERT INTO sessions (id, node_id, session_name, status, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`${seat.id}-s${index}`, seat.id, `${seat.id}@r`, session.status ?? "running", session.origin, session.createdAt));
  }
  migrate(db, ALL_MIGRATIONS);
  const origin = (id: string) => (db.prepare("SELECT origin FROM sessions WHERE id = ?").get(id) as { origin: string }).origin;
  return { db, origin };
}

describe("#4003: the upgrade records a launched handover's earlier successor as launched", () => {
  it.each(["fresh", "forked", "rebuilt"])("a %s handover's successor, registered in its commit, now reads launched", (continuity) => {
    // The successor's row is written in the handover's own transaction, a moment after the completion time is read.
    const { db, origin } = upgrade([{ id: "seat", continuity, sessions: [
      { origin: "launched", createdAt: "2026-10-01 09:00:00" },
      { origin: "claimed", createdAt: "2026-11-01 10:00:01" },
    ] }]);
    try {
      expect(origin("seat-s1")).toBe("launched");
      expect(origin("seat-s0")).toBe("launched");
    } finally { db.close(); }
  });

  it("leaves every session OpenRig didn't launch, or can't place, as adopted", () => {
    const { db, origin } = upgrade([
      // Adopted, with no handover at all.
      { id: "adopted", handover: false, sessions: [{ origin: "claimed", createdAt: "2026-11-01 10:00:00" }] },
      // A discovered successor: OpenRig found it running, so its continuity isn't recorded.
      { id: "discovered", continuity: null, sessions: [{ origin: "claimed", createdAt: "2026-11-01 10:00:00" }] },
      // Adopted an hour after a launched handover: not the handover's successor.
      { id: "later", sessions: [{ origin: "claimed", createdAt: "2026-11-01 11:00:00" }] },
      // The successor, released since with rig unclaim: it stays released.
      { id: "released", sessions: [{ origin: "claimed", createdAt: "2026-11-01 10:00:00", status: "detached" }] },
      // The successor isn't the seat's newest session any more.
      { id: "superseded", sessions: [
        { origin: "claimed", createdAt: "2026-11-01 10:00:00" },
        { origin: "claimed", createdAt: "2026-11-02 08:00:00" },
      ] },
      // An unreadable creation time can't be placed.
      { id: "unreadable", sessions: [{ origin: "claimed", createdAt: "not a time" }] },
    ]);
    try {
      for (const id of ["adopted-s0", "discovered-s0", "later-s0", "released-s0", "superseded-s0", "superseded-s1", "unreadable-s0"]) {
        expect(origin(id), id).toBe("claimed");
      }
    } finally { db.close(); }
  });
});
