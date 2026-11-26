import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { SLOW_OPERATION_THRESHOLD_MS } from "../domain/slow-op-recorder.js";
import { recordSlowSyncSite } from "../domain/sync-site-wrap.js";

/**
 * SQLite timing spans in the slow-operations log (#3895, third ask). Every statement run, exec, pragma and transaction
 * on the connection is timed; one that took at least the slow threshold (SLOW_OPERATION_THRESHOLD_MS, 250 ms) is recorded as a span named
 * `sqlite.<call>.<first SQL keyword>`, for example `sqlite.run.insert` or `sqlite.transaction`. The SQL text and its
 * values are never recorded.
 *
 * A slow span also says whether the main database file was written while it ran: the site gets `.db_written`. In WAL
 * mode only a checkpoint writes the main file, so `sqlite.run.insert.db_written` is a commit that ran the automatic
 * checkpoint (its fsyncs), and `sqlite.run.insert` alone is a stall in the WAL append itself. Those are the two causes
 * measured in #3895. The check is one stat of the file, made only after a call was already slow.
 *
 * Fast calls cost two performance.now() reads and nothing else. With no recorder configured nothing is recorded.
 */
export function withSqliteTiming(db: Database.Database): Database.Database {
  const file = db.memory ? null : db.name;
  const timed = <T>(site: string, fn: () => T): T => {
    const startedAt = performance.now();
    const startedWall = Date.now();
    let outcome: "ok" | "failed" = "failed";
    try {
      const value = fn();
      outcome = "ok";
      return value;
    } finally {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= SLOW_OPERATION_THRESHOLD_MS) recordSlowSyncSite(site + (mainFileWrittenSince(file, startedWall) ? ".db_written" : ""), durationMs, outcome);
    }
  };

  const prepare = db.prepare.bind(db);
  db.prepare = ((source: string) => {
    const statement = prepare(source);
    const verb = firstKeyword(source);
    const methods = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["run", "get", "all"] as const) {
      const original = methods[method]!.bind(statement);
      methods[method] = (...args: unknown[]) => timed(`sqlite.${method}.${verb}`, () => original(...args));
    }
    // iterate() is lazy: the work is in each step, so each next() is timed (return() still finalizes on an early break).
    const iterate = methods.iterate!.bind(statement);
    methods.iterate = (...args: unknown[]) => {
      const rows = iterate(...args) as IterableIterator<unknown>;
      const site = `sqlite.iterate.${verb}`;
      const timedRows: IterableIterator<unknown> = {
        next: (...step: [] | [unknown]) => timed(site, () => rows.next(...step)),
        return: (value?: unknown) => rows.return ? rows.return(value) : { done: true, value },
        [Symbol.iterator]() { return timedRows; },
      };
      return timedRows;
    };
    return statement;
  }) as typeof db.prepare;

  const exec = db.exec.bind(db);
  db.exec = ((source: string) => timed(`sqlite.exec.${firstKeyword(source)}`, () => exec(source))) as typeof db.exec;

  const pragma = db.pragma.bind(db);
  db.pragma = ((source: string, options?: Database.PragmaOptions) =>
    timed(`sqlite.pragma.${firstKeyword(source)}`, () => pragma(source, options))) as typeof db.pragma;

  const transaction = db.transaction.bind(db);
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const inner = transaction(fn) as unknown as Record<string, (...args: unknown[]) => unknown> & ((...args: unknown[]) => unknown);
    const outer = ((...args: unknown[]) => timed("sqlite.transaction", () => inner(...args))) as typeof inner;
    for (const mode of ["deferred", "immediate", "exclusive"] as const) {
      const variant = inner[mode]!;
      (outer as Record<string, unknown>)[mode] = (...args: unknown[]) => timed("sqlite.transaction", () => variant(...args));
    }
    (outer as Record<string, unknown>).default = outer;
    return outer;
  }) as unknown as typeof db.transaction;

  return db;
}

/** The SQL's first keyword, lower case, letters and underscores only (never the statement text or a value). */
export function firstKeyword(source: string): string {
  const match = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([A-Za-z_]{1,24})/.exec(source);
  return match ? match[1]!.toLowerCase() : "other";
}

/** True when the main database file's mtime is at or after the span's start (10 ms allowed for a coarse clock). */
function mainFileWrittenSince(file: string | null, startedWall: number): boolean {
  if (!file) return false;
  try { return statSync(file).mtimeMs >= startedWall - 10; } catch { return false; }
}
