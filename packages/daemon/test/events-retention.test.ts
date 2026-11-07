import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import {
  PRUNABLE_EVENT_TYPES,
  RETENTION_DEFAULTS,
  eventsCutoffSql,
  findEventsCutoffSeq,
  pruneEvents,
  runQueueRetentionSweep,
} from "../src/domain/queue-retention.js";
import { readTelemetryPage } from "../src/domain/finite-telemetry.js";
import { startQueueRetentionScheduler } from "../src/index.js";

// The events pass of the queue-retention sweep: an allowlist of history-only event types, a cutoff in
// SQLite's own timestamp format, one bounded seq window per statement, and a persisted low-water mark.
// Every seed sets created_at explicitly and the clock is injected (nowIso), so each case is deterministic.

const NOW = "2026-07-15T18:00:00.000Z";
const SRC = join(import.meta.dirname, "..", "src");

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function makeDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  open.push(db);
  return db;
}

/** SQLite text timestamp `days` (and `seconds`) before NOW, the format datetime('now') writes. */
function ago(days: number, seconds = 0): string {
  const t = new Date(new Date(NOW).getTime() - days * 86_400_000 - seconds * 1000);
  return t.toISOString().slice(0, 19).replace("T", " ");
}

function insert(db: Database.Database, type: string, createdAt: string, nodeId: string | null = null): number {
  return Number(
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, ?, '{}', ?)")
      .run("rig-a", nodeId, type, createdAt).lastInsertRowid,
  );
}

function insertAt(db: Database.Database, seq: number, type: string, createdAt: string): void {
  db.prepare("INSERT INTO events (seq, rig_id, node_id, type, payload, created_at) VALUES (?, 'rig-a', NULL, ?, '{}', ?)")
    .run(seq, type, createdAt);
}

const seqs = (db: Database.Database): number[] =>
  (db.prepare("SELECT seq FROM events ORDER BY seq").all() as Array<{ seq: number }>).map((r) => r.seq);
const countAll = (db: Database.Database): number =>
  (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;

const STATE_TYPES = [
  "node.startup_ready",
  "restore.completed",
  "agent.activity",
  "node.held",
  "seat.activity_changed",
  "watchdog.evaluation_skipped",
] as const;

const noPause = { eventsYield: async () => {} };

describe("events retention — what is deleted", () => {
  it("deletes only the old rows of the eight prunable types; old state rows and new rows stay, by type and seq", async () => {
    const db = makeDb();
    const kept: number[] = [];
    const doomed: number[] = [];
    for (const type of PRUNABLE_EVENT_TYPES) doomed.push(insert(db, type, ago(20)));
    for (const type of STATE_TYPES) kept.push(insert(db, type, ago(20), type === "agent.activity" ? "node-1" : null));
    for (const type of PRUNABLE_EVENT_TYPES) kept.push(insert(db, type, ago(1)));
    for (const type of STATE_TYPES) kept.push(insert(db, type, ago(1)));

    const result = await pruneEvents(db, { nowIso: NOW, ...noPause });

    expect(result.deletedRows).toBe(PRUNABLE_EVENT_TYPES.length);
    expect(seqs(db)).toEqual(kept.sort((a, b) => a - b));
    const left = db.prepare("SELECT type, COUNT(*) AS c FROM events WHERE created_at < ? GROUP BY type ORDER BY type").all(ago(14)) as Array<{ type: string; c: number }>;
    expect(left).toEqual([...STATE_TYPES].sort().map((type) => ({ type, c: 1 })));
    for (const seq of doomed) {
      expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(seq)).toBeUndefined();
    }
  });

  it("keeps a prunable row exactly at the cutoff and deletes one a second older", async () => {
    const db = makeDb();
    insert(db, "agent.activity", ago(30));
    const older = insert(db, "queue.updated", ago(14, 1));
    const atCutoff = insert(db, "queue.updated", ago(14));
    insert(db, "queue.updated", ago(1));

    const result = await pruneEvents(db, { nowIso: NOW, ...noPause });

    expect(result.deletedRows).toBe(1);
    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(older)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(atCutoff)).toBeDefined();
  });

  it("compares the cutoff in SQLite format: a row later on the cutoff day is not deleted", async () => {
    const db = makeDb();
    // now 18:00:00Z, 14 days: the cutoff is D 18:00:00. D 23:00:00 is newer than the cutoff, although as text it
    // sorts before the ISO form DT18:00:00.000Z (' ' < 'T').
    const cutoff = eventsCutoffSql(NOW, 14);
    expect(cutoff).toBe("2026-07-01 18:00:00");
    const before = insert(db, "snapshot.created", "2026-07-01 17:59:59");
    const sameDayLater = insert(db, "snapshot.created", "2026-07-01 23:00:00");

    await pruneEvents(db, { nowIso: NOW, ...noPause });

    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(before)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(sameDayLater)).toBeDefined();
  });

  it("does not delete a row with a low seq and a new created_at (a clock step back)", async () => {
    const db = makeDb();
    insertAt(db, 1, "queue.created", ago(30));
    insertAt(db, 2, "queue.created", ago(1)); // written after the clock went back: low seq, new time
    insertAt(db, 3, "queue.created", ago(30));
    insertAt(db, 4, "queue.created", ago(20));
    insertAt(db, 5, "queue.created", ago(1));
    expect(findEventsCutoffSeq(db, eventsCutoffSql(NOW, 14))).toBeGreaterThan(2);

    const first = await pruneEvents(db, { nowIso: NOW, ...noPause });

    expect(seqs(db)).toEqual([2, 5]);
    // The mark stops below the row kept for being too new, so a later sweep checks it again and it goes once it ages.
    expect(first.lowWater).toBe(1);
    const later = new Date(new Date(NOW).getTime() + 20 * 86_400_000).toISOString();
    insertAt(db, 6, "node.held", ago(-20));
    await pruneEvents(db, { nowIso: later, ...noPause });
    expect(seqs(db)).toEqual([6]);
  });

  it("never deletes the newest event, however old it is", async () => {
    const db = makeDb();
    insert(db, "queue.updated", ago(40));
    const newest = insert(db, "queue.updated", ago(30));

    const result = await pruneEvents(db, { nowIso: NOW, ...noPause });

    expect(result.deletedRows).toBe(1);
    expect(seqs(db)).toEqual([newest]);
  });

  it("starts again from the oldest row when the mark was made with another allowlist", async () => {
    const db = makeDb();
    const old = insert(db, "queue.updated", ago(30));
    insert(db, "node.held", ago(1));
    db.prepare("INSERT INTO events_retention_marks (id, low_water_seq, prunable_types, updated_at) VALUES (1, ?, 'view.changed', ?)").run(old, NOW);

    const result = await pruneEvents(db, { nowIso: NOW, ...noPause });

    expect(result.deletedRows).toBe(1);
    const mark = db.prepare("SELECT prunable_types AS types FROM events_retention_marks WHERE id = 1").get() as { types: string };
    expect(mark.types).toBe(PRUNABLE_EVENT_TYPES.join(","));
  });
});

