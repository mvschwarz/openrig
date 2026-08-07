import { join } from "node:path";

/**
 * D15 — resolve the daemon's SQLite path. An explicit OPENRIG_DB / RIGGED_DB wins
 * (the operator takes responsibility for that path); otherwise the db is anchored
 * under OPENRIG_HOME, NEVER a bare CWD-relative filename.
 *
 * Incident 2026-08-07: the entrypoint defaulted `dbPath` to a bare "openrig.sqlite"
 * which resolves against the process CWD — so a daemon launched with an isolated
 * OPENRIG_HOME could still open the SHARED fleet db (whatever sat in its CWD).
 * Anchoring the default to OPENRIG_HOME makes an isolated-home daemon isolate its
 * db too, which is the whole point of setting OPENRIG_HOME.
 */
export function resolveDaemonDbPath(explicitDb: string | undefined | null, openrigHome: string): string {
  if (explicitDb && explicitDb.length > 0) {
    return explicitDb;
  }
  return join(openrigHome, "openrig.sqlite");
}
