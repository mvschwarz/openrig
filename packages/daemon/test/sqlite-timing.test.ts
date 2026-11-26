import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createDb } from "../src/db/connection.js";
import { firstKeyword } from "../src/db/sqlite-timing.js";
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

  it("marks a slow call that wrote the main database file (a checkpoint) with .db_written", async () => {
    const d = db(true);
    d.prepare("INSERT INTO t (v) VALUES (?)").run("x");
    d.pragma("wal_checkpoint(TRUNCATE)");
    await new Promise((r) => setTimeout(r, 50));   // the main file's last write is now well before the next span
    record();
    // A slow write that only appends to the WAL: the main file is not written.
    d.prepare("INSERT INTO t (v) SELECT 'a' || hold_ms(260)").run();
    // A slow call that checkpoints: the WAL's pages are copied into the main file while it runs.
    d.exec("SELECT hold_ms(260); PRAGMA wal_checkpoint(TRUNCATE)");
    expect(spans.map((s) => s.site)).toEqual(["sqlite.run.insert", "sqlite.exec.select.db_written"]);
    d.close();
  });

  it("does not mark a slow read with .db_written for a checkpoint just before it", () => {
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

  it("does nothing without a recorder", () => {
    const d = db();
    expect(d.prepare("SELECT hold_ms(260) AS h").get()).toEqual({ h: 260 });
    d.close();
  });

  it("takes only the first keyword", () => {
    expect(firstKeyword("  insert into t values (1)")).toBe("insert");
    expect(firstKeyword("-- c\n/* d */\nWITH x AS (SELECT 1) SELECT * FROM x")).toBe("with");
    expect(firstKeyword("journal_mode = WAL")).toBe("journal_mode");
    expect(firstKeyword("wal_checkpoint(TRUNCATE)")).toBe("wal_checkpoint");
    expect(firstKeyword("")).toBe("other");
    expect(firstKeyword("(SELECT 1)")).toBe("other");
    expect(firstKeyword("/* a */ ( /* b */ SELECT 1")).toBe("other");   // a comment ends at its first */
    expect(firstKeyword("/** x **/select 1")).toBe("select");
    expect(firstKeyword("/* a * b */ update t")).toBe("update");
  });

  it("scans comment-heavy SQL in linear time", () => {
    const started = performance.now();
    expect(firstKeyword("/*x*/".repeat(5000) + "(")).toBe("other");
    expect(firstKeyword("/*x*/".repeat(5000) + "select")).toBe("select");
    expect(performance.now() - started).toBeLessThan(100);
  });
});
