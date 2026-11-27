import { Worker, type WorkerOptions } from "node:worker_threads";
import type Database from "better-sqlite3";
import { cooperativeReadFile } from "../domain/execution-candidate-reader.js";

/**
 * Moves SQLite's WAL checkpoints off the daemon's event loop (#3895).
 *
 * The daemon's one connection (db/connection.ts) is synchronous better-sqlite3 on the main thread. In WAL mode a
 * commit only appends to the WAL, but every `wal_autocheckpoint` pages (1000 by default) the committing connection
 * also runs a checkpoint: it fsyncs the WAL, copies the pages into the database file and fsyncs that file, all inside
 * the commit, on that thread. When another process saturates the disk those fsyncs take seconds, and every request
 * waits behind them, reads included.
 *
 * Here a worker thread with its own connection to the same file takes the checkpoints, and the main connection's
 * automatic checkpoint is turned off. The worker looks at the WAL's size once a second (a NOOP checkpoint, which
 * does no work) and, once the WAL holds as many pages as the automatic checkpoint's threshold, runs the same PASSIVE
 * checkpoint the automatic one would. PASSIVE never waits for a lock a reader or a writer holds, so it cannot make
 * the main connection wait for one.
 *
 * The cap. SQLite reuses the WAL from its start only when a write begins while every frame has been copied. The
 * automatic checkpoint runs inside the writer's own commit, so that is always the case for the next write. A
 * checkpoint on another thread can be overlapped by commits, which leaves frames uncopied; while every checkpoint is
 * overlapped (a fast writer, or slow fsyncs under disk load) the WAL is never reused and the file grows. So when the
 * WAL reaches WAL_CAP_FACTOR times the threshold, the worker stands back and the main connection gets its automatic
 * checkpoint back until the WAL has been reused: one checkpoint on the main thread, as before this change. A WAL of
 * the cap's size or more after its reuse (a single transaction that large) stays with the main connection.
 *
 * The `synchronous` mode is left as it is, and a checkpoint syncs the same files in the same order whichever
 * connection runs it. What changes is when pages are checkpointed: the timer and the cap set that, so checkpoint
 * timing differs from the automatic checkpoint's. With `synchronous = NORMAL` a power loss can already roll back
 * recent commits; whether the new timing changes that exposure has not been measured.
 *
 * Not covered:
 * - The WAL append is still a synchronous write on the main thread. It goes to the page cache; a kernel that
 *   throttles buffered writes can still make it wait.
 * - After a completed checkpoint the next commit restarts the WAL and syncs its new header on the main thread: one
 *   fsync of the WAL per checkpoint cycle, as before this change. The other syncs of each cycle are the ones that
 *   moved.
 * - While the WAL is over the cap, the main thread runs a checkpoint again (see above).
 * - Moving every statement off the thread would mean making the daemon's data layer asynchronous. Not attempted.
 *
 * If the worker can't start or dies, the main connection gets its automatic checkpoint back (the behaviour before
 * this change) and one warning is printed.
 */

/** How often the worker looks at the WAL's size. */
export const CHECKPOINT_POLL_MS = 1000;
/** The WAL size, in multiples of the checkpoint threshold, at which the main connection checkpoints for itself again
 *  until the WAL has been reused. With the defaults: 4000 pages, about 16 MB. */
export const WAL_CAP_FACTOR = 4;
/** `PRAGMA wal_checkpoint(NOOP)`, the size check that does no work, was added in SQLite 3.51.0. An older SQLite
 *  reads the unknown word as PASSIVE and would checkpoint on every poll, so the worker refuses to run on one. */
const NOOP_CHECKPOINT_MIN_SQLITE = [3, 51, 0];
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
/** How long a start that failed waits for the worker thread to end before startup goes on without it. */
const START_FAILED_EXIT_WAIT_MS = 1_000;