describe("events retention — bounded work", () => {
  it("deletes in at least two windows and yields between them", async () => {
    const db = makeDb();
    for (let i = 0; i < 6; i++) insert(db, "view.changed", ago(20));
    insert(db, "view.changed", ago(1));
    let yields = 0;

    const result = await pruneEvents(db, { nowIso: NOW, eventsWindow: 2, eventsYield: async () => { yields++; } });

    expect(result.deletedRows).toBe(6);
    expect(result.batches).toBeGreaterThanOrEqual(2);
    expect(yields).toBeGreaterThanOrEqual(result.batches - 1);
  });

  it("lets the event loop run between windows with the default yield", async () => {
    const db = makeDb();
    for (let i = 0; i < 6; i++) insert(db, "view.changed", ago(20));
    insert(db, "view.changed", ago(1));
    let ranBeforeEnd = false;
    setImmediate(() => { ranBeforeEnd = true; });
    let sawItRunning = false;

    await pruneEvents(db, {
      nowIso: NOW,
      eventsWindow: 2,
      eventsPauseMs: 0,
      onEventsWindow: () => { if (ranBeforeEnd) sawItRunning = true; },
    });

    expect(sawItRunning).toBe(true);
  });

  it("each statement deletes only inside its own seq window", async () => {
    const db = makeDb();
    const window = 10;
    for (let i = 0; i < 3 * window + 5; i++) insert(db, "view.changed", ago(20));
    insert(db, "node.held", ago(1));
    const violations: string[] = [];

    const result = await pruneEvents(db, {
      nowIso: NOW,
      eventsWindow: window,
      ...noPause,
      onEventsWindow: ({ lo, hi, deleted }) => {
        const goneAbove = db.prepare("SELECT COUNT(*) AS c FROM events WHERE seq > ?").get(hi) as { c: number };
        const expectedAbove = (3 * window + 5) - hi + 1; // every view.changed above hi plus the node.held row
        if (goneAbove.c !== expectedAbove) violations.push(`window (${lo}, ${hi}] reached rows above ${hi}`);
        if (deleted > hi - lo) violations.push(`window (${lo}, ${hi}] deleted ${deleted}`);
      },
    });

    expect(violations).toEqual([]);
    expect(result.deletedRows).toBe(3 * window + 5);
    expect(result.batches).toBe(Math.ceil((3 * window + 5) / window));
  });

  it("bounds every statement to one seq window and resumes the next sweep at the persisted low-water mark", async () => {
    const db = makeDb();
    const window = 10;
    for (let i = 0; i < 3 * window + 5; i++) insert(db, "agent.activity", ago(20)); // old state rows, never deleted
    for (let i = 0; i < 3; i++) insert(db, "agent.activity", ago(13, 43_200)); // 13.5 days: past the cutoff tomorrow
    for (let i = 0; i < 3; i++) insert(db, "agent.activity", ago(1));
    const n = 3 * window + 5;
    const firstCutoff = findEventsCutoffSeq(db, eventsCutoffSql(NOW, 14));
    const windows: Array<{ lo: number; hi: number }> = [];

    const first = await pruneEvents(db, { nowIso: NOW, eventsWindow: window, ...noPause, onEventsWindow: (w) => windows.push(w) });

    expect(first.deletedRows).toBe(0);
    expect(first.batches).toBeGreaterThanOrEqual(Math.ceil(n / window));
    for (const w of windows) expect(w.hi - w.lo).toBeLessThanOrEqual(window);
    expect(first.lowWater).toBe(firstCutoff - 1);
    const mark = db.prepare("SELECT low_water_seq AS seq FROM events_retention_marks WHERE id = 1").get() as { seq: number };
    expect(mark.seq).toBe(first.lowWater);

    // A day later: a few more rows age past the cutoff. The second sweep starts at the mark, not at the start.
    const later = new Date(new Date(NOW).getTime() + 86_400_000).toISOString();
    const second: Array<{ lo: number; hi: number }> = [];
    const again = await pruneEvents(db, { nowIso: later, eventsWindow: window, ...noPause, onEventsWindow: (w) => second.push(w) });

    expect(second.length).toBeGreaterThan(0);
    expect(second[0]!.lo + 1).toBeGreaterThanOrEqual(firstCutoff);
    expect(again.batches).toBeLessThanOrEqual(1);
  });
});

