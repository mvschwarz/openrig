import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { eraseQueue, type EraseAction } from "../src/domain/queue-erasure.js";

// The ledger's own writes go through node:fs, so a test can make one of them fail.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

const realAppend = (await vi.importActual<typeof import("node:fs")>("node:fs")).appendFileSync;
const NOW = "2026-11-09T12:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const A = "a-one@n-acct";
const B = "b-two@n-acct";
const routine = { kind: "routine", contentDays: 30, metadataDays: 0 } as const;

let db: Database.Database;
let repo: QueueRepository;
function open(handle: Database.Database) {
  db = handle;
  repo = new QueueRepository(db, new EventBus(db));
  repo.attachOutbox(new OutboxHandler(db));
}
beforeEach(() => {
  const handle = createDb();
  migrate(handle, ALL_MIGRATIONS);
  open(handle);
});
afterEach(() => {
  vi.mocked(fs.appendFileSync).mockImplementation(realAppend);
  db.close();
});

/** Close a row as of `daysAgo` days before NOW, its history and update time included. */
function close(id: string, daysAgo: number) {
  repo.update({ qitemId: id, actorSession: B, state: "done", closureReason: "no-follow-on" });
  db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(ago(daysAgo), id);
  db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(ago(daysAgo), id);
}
/** A row with secret content, closed `daysAgo` days ago, or open when null. */
async function row(id: string, daysAgo: number | null) {
  await repo.create({ qitemId: id, sourceSession: A, destinationSession: B, body: `secret-${id} body`, summary: `secret-${id} summary` });
  if (daysAgo !== null) close(id, daysAgo);
}
const body = (id: string) => (db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(id) as { body: string } | undefined)?.body;
const ledgerFile = () => join(mkdtempSync(join(tmpdir(), "erase-ledger-")), "ledger.jsonl");
type Line = { qitemId?: string; action?: EraseAction; batch?: string; committed?: boolean };
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line);
/** The documented replay: the ledger's lines as given (entries keep their batch; commit and abort lines say which committed). */
const replay = (path: string, ledgerPath?: string) => {
  const all = lines(path);
  return eraseQueue(db, {
    scope: { kind: "ids", entries: all.filter((line) => line.qitemId !== undefined) as Array<{ qitemId: string; action: EraseAction; batch?: string }>,
      commits: all.filter((line) => line.committed !== undefined) as Array<{ batch: string; committed: boolean }> },
    apply: true, nowIso: NOW, ...(ledgerPath ? { ledgerPath } : {}),
  });
};
const dropLines = (path: string, keep: (line: Line) => boolean) =>
  writeFileSync(path, lines(path).filter(keep).map((line) => JSON.stringify(line)).join("\n") + "\n");

