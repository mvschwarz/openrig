import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { startWalCheckpointer, type WalCheckpointer } from "../src/db/wal-checkpointer.js";

// #3895: SQLite's WAL checkpoints (and their fsyncs) leave the daemon's event loop.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A file database whose automatic checkpoint is due after `thresholdPages` WAL pages (SQLite's default: 1000). */
function fileDb(thresholdPages?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wal-checkpointer-"));
  const file = path.join(dir, "openrig.sqlite");
  const db = createDb(file);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body BLOB)");
  db.pragma("wal_checkpoint(TRUNCATE)");
  if (thresholdPages !== undefined) db.pragma(`wal_autocheckpoint = ${thresholdPages}`);
  cleanups.push(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, file };
}

function track(checkpointer: WalCheckpointer | null) {
  if (checkpointer) cleanups.push(() => checkpointer.stop());
  return checkpointer;
}

const pragma = (db: ReturnType<typeof createDb>, name: string) => db.pragma(name, { simple: true });
/** Pages the WAL holds that no checkpoint has copied into the database file yet. NOOP reads the counts and does no work. */
function pendingPages(db: ReturnType<typeof createDb>): number {
  const [wal] = db.pragma("wal_checkpoint(NOOP)") as Array<{ log: number; checkpointed: number }>;
  return wal!.log - wal!.checkpointed;
}
function insertPages(db: ReturnType<typeof createDb>, pages: number) {
  const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
  db.transaction(() => { for (let i = 0; i < pages; i += 1) insert.run(Buffer.alloc(4096, i)); })();
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await sleep(25);
  }
}

