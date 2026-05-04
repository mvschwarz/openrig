// PL-019 item 5: read-side join helper used by GET /api/rigs/:id/graph
// to attach in-progress qitem ownership per node session. Tested as a
// focused unit so we exercise the SQL shape + capping + body-excerpt
// behavior without spinning up the full route stack (which depends on
// many migrations / services).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { loadCurrentQitemsForSessions } from "../src/routes/rigs.js";

function insertQitem(db: Database.Database, opts: {
  qitemId: string;
  source: string;
  destination: string;
  state: string;
  body: string;
  tier?: string | null;
  tsUpdated?: string;
}): void {
  db.prepare(
    `INSERT INTO queue_items (
      qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, priority, body, tier
    ) VALUES (?, ?, ?, ?, ?, ?, 'routine', ?, ?)`
  ).run(
    opts.qitemId,
    "2026-05-04T00:00:00.000Z",
    opts.tsUpdated ?? "2026-05-04T00:00:00.000Z",
    opts.source,
    opts.destination,
    opts.state,
    opts.body,
    opts.tier ?? null,
  );
}

describe("PL-019 loadCurrentQitemsForSessions read-side join", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  });

  afterEach(() => db.close());

  it("returns empty map for empty session list", () => {
    const result = loadCurrentQitemsForSessions(db, []);
    expect(result.size).toBe(0);
  });

  it("returns empty map when no qitems exist for the queried sessions", () => {
    insertQitem(db, { qitemId: "q1", source: "src@r", destination: "other@r", state: "in-progress", body: "x" });
    const result = loadCurrentQitemsForSessions(db, ["alpha@r", "beta@r"]);
    expect(result.size).toBe(0);
  });

  it("includes only state='in-progress' qitems (excludes pending/closed/handed-off)", () => {
    insertQitem(db, { qitemId: "q-pending", source: "s@r", destination: "alpha@r", state: "pending", body: "p" });
    insertQitem(db, { qitemId: "q-inprog", source: "s@r", destination: "alpha@r", state: "in-progress", body: "wip" });
    insertQitem(db, { qitemId: "q-closed", source: "s@r", destination: "alpha@r", state: "closed", body: "done" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    expect(result.get("alpha@r")).toHaveLength(1);
    expect(result.get("alpha@r")?.[0].qitemId).toBe("q-inprog");
  });

  it("groups qitems by destination_session", () => {
    insertQitem(db, { qitemId: "q1", source: "s@r", destination: "alpha@r", state: "in-progress", body: "a" });
    insertQitem(db, { qitemId: "q2", source: "s@r", destination: "beta@r", state: "in-progress", body: "b" });
    insertQitem(db, { qitemId: "q3", source: "s@r", destination: "alpha@r", state: "in-progress", body: "c" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r", "beta@r"]);
    expect(result.get("alpha@r")).toHaveLength(2);
    expect(result.get("beta@r")).toHaveLength(1);
  });

  it("caps per-node at 3 qitems even when more in-progress rows exist", () => {
    for (let i = 0; i < 6; i++) {
      insertQitem(db, {
        qitemId: `q-${i}`,
        source: "s@r",
        destination: "alpha@r",
        state: "in-progress",
        body: `row ${i}`,
        tsUpdated: `2026-05-04T00:00:0${i}.000Z`,
      });
    }
    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    expect(result.get("alpha@r")).toHaveLength(3);
  });

  it("excerpts body bodies longer than 80 chars with ellipsis", () => {
    const longBody = "x".repeat(120);
    insertQitem(db, { qitemId: "q-long", source: "s@r", destination: "alpha@r", state: "in-progress", body: longBody });
    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    const entry = result.get("alpha@r")?.[0];
    expect(entry).toBeDefined();
    expect(entry!.bodyExcerpt.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(entry!.bodyExcerpt.endsWith("…")).toBe(true);
  });

  it("preserves short bodies verbatim", () => {
    insertQitem(db, { qitemId: "q-short", source: "s@r", destination: "alpha@r", state: "in-progress", body: "tiny" });
    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    expect(result.get("alpha@r")?.[0].bodyExcerpt).toBe("tiny");
  });

  it("orders rows by ts_updated DESC (most-recently-touched first)", () => {
    insertQitem(db, { qitemId: "q-old", source: "s@r", destination: "alpha@r", state: "in-progress", body: "old", tsUpdated: "2026-05-04T00:00:00.000Z" });
    insertQitem(db, { qitemId: "q-mid", source: "s@r", destination: "alpha@r", state: "in-progress", body: "mid", tsUpdated: "2026-05-04T01:00:00.000Z" });
    insertQitem(db, { qitemId: "q-new", source: "s@r", destination: "alpha@r", state: "in-progress", body: "new", tsUpdated: "2026-05-04T02:00:00.000Z" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    const list = result.get("alpha@r") ?? [];
    expect(list.map((q) => q.qitemId)).toEqual(["q-new", "q-mid", "q-old"]);
  });

  it("carries tier through verbatim (string or null)", () => {
    insertQitem(db, { qitemId: "q-mode2", source: "s@r", destination: "alpha@r", state: "in-progress", body: "x", tier: "mode2" });
    insertQitem(db, { qitemId: "q-no-tier", source: "s@r", destination: "alpha@r", state: "in-progress", body: "y", tier: null, tsUpdated: "2026-05-04T01:00:00.000Z" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    const list = result.get("alpha@r") ?? [];
    const tierMode2 = list.find((q) => q.qitemId === "q-mode2");
    const tierNull = list.find((q) => q.qitemId === "q-no-tier");
    expect(tierMode2?.tier).toBe("mode2");
    expect(tierNull?.tier).toBeNull();
  });
});
