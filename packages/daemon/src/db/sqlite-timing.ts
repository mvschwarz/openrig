import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { SLOW_OPERATION_THRESHOLD_MS } from "../domain/slow-op-recorder.js";
import { recordSlowSyncSite } from "../domain/sync-site-wrap.js";

/**
 * SQLite timing spans in the slow-operations log (#3895, third ask). Every statement run, exec, pragma and transaction
 * on the connection is timed. One that took at least SLOW_OPERATION_THRESHOLD_MS (250 ms) is recorded as a span named
 * `sqlite.<call>.<operation>`, for example `sqlite.run.insert`, `sqlite.pragma.journal_mode` or `sqlite.transaction`.
 * The operation is the statement's first keyword or the PRAGMA's name, and only from a fixed list (otherwise `other`),
 * so a span never carries SQL text, values or a caller-chosen name such as a schema alias.
 *
 * A slow span also notes whether the main database file changed while it ran: the site gets `.main_file_changed` when
 * the file's last write came more than 10 ms after the span started (one stat, made only after a call was already
 * slow, so a write just before the call never counts). It is an observation, not a cause: any connection or process
 * may have written the file. In WAL mode only a checkpoint writes the main file, so a slow call with the suffix ran
 * while a checkpoint was writing. No suffix means no such write was seen: one in the first 10 ms, or a failed stat,
 * also leaves none.
 *
 * Fast calls cost three clock reads (performance.now() twice, Date.now() once) and one wrapper call. With no recorder
 * configured nothing is recorded.
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
      if (durationMs >= SLOW_OPERATION_THRESHOLD_MS) recordSlowSyncSite(site + (mainFileChangedSince(file, startedWall) ? ".main_file_changed" : ""), durationMs, outcome);
    }
  };

  // Each wrapper looks the driver's method up on the prototype when it is called, never binding it in advance, so a
  // spy or patch on the Statement or Database prototype still sees every call, including those of a statement that
  // was prepared and cached before the spy (as the #3645 statement-count test does). A method the object already had
  // as its own when it was wrapped is kept and called instead.
  type Methods = Record<string, (...args: unknown[]) => unknown>;
  const driver = (target: object, name: string): (() => (...args: unknown[]) => unknown) => {
    const own = Object.hasOwn(target, name) ? (target as Methods)[name] : undefined;
    return () => own ?? (Object.getPrototypeOf(target) as Methods)[name]!;
  };
  const native = {
    prepare: driver(db, "prepare"), exec: driver(db, "exec"), pragma: driver(db, "pragma"), transaction: driver(db, "transaction"),
  };

  db.prepare = ((source: string) => {
    const statement = native.prepare().call(db, source) as object;
    const verb = firstKeyword(source);
    const methods = statement as Methods;
    const step = { run: driver(statement, "run"), get: driver(statement, "get"), all: driver(statement, "all"), iterate: driver(statement, "iterate") };
    for (const method of ["run", "get", "all"] as const) {
      methods[method] = (...args: unknown[]) => timed(`sqlite.${method}.${verb}`, () => step[method]().apply(statement, args));
    }
    // iterate() is lazy: making the iterator, each next() and return() (which ends the statement on an early break)
    // are each timed.
    methods.iterate = (...args: unknown[]) => {
      const site = `sqlite.iterate.${verb}`;
      const rows = timed(site, () => step.iterate().apply(statement, args)) as IterableIterator<unknown>;
      const timedRows: IterableIterator<unknown> = {
        next: (...step: [] | [unknown]) => timed(site, () => rows.next(...step)),
        return: (value?: unknown) => timed(site, () => rows.return ? rows.return(value) : { done: true, value }),
        [Symbol.iterator]() { return timedRows; },
      };
      return timedRows;
    };
    return statement;
  }) as typeof db.prepare;

  db.exec = ((source: string) => timed(`sqlite.exec.${firstKeyword(source)}`, () => native.exec().call(db, source))) as typeof db.exec;

  db.pragma = ((source: string, options?: Database.PragmaOptions) =>
    timed(`sqlite.pragma.${pragmaName(source)}`, () => native.pragma().call(db, source, options))) as typeof db.pragma;

  // The driver returns four functions (default, deferred, immediate, exclusive) that each carry all four plus
  // `database`. Each is wrapped by an ordinary function, so the caller's `this` reaches the callback, and the wrappers
  // get the same properties, so the shape is the driver's.
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const modes = native.transaction().call(db, fn) as unknown as Record<"default" | "deferred" | "immediate" | "exclusive", (...args: unknown[]) => unknown>;
    const wrap = (variant: (...args: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]) { return timed("sqlite.transaction", () => variant.apply(this, args)); };
    const wrapped = { default: wrap(modes.default), deferred: wrap(modes.deferred), immediate: wrap(modes.immediate), exclusive: wrap(modes.exclusive) };
    const properties = {
      default: { value: wrapped.default }, deferred: { value: wrapped.deferred },
      immediate: { value: wrapped.immediate }, exclusive: { value: wrapped.exclusive },
      database: { value: db, enumerable: true },
    };
    for (const f of Object.values(wrapped)) Object.defineProperties(f, properties);
    return wrapped.default;
  }) as unknown as typeof db.transaction;

  return db;
}

const SQL_VERBS = new Set(["select", "insert", "update", "delete", "replace", "with", "values", "create", "drop",
  "alter", "begin", "commit", "end", "rollback", "savepoint", "release", "pragma", "vacuum", "analyze", "reindex",
  "attach", "detach", "explain"]);
const PRAGMA_NAMES = new Set(["analysis_limit", "application_id", "auto_vacuum", "automatic_index", "busy_timeout",
  "cache_size", "cache_spill", "case_sensitive_like", "cell_size_check", "checkpoint_fullfsync", "collation_list",
  "compile_options", "data_version", "database_list", "defer_foreign_keys", "encoding", "foreign_key_check",
  "foreign_key_list", "foreign_keys", "freelist_count", "fullfsync", "function_list", "hard_heap_limit",
  "ignore_check_constraints", "incremental_vacuum", "index_info", "index_list", "index_xinfo", "integrity_check",
  "journal_mode", "journal_size_limit", "legacy_alter_table", "locking_mode", "max_page_count", "mmap_size",
  "module_list", "optimize", "page_count", "page_size", "pragma_list", "query_only", "quick_check",
  "read_uncommitted", "recursive_triggers", "reverse_unordered_selects", "schema_version", "secure_delete",
  "shrink_memory", "soft_heap_limit", "synchronous", "table_info", "table_list", "table_xinfo", "temp_store",
  "threads", "trusted_schema", "user_version", "wal_autocheckpoint", "wal_checkpoint"]);

/** Leading whitespace and comments; a block comment ends at its first `*\/`, as in SQLite, so each comment matches
 *  one way and the scan stays linear. */
