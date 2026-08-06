// P8 — startup ALL_MIGRATIONS mirror-law (0.5.2 release gate). The daemon startup
// path must apply the CANONICAL migration list (db/all-migrations.ts ALL_MIGRATIONS),
// never an inline COPY that can silently drift out of sync (a drifted startup list
// = a daemon that boots against a schema the code doesn't expect). Production imports
// the single source; this pin makes re-introducing a copy fail loudly.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTUP_SRC = readFileSync(resolve(HERE, "..", "src", "startup.ts"), "utf8");

describe("P8 — startup migrations mirror the canonical ALL_MIGRATIONS", () => {
  it("startup applies the imported ALL_MIGRATIONS, not an inline copy", () => {
    // single source: startup migrates with the canonical list…
    expect(STARTUP_SRC).toContain("migrate(db, ALL_MIGRATIONS)");
    // …and never an inline array literal that could drift.
    expect(STARTUP_SRC).not.toMatch(/migrate\(db,\s*\[/);
  });

  it("the canonical list is imported from the single source and is non-trivial", () => {
    expect(STARTUP_SRC).toMatch(/import\s*\{\s*ALL_MIGRATIONS\s*\}\s*from\s*["'][^"']*db\/all-migrations\.js["']/);
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(50);
  });
});
