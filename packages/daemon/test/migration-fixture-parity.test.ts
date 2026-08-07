import { describe, it, expect } from "vitest";
import { migrationsForFullTestDb, migrationsForFullTestDbExclusions } from "./helpers/test-app.js";
import { assertExplicitSubsetOfAllMigrations } from "./helpers/migration-subset-guard.js";

// P24 — the curated fixture lists must be DECLARED subsets of ALL_MIGRATIONS, not accidental ones.
// A migration added to ALL_MIGRATIONS but forgotten in a curated list now FAILS LOUD with its name +
// the fix, instead of surfacing as a mystery missing column/table deep in an unrelated suite (the
// 064/066/067 tax). Deliberate minimalism is fine — it just has to be declared with a re-evaluable
// reason (the exclusions map lives beside its list in test-app.ts, so an editor of the list sees it).

// A fake Migration is just its `name` for the guard's purposes (it compares by name).
const fake = (name: string) => ({ name } as unknown as import("../src/db/migrate.js").Migration);

describe("P24 — migration-fixture parity (curated lists are DECLARED subsets of ALL_MIGRATIONS)", () => {
  it("migrationsForFullTestDb: every shipped migration is listed or declared-excluded", () => {
    assertExplicitSubsetOfAllMigrations({
      listName: "migrationsForFullTestDb (test/helpers/test-app.ts)",
      curatedList: migrationsForFullTestDb,
      exclusions: migrationsForFullTestDbExclusions,
    });
  });

  // The load-bearing proof: the guard FIRES on a future migration added to ALL_MIGRATIONS but forgotten
  // in the curated list (neither listed nor declared) — and its message names the migration + the fix.
  it("FIRES (named) when a newly-added migration is neither listed nor declared", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql")],
        exclusions: {},
        allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
      }),
    ).toThrowError(/068_brand_new\.sql[\s\S]*ADD it to fixtureX[\s\S]*DECLARE it/);
  });

  it("passes when the new migration is LISTED, and (separately) when it is DECLARED-excluded", () => {
    // listed → fine
    assertExplicitSubsetOfAllMigrations({
      listName: "fixtureX",
      curatedList: [fake("001_a.sql"), fake("068_brand_new.sql")],
      exclusions: {},
      allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
    });
    // declared-excluded → fine
    assertExplicitSubsetOfAllMigrations({
      listName: "fixtureX",
      curatedList: [fake("001_a.sql")],
      exclusions: { "068_brand_new.sql": "subsystem table — not on this fixture's edge" },
      allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
    });
  });

  it("FIRES on a STALE exclusion (names a migration absent from ALL_MIGRATIONS)", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql")],
        exclusions: { "999_ghost.sql": "reason" },
        allMigrations: [fake("001_a.sql")],
      }),
    ).toThrowError(/stale[\s\S]*999_ghost\.sql/);
  });

  it("FIRES on a REDUNDANT exclusion (a migration both listed AND excluded)", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql"), fake("002_b.sql")],
        exclusions: { "002_b.sql": "reason" },
        allMigrations: [fake("001_a.sql"), fake("002_b.sql")],
      }),
    ).toThrowError(/redundant[\s\S]*002_b\.sql/i);
  });
});