const LEAD = String.raw`^(?:\s|--[^\n]*\n|\/\*(?:[^*]|\*+[^*\/])*\*+\/)*`;
const FIRST_WORD = new RegExp(LEAD + String.raw`([A-Za-z_]{1,24})`);
const PRAGMA_WORD = new RegExp(LEAD + String.raw`(?:[A-Za-z_][A-Za-z0-9_]{0,63}\s*\.\s*)?([A-Za-z_]{1,32})`);

/** The statement's first keyword, lower case, when it is a known SQL verb; otherwise `other`. */
export function firstKeyword(source: string): string {
  const word = FIRST_WORD.exec(source)?.[1]?.toLowerCase();
  return word && SQL_VERBS.has(word) ? word : "other";
}

/** The PRAGMA's name (after an optional `schema.`, which is never kept), when it is a known PRAGMA; otherwise `other`. */
export function pragmaName(source: string): string {
  const word = PRAGMA_WORD.exec(source)?.[1]?.toLowerCase();
  return word && PRAGMA_NAMES.has(word) ? word : "other";
}

/** True when the main database file was last written more than 10 ms after the span started (by anyone). */
function mainFileChangedSince(file: string | null, startedWall: number): boolean {
  if (!file) return false;
  try { return statSync(file).mtimeMs > startedWall + 10; } catch { return false; }
}