describe("the erasure ledger replays exactly what committed", () => {
  it("a committed batch's lines carry its id, a commit line follows, and the database records the batch", async () => {
    await row("c-row", 40);
    const path = ledgerFile();
    await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    const [entry, commit] = lines(path);
    expect(entry).toMatchObject({ qitemId: "c-row", action: "scrub", batch: expect.any(String) });
    expect(commit).toEqual({ batch: entry.batch, committed: true, at: NOW });
    expect(db.prepare("SELECT batch_id, line_at FROM queue_erasure_batches").all()).toEqual([{ batch_id: entry.batch, line_at: NOW }]);
  });

  it("a rolled-back batch is never replayed, after a reopen, a restore and a replay", async () => {
    await row("a-row", 40);
    const backup = db.serialize();
    const path = ledgerFile();
    db.exec("CREATE TEMP TRIGGER fail_scrub BEFORE UPDATE OF content_erased_at ON queue_items BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;");
    const failed = await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    expect(failed).toMatchObject({ complete: false, error: { stage: "rows" }, qitems: [] });
    const [entry, abort] = lines(path);
    expect(abort).toEqual({ batch: entry.batch, committed: false, at: NOW });
    db.exec("DROP TRIGGER fail_scrub");
    repo.update({ qitemId: "a-row", actorSession: B, state: "pending", reopen: true, transitionNote: "back to work" });
    db.close();
    open(new Database(backup));
    const replayed = await replay(path, path);
    expect(body("a-row")).toBe("secret-a-row body");
    expect(replayed.skipped).toEqual([{ qitemId: "a-row", batch: entry.batch }]);
    expect(replayed.qitems).toEqual([]);
  });

  it("a committed erasure is replayed although the older backup shows the row open", async () => {
    await row("b-row", null);
    const backup = db.serialize();
    close("b-row", 40);
    const path = ledgerFile();
    await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    db.close();
    open(new Database(backup));
    expect(body("b-row")).toBe("secret-b-row body");
    const replayed = await replay(path, path);
    expect(replayed).toMatchObject({ qitems: [{ qitemId: "b-row", action: "scrub" }], skipped: [], gaps: [] });
    expect(body("b-row")).toBe("");
  });

  it("a commit line lost after the commit is written from the live database's record, and the replay applies it", async () => {
    await row("l-row", null);
    const backup = db.serialize();
    close("l-row", 40);
    const path = ledgerFile();
    await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    // A crash between the commit and its commit line: the line is missing, and the record says so.
    dropLines(path, (line) => line.committed === undefined);
    db.prepare("UPDATE queue_erasure_batches SET line_at = NULL").run();
    const batch = lines(path)[0].batch!;
    // The next applied run, on the live database, finds the batch's record and writes its commit line.
    const next = await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    expect(next.ledger).toEqual({ reconciled: [batch] });
    expect(lines(path)).toContainEqual({ batch, committed: true, at: NOW, reconciled: true });
    db.close();
    open(new Database(backup));
    const replayed = await replay(path, path);
    expect(replayed.qitems.map((q) => q.qitemId)).toEqual(["l-row"]);
    expect(body("l-row")).toBe("");
  });

  it("a commit line that can't be written stops the run after reporting the committed batch, and the next run writes it", async () => {
    await row("w-one", 40);
    await row("w-two", 40);
    const path = ledgerFile();
    vi.mocked(fs.appendFileSync).mockImplementation((file, data, options) => {
      if (String(data).includes('"committed":true')) throw new Error("no space left on device (test)");
      return realAppend(file, data, options);
    });
    const stopped = await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path, batchSize: 1 });
    vi.mocked(fs.appendFileSync).mockImplementation(realAppend);
    expect(stopped).toMatchObject({ complete: false, error: { stage: "ledger", message: "no space left on device (test)" } });
    expect(stopped.qitems.map((q) => q.qitemId)).toEqual(["w-one"]);
    expect(body("w-one")).toBe("");
    expect(body("w-two")).toBe("secret-w-two body");
    const next = await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path, batchSize: 1 });
    expect(next.ledger!.reconciled).toHaveLength(1);
    expect(next.qitems.map((q) => q.qitemId)).toEqual(["w-two"]);
    expect(lines(path).filter((line) => line.committed === true)).toHaveLength(2);
  });

  it("with no trusted live database, an undecided batch stays unresolved: never replayed, never marked aborted, not clean", async () => {
    await row("u-row", null);
    const backup = db.serialize();
    close("u-row", 40);
    const path = ledgerFile();
    await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    // The commit line is lost, and so is the live database: the restore is all there is.
    dropLines(path, (line) => line.committed === undefined);
    const batch = lines(path)[0].batch!;
    db.close();
    open(new Database(backup));
    const replayed = await replay(path, path);
    expect(replayed.ledger).toEqual({ reconciled: [] });
    expect(replayed.gaps).toEqual([{ code: "ledger-unresolved", qitemId: "u-row" }]);
    expect(replayed.clean).toBe(false);
    expect(body("u-row")).toBe("secret-u-row body");
    // The older database's silence decided nothing: no abort (or commit) line was written for the batch.
    expect(lines(path).filter((line) => line.committed !== undefined)).toEqual([]);
  });

  it("a batch whose abort line was lost (a crash in its transaction) stays unresolved on the live database too", async () => {
    await row("k-row", 40);
    const path = ledgerFile();
    db.exec("CREATE TEMP TRIGGER fail_scrub BEFORE UPDATE OF content_erased_at ON queue_items BEGIN SELECT RAISE(ABORT, 'killed (test)'); END;");
    await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    db.exec("DROP TRIGGER fail_scrub");
    dropLines(path, (line) => line.committed === undefined);
    const batch = lines(path)[0].batch!;
    repo.update({ qitemId: "k-row", actorSession: B, state: "pending", reopen: true, transitionNote: "back to work" });
    const replayed = await replay(path);
    expect(replayed.gaps).toEqual([{ code: "ledger-unresolved", qitemId: "k-row" }]);
    expect(body("k-row")).toBe("secret-k-row body");
    // A routine (or members) run's clean is about its own scope: the undecided batch doesn't affect it. Only a replay,
    // which would apply the batch, reports it (above).
    const live = await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    expect(live).toMatchObject({ ledger: { reconciled: [] }, clean: true, gaps: [] });
    expect(lines(path).filter((line) => line.batch === batch && line.committed !== undefined)).toEqual([]);
  });

  it("a last line cut short is closed off before the run writes, so the next line stays whole", async () => {
    await row("n-row", 40);
    const path = ledgerFile();
    writeFileSync(path, '{"qitemId":"n-earlier","action":"scr');
    await eraseQueue(db, { scope: routine, apply: true, nowIso: NOW, ledgerPath: path });
    const [cut, ...rest] = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(cut).toBe('{"qitemId":"n-earlier","action":"scr');
    expect(rest.map((line) => JSON.parse(line) as Line)).toEqual([
      expect.objectContaining({ qitemId: "n-row", action: "scrub" }), expect.objectContaining({ committed: true }),
    ]);
  });
});
