import Database from "better-sqlite3";

/** Rows read per slice, and the time a slice may take, before yielding to the event loop. Both are soft: one native
 *  step or row conversion can take longer. */
const SLICE_ROWS = 64;
const SLICE_MS = 8;

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

/**
 * Reads every row of one SELECT on a new readonly connection to `file`, yielding to the event loop between slices so
 * unrelated requests progress during a long scan. One cursor keeps one snapshot for the whole read. The cursor and
 * the connection are closed before returning, on every path; a read error is rethrown as-is and no partial rows are
 * returned.
 */
export async function readRowsCooperatively<Row>(
  file: string,
  sql: string,
  binds: unknown[],
  open: (file: string) => Database.Database = (path) => new Database(path, { readonly: true, fileMustExist: true }),
): Promise<Row[]> {
  let reader: Database.Database | undefined;
  let cursor: IterableIterator<unknown> | undefined;
  let rows: Row[] = [];
  let failure: { error: unknown } | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  try {
    reader = open(file);
    cursor = reader.prepare(sql).iterate(...binds);
    for (;;) {
      const sliceStart = performance.now();
      let read = 0;
      let step = cursor.next();
      while (!step.done) {
        rows.push(step.value as Row);
        if (++read >= SLICE_ROWS || performance.now() - sliceStart >= SLICE_MS) break;
        step = cursor.next();
      }
      if (step.done) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    failure = { error };
  } finally {
    try { cursor?.return?.(); } catch (error) { cleanupFailure = { error }; }
    try { reader?.close(); } catch (error) { cleanupFailure ??= { error }; }
  }
  if (failure) { rows = []; throw failure.error; }
  if (cleanupFailure) { rows = []; throw cleanupFailure.error; }
  return rows;
}
