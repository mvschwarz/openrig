import { expect } from "vitest";
import type { Migration } from "../../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../src/db/all-migrations.js";

/**
 * P24 — a curated test-fixture migration list is an EXPLICIT, DECLARED subset of ALL_MIGRATIONS.
 *
 * Kills the silent-omission tax: a migration added to ALL_MIGRATIONS but forgotten in a curated fixture
 * list used to fail confusingly (a missing column/table surfacing deep in an unrelated test — the desk
 * paid this at the 064/066/067 folds). This asserts every shipped migration is EITHER in the curated
 * list OR in a named exclusions map WITH a re-evaluable reason. The curated lists' deliberate
 * minimalism stays a design choice — it just has to be DECLARED, never accidental. Assert, don't derive
 * (deriving would auto-include every future migration and quietly destroy that minimalism).
 */
export function assertExplicitSubsetOfAllMigrations(opts: {
  /** Human name of the curated list, used in the training error message. */
  listName: string;
  curatedList: readonly Migration[];
  /** migration `name` → a RE-EVALUABLE reason it is deliberately omitted (a future reader can re-check
   *  it). "migrationsForFullTestDb is schema-minimal for the core edge; <table> is unused here" beats
   *  "not needed" — a reason that cannot be re-checked becomes the next stale claim. */
  exclusions: Record<string, string>;
  /** The shipped list to check against. Defaults to the real ALL_MIGRATIONS; injectable so the guard's
   *  own negative-control test can simulate a newly-added migration. */
  allMigrations?: readonly Migration[];
}): void {
  const listed = new Set(opts.curatedList.map((m) => m.name));
  const excluded = new Set(Object.keys(opts.exclusions));
  const allNames = (opts.allMigrations ?? ALL_MIGRATIONS).map((m) => m.name);

  // (1) THE CORE — every shipped migration is listed or declared-excluded. The message carries the FIX,
  // not just the fault: it will fire on someone who has never seen this guard, so it must teach.
  const undeclared = allNames.filter((n) => !listed.has(n) && !excluded.has(n));
  expect(
    undeclared,
    undeclared.length === 0
      ? ""
      : `P24 migration-fixture parity — ${undeclared.length} shipped migration(s) are in ALL_MIGRATIONS ` +
        `but NEITHER in the curated list "${opts.listName}" NOR its declared exclusions:\n  ` +
        `${undeclared.join("\n  ")}\n` +
        `This is the silent-omission tax: without this guard each would surface later as a mystery ` +
        `missing column/table in some unrelated test. FIX — for EACH migration above pick one:\n` +
        `  (a) ADD it to ${opts.listName} (its tests need the schema), or\n` +
        `  (b) DECLARE it in that list's exclusions map with a re-evaluable reason (e.g. ` +
        `"${opts.listName} is deliberately schema-minimal for <edge>; <table> is unused here").`,
  ).toEqual([]);

  // (2) No STALE exclusion — an exclusion naming a migration not (any longer) in ALL_MIGRATIONS is
  // itself a stale claim; remove it.
  const stale = [...excluded].filter((n) => !allNames.includes(n));
  expect(
    stale,
    stale.length === 0
      ? ""
      : `P24 — "${opts.listName}" exclusions name migration(s) absent from ALL_MIGRATIONS (stale, remove ` +
        `them): ${stale.join(", ")}`,
  ).toEqual([]);

  // (3) No REDUNDANT exclusion — a migration both listed AND excluded is contradictory; the exclusion
  // is dead. Keep the list authoritative.
  const redundant = [...excluded].filter((n) => listed.has(n));
  expect(
    redundant,
    redundant.length === 0
      ? ""
      : `P24 — "${opts.listName}" exclusions redundantly name migration(s) that ARE in the list (remove ` +
        `from exclusions): ${redundant.join(", ")}`,
  ).toEqual([]);
}
