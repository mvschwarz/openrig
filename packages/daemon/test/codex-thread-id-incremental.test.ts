import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { CodexThreadIdResolver, clearIncrementalLogReads, incrementalLogReadCounts, type CodexCaptureDiagnostic } from "../src/domain/codex-thread-id.js";

// Codex's own logs schema at 0.153.4 and 0.162.1 (codex-rs/state/logs_migrations, identical in both), with the
// migration ledger its sqlx migrator writes.
const LOGS_SCHEMA = `
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL,
  target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT,
  estimated_bytes INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_thread_id ON logs(thread_id);
CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL;
CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);`;

/** `ps lstart` text for an epoch second, in local time, as the resolver's identity gate reads it. */
function lstart(seconds: number): string {
  const d = new Date(seconds * 1000), pad = (n: number) => String(n).padStart(2, "0");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()], month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${day} ${month} ${String(d.getDate()).padStart(2, " ")} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
}

let home: string;
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-incremental-"))); clearIncrementalLogReads(); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); clearIncrementalLogReads(); });

function logsDb(name = "logs_2.sqlite", migrations: number[] = [1, 2]) {
  const db = new Database(path.join(home, name));
  db.exec(LOGS_SCHEMA);
  for (const version of migrations) db.prepare("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, 'm', 1, x'00', 0)").run(version);
  const log = (ts: number, pid: number, instance: string, thread: string | null) =>
    db.prepare("INSERT INTO logs (ts, ts_nanos, level, target, thread_id, process_uuid) VALUES (?, 0, 'INFO', 't', ?, ?)").run(ts, thread, `pid:${pid}:${instance}`);
  return { db, log, close: () => db.close() };
}
function stateDb(threads: Array<[string, "cli" | "exec"]>) {
  const db = new Database(path.join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
  for (const [id, source] of threads) db.prepare("INSERT OR REPLACE INTO threads (id, source, rollout_path) VALUES (?, ?, ?)").run(id, source, `/rollouts/${id}.jsonl`);
  db.close();
}

const PID = 4242, START = 1_800_000_000, IDENTITY = lstart(START);
const resolver = () => new CodexThreadIdResolver({ codexHome: home });

/** The default read, and the same question asked of the full read (resolveWithReadability never reads incrementally). */
async function compare(pid = PID, identity = IDENTITY) {
  const diagnostics: CodexCaptureDiagnostic[] = [];
  const thread = await resolver().resolve(pid, identity, (d) => diagnostics.push(d));
  const full = await resolver().resolveWithReadability(pid, identity);
  return { incremental: { thread, reason: thread ? undefined : diagnostics[0]?.reason }, full: { thread: full.thread, reason: full.reason } };
}
function counts() { return { ...incrementalLogReadCounts }; }

describe("the incremental Codex-log read", () => {
  it("answers as the full read does through appends, a second retained thread, a deleted thread and retention", async () => {
    const logs = logsDb();
    stateDb([["thread-a", "cli"], ["thread-b", "cli"], ["thread-c", "cli"], ["thread-old", "cli"], ["thread-x", "cli"]]);
    logs.log(START - 50, PID, "retired", "thread-old"); // the pid's earlier occupant, before this one's start second
    logs.log(START, PID, "current", "thread-old");      // inside the start second: excluded by the gate
    logs.log(START + 1, 99, "other", "thread-x");
    logs.log(START + 2, PID, "current", "thread-a");
    logs.log(START + 3, PID, "current", null);

    const before = counts();
    let step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-a");
    expect(counts().cold).toBe(before.cold + 1);

    // Appends: more rows for the same thread, and other processes' rows.
    for (let i = 0; i < 20; i++) { logs.log(START + 10 + i, PID, "current", "thread-a"); logs.log(START + 10 + i, 99, "other", "thread-x"); }
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-a");
    expect(counts().warm).toBe(before.warm + 1);

    // A second retained CLI conversation in the same process reads ambiguous, as before.
    logs.log(START + 40, PID, "current", "thread-b");
    logs.log(START + 41, PID, "current", "thread-a");
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental).toEqual({ thread: undefined, reason: "ambiguous_threads" });

    // Codex deletes a thread's rows when the thread is deleted; the warm read's re-check drops it.
    logs.db.prepare("DELETE FROM logs WHERE thread_id = ?").run("thread-b");
    logs.log(START + 100, 99, "other", "thread-x");
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-a");

    // Retention removes every row older than its cutoff, which is days behind the last read's newest row: thread-a's
    // rows go, a newer thread-c's stay.
    logs.log(START + 101, PID, "current", "thread-c");
    logs.db.prepare("DELETE FROM logs WHERE ts < ?").run(START + 100);
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-c");
    expect(counts().warm).toBe(before.warm + 4);
    expect(counts().cold).toBe(before.cold + 1);

    // When the row the last read ended on is gone, the next read is cold.
    logs.log(START + 102, PID, "current", "thread-a");
    expect((await compare()).incremental).toEqual({ thread: undefined, reason: "ambiguous_threads" });
    logs.db.prepare("DELETE FROM logs WHERE id = (SELECT max(id) FROM logs)").run();
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-c");
    expect(counts().cold).toBe(before.cold + 2);
    logs.close();
  });

  it("reads the state table fresh on every call, warm or cold", async () => {
    const logs = logsDb();
    stateDb([["thread-a", "exec"]]);
    logs.log(START + 1, PID, "current", "thread-a");
    let step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental).toEqual({ thread: undefined, reason: "no_cli_thread" });
    stateDb([["thread-a", "cli"]]);
    const before = counts();
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-a");
    expect(counts().warm).toBe(before.warm + 1);
    logs.close();
  });

  it("reads cold, and answers as the full read does, after the database is replaced or reset", async () => {
    let logs = logsDb();
    stateDb([["thread-a", "cli"], ["thread-n", "cli"], ["thread-r", "cli"]]);
    for (let i = 0; i < 5; i++) logs.log(START + 1 + i, PID, "current", "thread-a");
    expect((await compare()).incremental.thread).toBe("thread-a");
    logs.close();

    // A new file at the same path: its ids start again from 1.
    fs.rmSync(path.join(home, "logs_2.sqlite"));
    logs = logsDb();
    logs.log(START + 1, PID, "current", "thread-n");
    let before = counts();
    let step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-n");
    expect(counts().cold).toBe(before.cold + 1);

    // Emptied in place with its id sequence reset, then refilled past the old high-water id: the row there is new.
    expect((await compare()).incremental.thread).toBe("thread-n");
    logs.db.exec("DELETE FROM logs; DELETE FROM sqlite_sequence;");
    for (let i = 0; i < 8; i++) logs.log(START + 1 + i, PID, "current", "thread-r");
    before = counts();
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-r");
    expect(counts().cold).toBe(before.cold + 1);
    logs.close();
  });

  it("keeps a reused pid apart from its earlier occupant", async () => {
    const logs = logsDb();
    stateDb([["thread-a", "cli"], ["thread-n", "cli"]]);
    logs.log(START + 1, PID, "first", "thread-a");
    expect((await compare()).incremental.thread).toBe("thread-a");
    // The pid is reused by a process that started later: the earlier occupant's rows predate its start second.
    const reused = lstart(START + 600);
    let step = await compare(PID, reused);
    expect(step.incremental).toEqual(step.full); expect(step.incremental).toEqual({ thread: undefined, reason: "no_log_row" });
    logs.log(START + 601, PID, "second", "thread-n");
    step = await compare(PID, reused);
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-n");
    // The earlier identity's answer is its own.
    step = await compare();
    expect(step.incremental).toEqual(step.full);
    logs.close();
  });

  it("reads each of several databases on its own terms: a verified one incrementally, any other in full", async () => {
    const verified = logsDb("logs_2.sqlite"), older = logsDb("logs_1.sqlite", []);
    stateDb([["thread-a", "cli"], ["thread-b", "cli"]]);
    verified.log(START + 1, PID, "current", "thread-a");
    let step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-a");
    const before = counts();
    older.log(START + 2, PID, "current", "thread-b");
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental).toEqual({ thread: undefined, reason: "ambiguous_threads" });
    expect(counts().warm).toBe(before.warm + 1);
    expect(counts().full).toBe(before.full + 1);
    verified.close(); older.close();
  });

  it("reads a database with any other migration set in full every time", async () => {
    const logs = logsDb("logs_2.sqlite", [1, 2, 3]);
    stateDb([["thread-a", "cli"]]);
    logs.log(START + 1, PID, "current", "thread-a");
    const before = counts();
    for (let i = 0; i < 3; i++) { const step = await compare(); expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-a"); }
    expect(counts()).toEqual({ ...before, full: before.full + 3 });
    logs.close();
  });

  it("never remembers a read that fails, and keeps today's unreadable diagnosis", async () => {
    // A verified ledger over a table the incremental read can't use: it falls back to the full read, which works.
    const db = new Database(path.join(home, "logs_2.sqlite"));
    db.exec("CREATE TABLE logs (ts INTEGER, process_uuid TEXT, thread_id TEXT); CREATE TABLE _sqlx_migrations (version BIGINT, success BOOLEAN)");
    db.exec("INSERT INTO _sqlx_migrations VALUES (1, 1), (2, 1)");
    db.prepare("INSERT INTO logs VALUES (?, ?, ?)").run(START + 1, `pid:${PID}:current`, "thread-a");
    db.close();
    stateDb([["thread-a", "cli"]]);
    const before = counts();
    let step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-a");
    step = await compare();
    expect(counts()).toEqual({ ...before, full: before.full + 2 });
    // An unreadable database is still reported unreadable.
    fs.writeFileSync(path.join(home, "logs_2.sqlite"), "not a database");
    step = await compare();
    expect(step.incremental).toEqual(step.full); expect(step.incremental).toEqual({ thread: undefined, reason: "sqlite_unreadable" });
  });

  it("leaves the readability and fork-child reads on the full query", async () => {
    const logs = logsDb();
    stateDb([["thread-a", "cli"]]);
    logs.log(START + 1, PID, "current", "thread-a");
    const before = counts();
    expect((await resolver().resolveWithReadability(PID, IDENTITY)).thread).toBe("thread-a");
    expect(await resolver().resolveForkChild(PID, IDENTITY)).toBe("thread-a");
    expect(counts()).toEqual(before);
    logs.close();
  });

  it("doesn't remember a read whose file was replaced between taking its identity and opening it", async () => {
    // The original and its replacement end on the same row (id 2, thread-a); only the replacement has an older
    // qualifying thread (id 1, thread-z), so a replacement read under the original's earlier answer would miss it.
    stateDb([["thread-a", "cli"], ["thread-x", "cli"], ["thread-z", "cli"]]);
    let logs = logsDb();
    logs.log(START + 1, 99, "other", "thread-x");
    logs.log(START + 2, PID, "current", "thread-a");
    logs.close();
    const replacement = path.join(home, "replacement.sqlite");
    fs.renameSync(path.join(home, "logs_2.sqlite"), path.join(home, "original.sqlite"));
    logs = logsDb();
    logs.log(START + 1, PID, "current", "thread-z");
    logs.log(START + 2, PID, "current", "thread-a");
    logs.close();
    fs.renameSync(path.join(home, "logs_2.sqlite"), replacement);
    fs.renameSync(path.join(home, "original.sqlite"), path.join(home, "logs_2.sqlite"));
    const logsPath = path.join(home, "logs_2.sqlite"), statSync = fs.statSync;
    let swapped = false;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
      const result = statSync(file, options);
      if (!swapped && String(file) === logsPath) { swapped = true; fs.renameSync(replacement, logsPath); }
      return result;
    }) as typeof fs.statSync);
    const before = counts();
    let step = await compare();
    expect(swapped).toBe(true);
    expect(step.incremental).toEqual(step.full); expect(step.incremental).toEqual({ thread: undefined, reason: "ambiguous_threads" });
    expect(counts()).toEqual({ ...before, full: before.full + 1 });
    // Nothing was remembered under either identity: the next read is cold, and still the full read's answer.
    step = await compare();
    expect(step.incremental).toEqual(step.full);
    expect(counts().cold).toBe(before.cold + 1);
  });

  it("returns a read with more threads than it may remember whole, and doesn't remember it", async () => {
    const logs = logsDb();
    stateDb([["thread-0", "cli"], ...Array.from({ length: 64 }, (_, i) => [`thread-${i + 1}`, "exec"] as [string, "exec"])]);
    for (let i = 0; i <= 64; i++) logs.log(START + 1 + i, PID, "current", `thread-${i}`);
    const before = counts();
    for (let call = 0; call < 2; call++) {
      const step = await compare();
      expect(step.incremental).toEqual(step.full); expect(step.incremental.thread).toBe("thread-0");
    }
    expect(counts()).toEqual({ ...before, cold: before.cold + 2 });
    logs.close();
  });

  it("bounds what it remembers, oldest first", async () => {
    const logs = logsDb();
    stateDb([["thread-a", "cli"]]);
    logs.log(START + 1, PID, "current", "thread-a");
    await compare();
    for (let pid = 10_000; pid < 10_000 + 512; pid++) await resolver().resolve(pid, IDENTITY);
    const before = counts();
    expect((await compare()).incremental.thread).toBe("thread-a");
    expect(counts().cold).toBe(before.cold + 1);
    logs.close();
  });
});
