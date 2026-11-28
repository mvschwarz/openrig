import { readdirSync } from "node:fs";
import type { Migration } from "./migrate.js";

// The migration list. SINGLE SOURCE: the daemon boot path (startup.ts) and any test or tool that needs a
// schema-faithful DB migrate from this array, so a reader DB is never seeded from a stale hand-copied subset.
//
// Each migration is one file in ./migrations, `NNN_snake_name.ts`, exporting one Migration whose `name` is
// that file name with `.sql`. They're found in the folder rather than listed by hand, so adding a migration
// is its own file and test, and two changes that each add one don't collide on a shared list. `migrate`
// applies them sorted by name, and the ledger (schema_migrations) keys on that name, so finding them here
// changes neither which have run nor their order. Numbers may be reserved by independent changes.

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);
const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.(?:ts|js)$/;

function isMigration(value: unknown): value is Migration {
  return typeof value === "object" && value !== null
    && typeof (value as Migration).name === "string" && typeof (value as Migration).sql === "string";
}

/** The migrations in `dir`, in file-name order: the built daemon's `.js` files, or the `.ts` sources the test
 *  runner loads, matching this module's own extension. A migration file that exports no migration fails
 *  loudly, since skipping it would leave the schema short. */
export async function loadMigrations(dir: URL = MIGRATIONS_DIR, extension = new URL(import.meta.url).pathname.endsWith(".ts") ? ".ts" : ".js"): Promise<Migration[]> {
  const files = readdirSync(dir).filter((file) => MIGRATION_FILE.test(file) && file.endsWith(extension)).sort();
  if (files.length === 0) throw new Error(`No migration files ending in ${extension} found in ${dir.href}.`);
  return Promise.all(files.map(async (file) => {
    const found = Object.values(await import(new URL(file, dir).href) as Record<string, unknown>).filter(isMigration);
    if (found.length !== 1) throw new Error(`Migration file ${file} must export exactly one migration; it exports ${found.length}.`);
    return found[0]!;
  }));
}

export const ALL_MIGRATIONS: Migration[] = await loadMigrations();
