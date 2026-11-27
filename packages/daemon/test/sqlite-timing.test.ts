import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createDb } from "../src/db/connection.js";
import Database from "better-sqlite3";
import { firstKeyword, pragmaName, withSqliteTiming } from "../src/db/sqlite-timing.js";
import { configureSyncSiteRecorder } from "../src/domain/sync-site-wrap.js";

// SQLite timing spans in the slow-operations log (#3895, third ask). A fake recorder takes every record it is offered;
// the spans apply the 250 ms threshold themselves, so only slow calls reach it. A slow call is made with a SQL function
// that holds the thread, so nothing here depends on the disk being slow.
describe("SQLite timing spans", () => {
  const spans: Array<{ site: string; durationMs: number; outcome: string }> = [];
  const dirs: string[] = [];
  const record = () => configureSyncSiteRecorder({
    recordSlowSync(site: string, durationMs: number, outcome: "ok" | "failed"): void { spans.push({ site, durationMs, outcome }); },
  });
  afterEach(() => {
    configureSyncSiteRecorder(undefined);
    spans.length = 0;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function db(file = false) {
    let path: string | undefined;
    if (file) { const dir = mkdtempSync(join(tmpdir(), "sqlite-timing-")); dirs.push(dir); path = join(dir, "t.db"); }
    const d = createDb(path);
    d.function("hold_ms", (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* hold */ } return ms; });
    d.function("hold_then_fail", (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* hold */ } throw new Error("boom"); });
    d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    return d;
  }

  it("records nothing for fast calls", () => {
    const d = db();
    record();
    d.prepare("INSERT INTO t (v) VALUES (?)").run("a");
    d.prepare("SELECT v FROM t").all();
    d.transaction(() => d.prepare("UPDATE t SET v = 'b'").run())();
    d.pragma("user_version");
    expect(spans).toEqual([]);
    d.close();
  });

  it("names a slow statement by its call and first keyword, never by its text or values", () => {
    const d = db();
    record();
    expect(d.prepare("SELECT hold_ms(?) AS held").get(300)).toEqual({ held: 300 });
    d.prepare("INSERT INTO t (v) SELECT 'secret-' || hold_ms(300)").run();
    expect(spans.map((s) => [s.site, s.outcome])).toEqual([["sqlite.get.select", "ok"], ["sqlite.run.insert", "ok"]]);
    expect(spans.every((s) => s.durationMs >= 250)).toBe(true);
    expect(JSON.stringify(spans)).not.toContain("secret");
    d.close();
  });

  it("records a slow failing call as failed and still throws", () => {
    const d = db();
    record();
    expect(() => d.prepare("SELECT hold_then_fail(300)").get()).toThrow("boom");
    expect(spans.map((s) => [s.site, s.outcome])).toEqual([["sqlite.get.select", "failed"]]);
    d.close();
  });

  it("times all, iterate, exec, pragma and transactions (every mode)", () => {
    const d = db();
    record();
    d.prepare("SELECT hold_ms(260)").all();
    expect([...d.prepare("SELECT hold_ms(260) AS h").iterate()]).toEqual([{ h: 260 }]);
    d.exec("  -- a comment\n /* and another */ SELECT hold_ms(260)");
    const tx = d.transaction((ms: number) => d.prepare("SELECT hold_ms(?)").get(ms));
    tx(260);
    tx.immediate(260);
    tx.deferred(260);
    tx.exclusive(260);
    expect(spans.map((s) => s.site)).toEqual([
      "sqlite.all.select", "sqlite.iterate.select", "sqlite.exec.select",
      "sqlite.get.select", "sqlite.transaction", "sqlite.get.select", "sqlite.transaction",
      "sqlite.get.select", "sqlite.transaction", "sqlite.get.select", "sqlite.transaction",
    ]);
    d.close();
  });

  it("times each step of iterate, and an early break still ends the statement", () => {
    const d = db();
    d.prepare("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')").run();
    record();
    const seen: unknown[] = [];
    for (const row of d.prepare("SELECT v, hold_ms(260) FROM t ORDER BY id").iterate()) { seen.push((row as { v: string }).v); if (seen.length === 2) break; }
    expect(seen).toEqual(["a", "b"]);
    expect(spans.map((s) => s.site)).toEqual(["sqlite.iterate.select", "sqlite.iterate.select"]);
    d.prepare("INSERT INTO t (v) VALUES ('d')").run();   // the iterator was ended: the connection is free
    d.close();
  });

  it("keeps a statement's own chaining and results", () => {
    const d = db();
    d.prepare("INSERT INTO t (v) VALUES (?), (?)").run("x", "y");
    record();
    expect(d.prepare("SELECT v FROM t ORDER BY id").pluck().all()).toEqual(["x", "y"]);
    expect(d.prepare("SELECT count(*) FROM t").pluck().get()).toBe(2);
    expect(d.transaction(() => 7)()).toBe(7);
    expect(spans).toEqual([]);
    d.close();
  });

  it("marks a slow call during which the main database file changed (a checkpoint) with .main_file_changed", async () => {
    const d = db(true);
    d.prepare("INSERT INTO t (v) VALUES (?)").run("x");
    d.pragma("wal_checkpoint(TRUNCATE)");
    await new Promise((r) => setTimeout(r, 50));   // the main file's last write is now well before the next span
    record();
    // A slow write that only appends to the WAL: the main file is not written.
    d.prepare("INSERT INTO t (v) SELECT 'a' || hold_ms(260)").run();
    // A slow call that checkpoints: the WAL's pages are copied into the main file while it runs.
    d.exec("SELECT hold_ms(260); PRAGMA wal_checkpoint(TRUNCATE)");
    expect(spans.map((s) => s.site)).toEqual(["sqlite.run.insert", "sqlite.exec.select.main_file_changed"]);
    d.close();
  });

  it("does not mark a slow read with .main_file_changed for a checkpoint just before it", () => {
    const d = db(true);
    d.prepare("INSERT INTO t (v) VALUES (?)").run("x");
    record();
    d.pragma("wal_checkpoint(TRUNCATE)");   // writes the main file now, right before the slow read
    d.prepare("SELECT hold_ms(260)").get();
    expect(spans.map((s) => s.site)).toEqual(["sqlite.get.select"]);
    d.close();
  });

  it("keeps the caller's this in a transaction callback, every mode", () => {
    const d = db();
    record();
    const tx = d.transaction(function (this: { value: number }) { return this.value; });
    expect(tx.call({ value: 7 })).toBe(7);
    expect(tx.immediate.call({ value: 8 })).toBe(8);
    expect(tx.deferred.call({ value: 9 })).toBe(9);
    expect(tx.exclusive.call({ value: 10 })).toBe(10);
    d.close();
  });

  it("keeps the driver's transaction shape: every mode carries every mode, default and database", () => {
    const d = db();
    const tx = d.transaction(() => 1) as unknown as Record<string, unknown> & (() => number);
    const native = new Database(":memory:").transaction(() => 1) as unknown as Record<string, unknown>;
    const modes = ["default", "deferred", "immediate", "exclusive"] as const;
    for (const m of modes) {
      const f = tx[m] as Record<string, unknown> & (() => number);
      expect(f.database).toBe(d);
      expect(f.default).toBe(tx);
      for (const n of modes) expect(f[n]).toBe(tx[n]);
      expect(f()).toBe(1);
    }
    expect(tx.default).toBe(tx);
    expect(Object.keys(tx)).toEqual(Object.keys(native));   // only database is enumerable, as in the driver
    expect((tx.immediate as Record<string, () => number>).deferred()).toBe(1);
    d.close();
  });

  it("lets a spy on the driver's prototypes count every call, including a statement cached before the spy (#3645)", () => {
    const d = db();
    const cached = d.prepare("SELECT count(*) AS n FROM t");
    const cachedInsert = d.prepare("INSERT INTO t (v) VALUES (?)");
    const statement = Object.getPrototypeOf(cached) as Record<"all" | "get" | "run" | "iterate", (...args: unknown[]) => unknown>;
    const connection = Object.getPrototypeOf(d) as Record<"exec" | "pragma" | "transaction" | "prepare", (...args: unknown[]) => unknown>;
    const spies = [
      ...(["all", "get", "run", "iterate"] as const).map((m) => vi.spyOn(statement, m)),
      ...(["exec", "pragma", "transaction", "prepare"] as const).map((m) => vi.spyOn(connection, m)),
    ];
    try {
      cached.get();
      cached.all();
      expect([...cached.iterate()]).toEqual([{ n: 0 }]);
      cachedInsert.run("a");
      cachedInsert.run("b");
      d.prepare("INSERT INTO t (v) VALUES ('c')").run();
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 3, 1, 0, 0, 0, 1]);
      // The driver's own pragma() and transaction() run statements inside, so only the connection's counts are checked.
      d.exec("SELECT 1");
      d.pragma("user_version");
      d.transaction(() => 1)();
      expect(spies.slice(4).map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    d.close();
  });

  it("keeps a method the connection or a statement already had as its own", () => {
    const raw = new Database(":memory:");
    const execs: string[] = [];
    const exec = raw.exec.bind(raw);
    raw.exec = ((source: string) => { execs.push(source); return exec(source); }) as typeof raw.exec;
    const prepare = raw.prepare.bind(raw);
    raw.prepare = ((source: string) => {
      const statement = prepare(source);
      (statement as unknown as { get: () => unknown }).get = () => "own get";
      return statement;
    }) as typeof raw.prepare;
    const d = withSqliteTiming(raw);
    d.exec("CREATE TABLE t (v TEXT)");
    expect(execs).toEqual(["CREATE TABLE t (v TEXT)"]);
    expect(d.prepare("SELECT 1").get()).toBe("own get");
    d.close();
  });

  it("times making the iterator and its return() too, so a slow reset on an early break is a span", () => {
    const d = db();
    const statement = Object.getPrototypeOf(d.prepare("SELECT 1")) as { iterate: (...args: unknown[]) => unknown };
    const hold = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* hold */ } };
    const iterate = vi.spyOn(statement, "iterate").mockImplementation(() => {
      hold(260);
      return { next: () => ({ done: false, value: 1 }), return: () => { hold(260); return { done: true, value: undefined }; } };
    });
    try {
      record();
      for (const _ of d.prepare("SELECT v FROM t").iterate()) break;
      expect(spans.map((s) => s.site)).toEqual(["sqlite.iterate.select", "sqlite.iterate.select"]);
    } finally {
      iterate.mockRestore();
    }
    d.close();
  });

  it("does nothing without a recorder", () => {
    const d = db();
    expect(d.prepare("SELECT hold_ms(260) AS h").get()).toEqual({ h: 260 });
    d.close();
  });

  it("takes only the first keyword", () => {
    expect(firstKeyword("  insert into t values (1)")).toBe("insert");
    expect(firstKeyword("-- c\n/* d */\nWITH x AS (SELECT 1) SELECT * FROM x")).toBe("with");
    expect(firstKeyword("journal_mode = WAL")).toBe("other");   // not a statement verb
    expect(firstKeyword("seat_private_name SELECT")).toBe("other");   // an unknown word is never kept
    expect(firstKeyword("")).toBe("other");
    expect(firstKeyword("(SELECT 1)")).toBe("other");
    expect(firstKeyword("/* a */ ( /* b */ SELECT 1")).toBe("other");   // a comment ends at its first */
    expect(firstKeyword("/** x **/select 1")).toBe("select");
    expect(firstKeyword("/* a * b */ update t")).toBe("update");
  });

  it("names a PRAGMA by its own name, never a schema alias or an unknown word", () => {
    expect(pragmaName("journal_mode = WAL")).toBe("journal_mode");
    expect(pragmaName("wal_checkpoint(TRUNCATE)")).toBe("wal_checkpoint");
    expect(pragmaName("seat_private_schema.wal_checkpoint(FULL)")).toBe("wal_checkpoint");
    expect(pragmaName(" /* c */ main . user_version")).toBe("user_version");
    expect(pragmaName("reverse_unordered_selects = 1")).toBe("reverse_unordered_selects");   // 25 characters, the longest
    expect(pragmaName("seat_private_schema")).toBe("other");
    expect(pragmaName("seat_private_schema.seat_private_value")).toBe("other");
    expect(pragmaName("")).toBe("other");
  });

  it("records a slow PRAGMA on an aliased schema by the PRAGMA's name only", () => {
    const d = db(true);
    const dir = dirs[dirs.length - 1]!;
    const other = join(dir, "other.db");
    const holder = new Database(other);
    holder.pragma("journal_mode = WAL");
    holder.exec("CREATE TABLE x (v TEXT)");
    d.exec(`ATTACH DATABASE '${other}' AS seat_private_schema`);
    holder.exec("BEGIN IMMEDIATE; INSERT INTO x VALUES ('held')");   // a writer, so a FULL checkpoint waits
    d.pragma("busy_timeout = 300");
    record();
    d.pragma("seat_private_schema.wal_checkpoint(FULL)");
    holder.exec("ROLLBACK");
    holder.close();
    expect(spans.map((s) => s.site)).toEqual(["sqlite.pragma.wal_checkpoint"]);
    expect(JSON.stringify(spans)).not.toContain("seat_private");
    d.close();
  });

  it("scans comment-heavy SQL in linear time", () => {
    const started = performance.now();
    expect(firstKeyword("/*x*/".repeat(5000) + "(")).toBe("other");
    expect(firstKeyword("/*x*/".repeat(5000) + "select")).toBe("select");
    expect(pragmaName("/*x*/".repeat(5000) + "(")).toBe("other");
    expect(performance.now() - started).toBeLessThan(100);
  });
});