describe("events retention — the sweep and the scheduler", () => {
  it("honours eventsRetentionDays in the sweep and reports eventsDeleted, eventsBatches and eventsLowWater", async () => {
    const db = makeDb();
    const fourDays = insert(db, "queue.claimed", ago(4));
    const fiveDays = insert(db, "queue.updated", ago(5));
    const twoDays = insert(db, "queue.claimed", ago(2));
    insert(db, "node.held", ago(4));
    const before = countAll(db);

    const summary = await runQueueRetentionSweep(db, { nowIso: NOW, eventsRetentionDays: 3, ...noPause });

    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(fourDays)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(fiveDays)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(twoDays)).toBeDefined();
    expect(summary.eventsDeleted).toBe(before - countAll(db));
    expect(summary.eventsDeleted).toBe(2);
    expect(summary.eventsBatches).toBe(1);
    expect(summary.eventsLowWater).toBe(twoDays - 1);
  });

  it("uses the 14-day default when the sweep gets no events option", async () => {
    expect(RETENTION_DEFAULTS.eventsRetentionDays).toBe(14);
    const db = makeDb();
    const fourDays = insert(db, "queue.claimed", ago(4));
    insert(db, "queue.claimed", ago(2));

    const summary = await runQueueRetentionSweep(db, { nowIso: NOW, ...noPause });

    expect(summary.eventsDeleted).toBe(0);
    expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(fourDays)).toBeDefined();
  });

  it("the scheduler's boot sweep reads retention.events_days from the settings store", async () => {
    const db = makeDb();
    const fourDays = insert(db, "queue.unclaimed", new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 19).replace("T", " "));
    const twoDays = insert(db, "queue.unclaimed", new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 19).replace("T", " "));
    const settings: Record<string, unknown> = { "retention.enabled": true, "retention.events_days": 3 };
    const settingsStore = { resolveOne: (key: string) => ({ value: settings[key] }) };

    const handle = startQueueRetentionScheduler({ rigRepo: { db }, settingsStore });
    try {
      await expect.poll(() => db.prepare("SELECT 1 FROM events WHERE seq = ?").get(fourDays), { timeout: 5000 }).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM events WHERE seq = ?").get(twoDays)).toBeDefined();
      // Let the fire-and-forget boot sweep finish its last pause before the database closes.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      if (handle) clearInterval(handle);
    }
  });

  it("the scheduler deletes nothing from events when retention.enabled is false", async () => {
    const db = makeDb();
    insert(db, "queue.unclaimed", new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 19).replace("T", " "));
    const before = countAll(db);
    const settings: Record<string, unknown> = { "retention.enabled": false, "retention.events_days": 3 };

    const handle = startQueueRetentionScheduler({ rigRepo: { db }, settingsStore: { resolveOne: (key: string) => ({ value: settings[key] }) } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handle).toBeNull();
    expect(countAll(db)).toBe(before);
  });
});