const SOURCE = new URL(`data:text/javascript,${encodeURIComponent(`
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
let db;
try {
  const Database = createRequire(workerData.requireFrom)("better-sqlite3");
  db = new Database(workerData.file, { fileMustExist: true });
  if (db.pragma("journal_mode", { simple: true }) !== "wal") throw new Error("database is not in WAL mode");
  const version = db.prepare("SELECT sqlite_version() AS v").get().v;
  const have = version.split(".").map(Number);
  const need = workerData.minSqlite;
  for (let i = 0; i < need.length; i += 1) {
    if ((have[i] || 0) > need[i]) break;
    if ((have[i] || 0) < need[i]) throw new Error("SQLite " + version + " has no NOOP checkpoint, added in " + need.join("."));
  }
} catch (error) {
  parentPort.postMessage({ type: "failed", message: String(error && error.message || error) });
  process.exit(1);
}
// Checkpointing whenever there is anything to copy would make the main connection restart the WAL, and sync its
// new header, about once a poll. So wait until the WAL is as large as the automatic checkpoint lets it get (its
// rule: frames in the WAL, not frames pending), then checkpoint on every poll until the WAL has been reused.
// The WAL has been reused when it is short again, or shorter than at the last poll: its frame count only falls when
// a write restarts it. The second sign is for a writer whose every transaction is as large as the threshold, which
// never leaves a short WAL for a poll to see.
let overCap = false;
let lastLog = 0;
const poll = () => {
  try {
    const [wal] = db.pragma("wal_checkpoint(NOOP)");
    // A poll that meets a writer in the middle of changing the WAL's header is told "busy" and given -1 for both
    // counts, without an error. That is no reading: taking -1 for a short WAL would end the cap while the WAL is
    // still long.
    if (wal.busy || wal.log < 0) return;
    const restarted = wal.log < lastLog;
    lastLog = wal.log;
    if (overCap ? wal.log < workerData.thresholdPages || (restarted && wal.log < workerData.capPages) : wal.log >= workerData.capPages) {
      overCap = !overCap;
      parentPort.postMessage({ type: overCap ? "over-cap" : "under-cap" });
    }
    // Over the cap the main connection checkpoints inside its own commits; a checkpoint here could only collide.
    if (!overCap && wal.log >= workerData.thresholdPages && wal.log > wal.checkpointed) db.pragma("wal_checkpoint(PASSIVE)");
  } catch (error) {
    parentPort.postMessage({ type: "checkpoint-error", message: String(error && error.message || error) });
  }
};
const timer = setInterval(poll, workerData.pollMs);
parentPort.on("message", (message) => {
  if (message !== "stop") return;
  clearInterval(timer);
  try { db.close(); } catch {}
  parentPort.postMessage({ type: "stopped" });
  parentPort.close();
});
parentPort.postMessage({ type: "ready" });
`)}`);

export interface WalCheckpointer {
  /** True while the worker owns checkpointing. */
  readonly active: boolean;
  /** Ends the worker and gives the main connection its automatic checkpoint back. Safe to call more than once. */
  stop(): Promise<void>;
}

export interface WalCheckpointerOptions {
  pollMs?: number;
  warn?: (message: string) => void;
  /** The cap in multiples of the threshold; WAL_CAP_FACTOR by default. */
  capFactor?: number;
  /** How long stop() waits for the worker to close its connection; tests shorten it. */
  stopTimeoutMs?: number;
  /** Starts the worker thread; tests replace it to reach the worker or to stand in for it. */
  spawn?: (source: URL, options: WorkerOptions) => Worker;
}

/**
 * Starts the checkpoint worker for a file database in WAL mode and, once it has opened the file, turns off the main
 * connection's automatic checkpoint. Returns null, with nothing changed, for a memory database, one not in WAL mode,
 * one whose automatic checkpoint is already off, and when the worker fails to start (after one warning).
 */
