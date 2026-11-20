import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome } from "./openrig-compat.js";

/** This home's database, opened read-only without requiring the local daemon. better-sqlite3 loads only when this is
 *  called, so importing this module costs a command nothing. Throws when there's no database. */
export function openLocalDbReadonly(): Database.Database {
  const configured = new ConfigStore().resolveWithSource("db.path");
  let dbPath = configured.value as string;
  // An explicit configured DB wins. Otherwise retain the last launch's --db selection.
  if (configured.source === "default") {
    try {
      const state = JSON.parse(readFileSync(join(getOpenRigHome(), "daemon.json"), "utf8"));
      if (typeof state.db === "string" && state.db.length > 0) dbPath = state.db;
    } catch { /* No launch record: use the configured default, never search other homes. */ }
  }
  const Sqlite = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
  return new Sqlite(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
}