describe("events retention — finite telemetry", () => {
  it("an export over the retained window reports a retained_sequence_gap after a prune inside it", async () => {
    const db = makeDb();
    insert(db, "node.startup_ready", ago(20)); // a state row older than the pruned ones: the export starts before them
    for (let i = 0; i < 3; i++) insert(db, "snapshot.created", ago(20));
    insert(db, "node.startup_ready", ago(1));
    const source = { hostId: "host-test", bootEpoch: "boot-test" };

    const beforeExport = readTelemetryPage(db, source, "events", { start: "retained" }, NOW);
    expect(beforeExport.coverage.status).toBe("retained_window");
    expect(beforeExport.coverage.gaps).toEqual([]);

    await pruneEvents(db, { nowIso: NOW, ...noPause });
    const afterExport = readTelemetryPage(db, source, "events", { start: "retained" }, NOW);

    expect(afterExport.coverage.status).toBe("partial");
    expect(afterExport.coverage.gaps).toContainEqual({ code: "retained_sequence_gap", from: "2", through: "4" });
  });
});

// The guard: no reader may select a prunable type from events in SQL. In a daemon source file that reads
// FROM events, a prunable type literal may only appear where an event is EMITTED (type: or name:) or in an
// in-memory filter (=== / !== / case). The pruner's own PRUNABLE_EVENT_TYPES declaration is exempt.
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function guardFindings(files: Array<{ rel: string; text: string }>): string[] {
  const findings: string[] = [];
  for (const { rel, text: raw } of files) {
    if (!/\bFROM\s+events\b/i.test(raw)) continue;
    let text = raw;
    if (rel === "domain/queue-retention.ts") {
      text = text.replace(/(PRUNABLE_EVENT_TYPES\b[^=]*=\s*\[)([\s\S]*?)(\])/, (_m, a: string, body: string, b: string) => a + body.replace(/[^\n]/g, " ") + b);
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const type of PRUNABLE_EVENT_TYPES) {
        if (!line.includes(type)) continue;
        const lit = `["'\`]${type.replace(".", "\\.")}["'\`]`;
        const before = lines.slice(Math.max(0, i - 3), i).join("\n");
        const openCall = /\.(?:get|all|run|iterate|pluck)\s*\(\s*\{?\s*$/m.test(before) && !/\)\s*;?\s*$/.test(before);
        const sqlCall = /\.(?:get|all|run|iterate|pluck)\s*\(|[@$:]type\b/.test(line);
        const allowed = new RegExp(`\\b(?:type|name)\\s*:\\s*${lit}|[!=]==\\s*${lit}|${lit}\\s*[!=]==|\\bcase\\s+${lit}\\s*:`, "g");
        const rest = line.replace(allowed, "");
        if (openCall || sqlCall || new RegExp(lit).test(rest)) findings.push(`${rel}:${i + 1}: ${type}`);
      }
    });
  }
  return findings;
}

describe("events retention — guard", () => {
  it("no daemon source reads a prunable type from events in SQL, and no prunable event type declares nodeId", () => {
    const files = sourceFiles(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
    expect(guardFindings(files)).toEqual([]);

    // The guard catches a SQL reader and a constant.
    expect(guardFindings([{ rel: "domain/x.ts", text: "db.prepare(`SELECT seq FROM events WHERE type = 'queue.created'`).all();" }])).toHaveLength(1);
    expect(guardFindings([{ rel: "domain/x.ts", text: "// FROM events\nconst X = \"snapshot.created\";" }])).toHaveLength(1);
    expect(guardFindings([{ rel: "domain/x.ts", text: "// FROM events\nstmt.get({ type: \"queue.updated\" });" }])).toHaveLength(1);
    // ... and lets an emission and an in-memory filter through.
    expect(guardFindings([{ rel: "domain/x.ts", text: "// FROM events\nbus.emit({ type: \"queue.updated\", qitemId });\nif (e.type === \"view.changed\") return;" }])).toEqual([]);

    // No prunable type is written with a node id, so the "last N for this node" readers never see one.
    const types = readFileSync(join(SRC, "domain", "types.ts"), "utf8");
    const declared = new Set<string>();
    for (const m of types.matchAll(/\|\s*\{\s*type:\s*"([^"]+)"([^{}]*)\}/g)) {
      if (!(PRUNABLE_EVENT_TYPES as readonly string[]).includes(m[1]!)) continue;
      declared.add(m[1]!);
      expect(/\bnodeId\??\s*:/.test(m[2]!), `${m[1]} declares nodeId`).toBe(false);
    }
    expect([...declared].sort()).toEqual([...PRUNABLE_EVENT_TYPES].sort());
  });
});
