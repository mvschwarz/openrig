import Database from "better-sqlite3";

/** Rowids one statement may cover before the read yields to the event loop. Soft: one large row's conversion, native
 *  I/O or a correlated subquery on a matching row can still make a window take longer. */
const WINDOW_ROWS = 256;
/** A window that runs longer than this halves the next one (down to one rowid); a quicker one doubles it back toward
 *  WINDOW_ROWS. Rows with large bodies or matching filters cost far more than small ones, so a fixed row count alone let
 *  one window hold the loop for most of a second on a large queue. */
const WINDOW_TARGET_MS = 16;

/**
 * The main database file when the execution view's candidate read can run cooperatively on its own connection, or
 * null when it must stay a synchronous read on the main handle: inside a transaction (a second connection cannot
 * see its uncommitted writes), for a memory or temporary database, and for a non-WAL file (a long reader there
 * would block writers).
 */
export function cooperativeReadFile(db: Database.Database): string | null {
  if (db.inTransaction || db.memory) return null;
  const main = (db.pragma("database_list") as Array<{ name: string; file: string }>).find((entry) => entry.name === "main");
  if (!main?.file) return null;
  return db.pragma("journal_mode", { simple: true }) === "wal" ? main.file : null;
}

/** One cooperative read: its rows, the windows it read, and the longest synchronous stretch it ran between yields. */
export interface CooperativeRead<Row> {
  rows: Row[];
  windows: number;
  longestStretchMs: number;
}

/**
 * Reads every row of one SELECT over `table` (a table name from code, never input) on a new readonly connection, one
 * rowid window at a time, yielding to the event loop between windows so unrelated requests progress during a long
 * scan. `sql` reads one window: it binds the window's exclusive lower and inclusive upper rowid first
 * (`table.rowid > ? AND table.rowid <= ?`), then `binds`. Each statement steps over at most `windowRows` rowids however
 * few rows its filter matches; a cursor that yields between returned rows can scan the whole table in one step when
 * matches are rare. One read transaction keeps one snapshot for every window, and rows come back in rowid order. The
 * transaction and the connection end before returning, on every path; a read error is rethrown as-is and no partial
 * rows are returned. An aborted `signal` stops the read at the next window with its reason, the same way.
 * With `onWindow`, each window's rows go to it as they're read, in order, and none are kept; its time counts toward
 * the window's, and a throw from it ends the read like a read error. The caller then discards what it was given.
 */
export async function readRowsCooperatively<Row>(
  file: string,
  table: string,
  sql: string,
  binds: unknown[],
  open: (file: string) => Database.Database = (path) => new Database(path, { readonly: true, fileMustExist: true }),
  windowRows = WINDOW_ROWS,
  opts: { signal?: AbortSignal; targetMs?: number; onWindow?: (rows: Row[]) => void } = {},
): Promise<CooperativeRead<Row>> {
  const targetMs = opts.targetMs ?? WINDOW_TARGET_MS;
  let reader: Database.Database | undefined;
  let rows: Row[] = [];
  let windows = 0, longestStretchMs = 0, stretchStart = performance.now();
  const endStretch = () => { longestStretchMs = Math.max(longestStretchMs, performance.now() - stretchStart); };
  let failure: { error: unknown } | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  try {
    reader = open(file);
    reader.exec("BEGIN");
    // The first read takes the snapshot every window shares. Each scalar subquery seeks one end of the rowid b-tree;
    // one SELECT of MIN and MAX together would scan a whole index instead.
    const { lo, hi } = reader.prepare(`SELECT (SELECT MIN(rowid) FROM ${table}) AS lo, (SELECT MAX(rowid) FROM ${table}) AS hi`)
      .get() as { lo: number | null; hi: number | null };
    const window = reader.prepare(sql);
    if (lo !== null && hi !== null) {
      for (let after = lo - 1, size = windowRows; after < hi;) {
        opts.signal?.throwIfAborted();
        const through = Math.min(after + size, hi);
        const started = performance.now();
        const batch = window.all(after, through, ...binds) as Row[];
        if (opts.onWindow) opts.onWindow(batch);
        else for (const row of batch) rows.push(row);
        size = performance.now() - started > targetMs ? Math.max(1, Math.floor(size / 2)) : Math.min(windowRows, size * 2);
        windows++;
        after = through;
        if (after < hi) {
          endStretch();
          await new Promise<void>((resolve) => setImmediate(resolve));
          stretchStart = performance.now();
        }
      }
    }
  } catch (error) {
    failure = { error };
  } finally {
    try { if (reader?.inTransaction) reader.exec("ROLLBACK"); } catch (error) { cleanupFailure = { error }; }
    try { reader?.close(); } catch (error) { cleanupFailure ??= { error }; }
  }
  if (failure) { rows = []; throw failure.error; }
  if (cleanupFailure) { rows = []; throw cleanupFailure.error; }
  endStretch();
  return { rows, windows, longestStretchMs };
}