export async function startWalCheckpointer(db: Database.Database, opts: WalCheckpointerOptions = {}): Promise<WalCheckpointer | null> {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  // The same test the cooperative reader uses for "a second connection to this file is safe": a file database in WAL mode.
  const file = cooperativeReadFile(db);
  if (!file) return null;
  const thresholdPages = db.pragma("wal_autocheckpoint", { simple: true }) as number;
  if (!(thresholdPages > 0)) return null;
  const pollMs = opts.pollMs ?? CHECKPOINT_POLL_MS;

  let active = false;
  let stopping: Promise<void> | undefined;
  let warned = false;
  let closedWatch: ReturnType<typeof setInterval> | undefined;
  const restore = () => {
    active = false;
    clearInterval(closedWatch);
    if (db.open) db.pragma(`wal_autocheckpoint = ${thresholdPages}`);
  };
  const fallBack = (why: string) => {
    if (active) restore();
    if (!warned) {
      warned = true;
      warn(`Warning: SQLite checkpoint worker ${why}; the daemon checkpoints on its main thread again.`);
    }
  };

  // execArgv: [] as in profile-resolution-worker.ts: the worker needs none of the daemon's loaders or flags.
  // new Worker() can throw where it stands (no thread to be had, for one), before there is a worker to listen to.
  let worker: Worker;
  try {
    worker = (opts.spawn ?? ((source, options) => new Worker(source, options)))(SOURCE, {
      execArgv: [],
      workerData: {
        file, pollMs, thresholdPages, capPages: thresholdPages * (opts.capFactor ?? WAL_CAP_FACTOR),
        minSqlite: NOOP_CHECKPOINT_MIN_SQLITE, requireFrom: import.meta.url,
      },
    });
  } catch (error) {
    fallBack(`could not start (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
  let stopped: () => void = () => {};
  const stoppedPromise = new Promise<void>((resolve) => { stopped = resolve; });

  // Every call gets the one stop, wait included: a second call made after the wait ran out must not wait on a worker
  // thread that is still inside its fsync.
  function stop(): Promise<void> {
    stopping ??= stopOnce();
    return stopping;
  }
  async function stopOnce(): Promise<void> {
    clearInterval(closedWatch);
    worker.postMessage("stop");
    // A checkpoint in flight on a slow disk can outlast the wait. Shutdown goes on without it: the thread ends when
    // its fsync returns, and a checkpoint cut short is as safe as a crash during one (the WAL still holds every frame).
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stoppedPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, opts.stopTimeoutMs ?? STOP_TIMEOUT_MS); })]);
    clearTimeout(timer);
    void worker.terminate().catch(() => undefined);
    if (active) restore();
  }

  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { fallBack("did not start in time"); resolve(false); }, START_TIMEOUT_MS);
    worker.on("message", (message: { type: string; message?: string }) => {
      if (message.type === "ready") { clearTimeout(timer); resolve(true); }
      else if (message.type === "failed") { clearTimeout(timer); fallBack(`could not start (${message.message})`); resolve(false); }
      else if (message.type === "checkpoint-error" && !stopping) { fallBack(`failed a checkpoint (${message.message})`); void stop(); }
      // Over the cap the main connection checkpoints inside its own commits until the WAL has been reused.
      else if (message.type === "over-cap" && active && db.open) db.pragma(`wal_autocheckpoint = ${thresholdPages}`);
      else if (message.type === "under-cap" && active && db.open) db.pragma("wal_autocheckpoint = 0");
      else if (message.type === "stopped") stopped();
    });
    worker.on("error", (error) => { clearTimeout(timer); if (!stopping) fallBack(`stopped with an error (${error.message})`); resolve(false); stopped(); });
    worker.on("exit", () => { clearTimeout(timer); if (!stopping) fallBack("exited"); resolve(false); stopped(); });
  });

  if (!ready || warned) {
    // terminate() resolves when the thread has ended, and a thread inside a synchronous SQLite call (opening the file
    // on a stalled disk) ends only when that call returns. Startup waits a moment for a tidy end and then goes on
    // without it: the worker has not taken the checkpoints over, the main connection's automatic checkpoint was never
    // turned off, and the thread ends at its next return to JavaScript without having polled.
    worker.unref();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      worker.terminate().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, START_FAILED_EXIT_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    return null;
  }
  // Never keeps the process alive on its own. A daemon that exits without stop() loses nothing: frames not yet
  // checkpointed stay in the WAL and the next open reads them.
  worker.unref();
  db.pragma("wal_autocheckpoint = 0");
  active = true;
  // A caller that closes the connection without stop() (a test, a startup that failed later) must not leave the
  // worker polling a file nobody writes.
  closedWatch = setInterval(() => { if (!db.open) void stop(); }, pollMs);
  closedWatch.unref();

  return {
    get active() { return active; },
    stop,
  };
}