describe("startWalCheckpointer", () => {
  it("leaves a memory database alone", async () => {
    const db = createDb();
    expect(await startWalCheckpointer(db)).toBeNull();
    expect(pragma(db, "wal_autocheckpoint")).toBe(1000);
    db.close();
  });

  it("leaves a database alone whose automatic checkpoint is already off", async () => {
    const { db } = fileDb(0);
    expect(await startWalCheckpointer(db)).toBeNull();
    expect(pragma(db, "wal_autocheckpoint")).toBe(0);
  });

  it("turns the main connection's automatic checkpoint off and leaves synchronous as it was", async () => {
    const { db } = fileDb();
    insertPages(db, 1);
    const synchronous = pragma(db, "synchronous");
    const checkpointer = track(await startWalCheckpointer(db, { pollMs: 20 }));
    expect(checkpointer?.active).toBe(true);
    expect(pragma(db, "wal_autocheckpoint")).toBe(0);
    expect(pragma(db, "synchronous")).toBe(synchronous);
  });

  it("the worker checkpoints once the WAL reaches the automatic checkpoint's threshold, and not before", async () => {
    const { db } = fileDb(64);
    track(await startWalCheckpointer(db, { pollMs: 20 }));
    insertPages(db, 16);
    const below = pendingPages(db);
    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThan(64);
    await sleep(200); // ten polls
    expect(pendingPages(db)).toBe(below);
    insertPages(db, 64);
    // The main connection's own checkpoint is off, so only the worker can bring this to zero.
    await waitFor(() => pendingPages(db) === 0);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 80 });
  });

  it("a WAL that passes the cap goes back to the main connection's own checkpoint until it has been reused", async () => {
    const { db, file } = fileDb(8);
    track(await startWalCheckpointer(db, { pollMs: 20, capFactor: 4 }));
    expect(pragma(db, "wal_autocheckpoint")).toBe(0);
    // An open read transaction pins the WAL: no checkpoint can copy past it and the WAL can't be reused, which is
    // what commits that overlap every checkpoint do to it.
    const reader = createDb(file);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM t").get();
    insertPages(db, 40); // past the cap of 4 x 8 pages
    await waitFor(() => pragma(db, "wal_autocheckpoint") === 8);
    reader.exec("COMMIT");
    reader.close();
    insertPages(db, 1); // the main connection checkpoints inside this commit
    expect(pendingPages(db)).toBe(0);
    insertPages(db, 1); // and this write reuses the WAL from its start
    await waitFor(() => pragma(db, "wal_autocheckpoint") === 0);
    expect((db.pragma("wal_checkpoint(NOOP)") as Array<{ log: number }>)[0]!.log).toBeLessThan(8);
  });

  it("a reused WAL goes back to the worker even when every transaction is as large as the threshold", async () => {
    const { db, file } = fileDb(8);
    track(await startWalCheckpointer(db, { pollMs: 20, capFactor: 4 }));
    const reader = createDb(file);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM t").get();
    insertPages(db, 40); // past the cap of 4 x 8 pages, pinned
    await waitFor(() => pragma(db, "wal_autocheckpoint") === 8);
    await sleep(60); // a poll has seen the long WAL
    reader.exec("COMMIT");
    reader.close();
    insertPages(db, 10); // the main connection checkpoints inside this commit
    expect(pendingPages(db)).toBe(0);
    insertPages(db, 10); // reuses the WAL from its start and leaves it at the threshold or over: never a short WAL
    const log = () => (db.pragma("wal_checkpoint(NOOP)") as Array<{ log: number }>)[0]!.log;
    expect(log()).toBeGreaterThanOrEqual(8);
    expect(log()).toBeLessThan(32);
    await waitFor(() => pragma(db, "wal_autocheckpoint") === 0);
    expect(log()).toBeGreaterThanOrEqual(8);
  });

  it("stop() gives the main connection its own threshold back and is safe to repeat", async () => {
    const { db } = fileDb(64);
    const checkpointer = await startWalCheckpointer(db, { pollMs: 20 });
    await checkpointer!.stop();
    await checkpointer!.stop();
    expect(checkpointer!.active).toBe(false);
    expect(pragma(db, "wal_autocheckpoint")).toBe(64);
    insertPages(db, 80);
    expect(pendingPages(db)).toBe(0); // checkpointed inside the commit again
  });

  it("ends the worker when the connection is closed without stop()", async () => {
    const { db } = fileDb();
    const checkpointer = await startWalCheckpointer(db, { pollMs: 20 });
    db.close();
    await waitFor(() => checkpointer!.active === false);
    await checkpointer!.stop();
  });

  it("a worker that dies after it started gives the automatic checkpoint back, with one warning", async () => {
    const { db } = fileDb(64);
    const warn = vi.fn();
    let worker: Worker | undefined;
    const checkpointer = track(await startWalCheckpointer(db, {
      pollMs: 20, warn, spawn: (source, options) => (worker = new Worker(source, options)),
    }));
    expect(pragma(db, "wal_autocheckpoint")).toBe(0);
    await worker!.terminate();
    await waitFor(() => checkpointer!.active === false);
    expect(pragma(db, "wal_autocheckpoint")).toBe(64);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/exited/);
    insertPages(db, 80);
    expect(pendingPages(db)).toBe(0); // the main connection checkpoints inside the commit again
  });

  it("a failed checkpoint ends the worker and gives the automatic checkpoint back, with one warning", async () => {
    const { db } = fileDb(64);
    const warn = vi.fn();
    // Stands in for the worker: starts, then reports two failed checkpoints.
    const failing = new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", (message) => { if (message === "stop") { parentPort.postMessage({ type: "stopped" }); parentPort.close(); } });
      parentPort.postMessage({ type: "ready" });
      setTimeout(() => {
        parentPort.postMessage({ type: "checkpoint-error", message: "disk I/O error" });
        parentPort.postMessage({ type: "checkpoint-error", message: "disk I/O error" });
      }, 50);
    `)}`);
    let stoppedByParent = false;
    const checkpointer = track(await startWalCheckpointer(db, { warn, spawn: (_source, options) => {
      const worker = new Worker(failing, options);
      worker.on("message", (message: { type: string }) => { if (message.type === "stopped") stoppedByParent = true; });
      return worker;
    } }));
    expect(checkpointer?.active).toBe(true);
    await waitFor(() => checkpointer!.active === false);
    await waitFor(() => stoppedByParent); // the worker was told to stop, not left polling
    expect(pragma(db, "wal_autocheckpoint")).toBe(64);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/failed a checkpoint \(disk I\/O error\)/);
  });

  it("refuses an SQLite without the NOOP checkpoint, with one warning, and changes nothing", async () => {
    const { db } = fileDb();
    const warn = vi.fn();
    const spawn = (source: URL, options: ConstructorParameters<typeof Worker>[1]) =>
      new Worker(source, { ...options, workerData: { ...options!.workerData, minSqlite: [99, 0, 0] } });
    expect(await startWalCheckpointer(db, { warn, spawn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/has no NOOP checkpoint, added in 99\.0\.0/);
    expect(pragma(db, "wal_autocheckpoint")).toBe(1000);
  });

  it("a worker that can't be created warns once and changes nothing", async () => {
    const { db } = fileDb();
    const warn = vi.fn();
    const spawn = () => { throw new Error("no thread to be had"); };
    expect(await startWalCheckpointer(db, { warn, spawn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/could not start \(no thread to be had\)/);
    expect(pragma(db, "wal_autocheckpoint")).toBe(1000);
  });

  it("a failed start does not wait on a worker thread that won't end", async () => {
    const { db } = fileDb();
    const warn = vi.fn();
    // Stands in for a worker stuck in a synchronous call: reports the failure and stays alive, and its terminate()
    // never resolves.
    const stuck = new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage({ type: "failed", message: "disk stalled" });
      setInterval(() => {}, 1000);
    `)}`);
    const spawn = (_source: URL, options: ConstructorParameters<typeof Worker>[1]) => {
      const worker = new Worker(stuck, options);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => new Promise<number>(() => {});
      cleanups.push(async () => { await terminate(); });
      return worker;
    };
    const began = Date.now();
    expect(await startWalCheckpointer(db, { warn, spawn })).toBeNull();
    expect(Date.now() - began).toBeLessThan(4000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/could not start \(disk stalled\)/);
    expect(pragma(db, "wal_autocheckpoint")).toBe(1000);
  });

  it("a worker that can't open the file warns once and changes nothing", async () => {
    const { db, file } = fileDb();
    fs.renameSync(file, `${file}.moved`); // the main handle stays open; the worker's fileMustExist open fails
    const warn = vi.fn();
    expect(await startWalCheckpointer(db, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/could not start/);
    expect(pragma(db, "wal_autocheckpoint")).toBe(1000);
    fs.renameSync(`${file}.moved`, file);
  });
});
