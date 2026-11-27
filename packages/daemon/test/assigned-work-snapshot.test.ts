import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { readAssignedWorkBySession } from "../src/domain/node-inventory.js";
import { rosterReadyNoticeId } from "../src/domain/roster-ready-notice.js";
import { OPENRIG_SENDER } from "../src/lib/pane-envelope.js";

describe("assigned work uses one file-backed snapshot", () => {
  it.each(["pending", "in-progress", "blocked"])("keeps existing %s work when another connection inserts its notice after aggregation", state => {
    const dir = mkdtempSync(path.join(tmpdir(), "assigned-work-snapshot-"));
    const file = path.join(dir, "queue.sqlite");
    const reader = createDb(file);
    const writer = createDb(file);
    try {
      reader.exec(`CREATE TABLE queue_items (
        qitem_id TEXT PRIMARY KEY, source_session TEXT NOT NULL,
        destination_session TEXT NOT NULL, state TEXT NOT NULL
      )`);
      const seat = "worker@team";
      writer.prepare("INSERT INTO queue_items VALUES (?, ?, ?, ?)").run("ordinary-work", "peer@team", seat, state);
      const prepare = reader.prepare.bind(reader);
      let inserted = false;
      const spy = vi.spyOn(reader, "prepare").mockImplementation((...args: Parameters<typeof reader.prepare>) => {
        const statement = prepare(...args);
        if (String(args[0]).includes("COUNT(*) as assigned_count")) {
          const all = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
            const rows = all(...params);
            if (!inserted) {
              writer.prepare("INSERT INTO queue_items VALUES (?, ?, ?, ?)")
                .run(rosterReadyNoticeId("team-id", seat), OPENRIG_SENDER, seat, state);
              inserted = true;
            }
            return rows;
          });
        }
        return statement;
      });
      const counts = readAssignedWorkBySession(reader).get(seat);
      expect(inserted).toBe(true);
      expect(writer.prepare("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({ n: 2 });
      expect(counts).toEqual({ assignedWorkCount: 1,
        pendingWorkCount: state === "pending" ? 1 : 0,
        inProgressWorkCount: state === "in-progress" ? 1 : 0,
        blockedWorkCount: state === "blocked" ? 1 : 0 });
      spy.mockRestore();
      // On a later snapshot the notice is included in both reads and excluded once; real work still counts.
      expect(readAssignedWorkBySession(reader).get(seat)).toEqual(counts);
      expect(reader.inTransaction).toBe(false);
    } finally {
      vi.restoreAllMocks();
      writer.close(); reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
