import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome } from "./openrig-compat.js";

/** An explicit configured DB wins; otherwise retain the last launch's --db selection. */
export function resolveLocalDbOverride(): string | undefined {
  const configured = new ConfigStore().resolveWithSource("db.path");
  if (configured.source !== "default" && typeof configured.value === "string") return configured.value;
  try {
    const state = JSON.parse(readFileSync(join(getOpenRigHome(), "daemon.json"), "utf8"));
    if (typeof state?.db === "string" && state.db.length > 0) return state.db;
  } catch { /* No launch record: use this home's default, never search other homes. */ }
  return undefined;
}

/** This home's database, opened read-only without requiring the local daemon. better-sqlite3 loads only when this is
 *  called, so importing this module costs a command nothing. Throws when there's no database. */
export function openLocalDbReadonly(): Database.Database {
  const dbPath = resolveLocalDbOverride() ?? join(getOpenRigHome(), "openrig.sqlite");
  const Sqlite = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
  return new Sqlite(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
}
