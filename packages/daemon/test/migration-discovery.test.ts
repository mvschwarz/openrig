import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_MIGRATIONS, loadMigrations } from "../src/db/all-migrations.js";

// Migrations are found in src/db/migrations rather than listed by hand. `migrate` applies them sorted by name and
// the ledger keys on that name, so these cells pin what keeps discovery equal to the old hand-kept list: one
// migration per file, named after its file, and nothing in the folder left out.

const MIGRATIONS = new URL("../src/db/migrations/", import.meta.url);
const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".ts")).sort();

describe("migration discovery", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("each migration file is NNN_snake_name.ts and exports one migration named after it", async () => {
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      expect(file, file).toMatch(/^\d{3}_[a-z0-9_]+\.ts$/);
      const exported = Object.values(await import(new URL(file, MIGRATIONS).href) as Record<string, unknown>)
        .filter((value): value is { name: string; sql: string } =>
          typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string");
      expect(exported.map((migration) => migration.name), file).toEqual([file.replace(/\.ts$/, ".sql")]);
    }
  });

  it("ALL_MIGRATIONS is exactly the folder, once each", () => {
    const names = ALL_MIGRATIONS.map((migration) => migration.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(files.map((file) => file.replace(/\.ts$/, ".sql")));
  });

  it("loads only migration files of the running extension, in file-name order", async () => {
    dir = mkdtempSync(join(tmpdir(), "migration-discovery-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "002_second.js"), 'export const second = { name: "002_second.sql", sql: "SELECT 2;" };\n');
    writeFileSync(join(dir, "001_first.js"), 'export const first = { name: "001_first.sql", sql: "SELECT 1;" };\n');
    for (const other of ["001_first.d.ts", "001_first.js.map", "helpers.js", "README.md", "003_draft.ts"]) writeFileSync(join(dir, other), "");
    const loaded = await loadMigrations(pathToFileURL(`${dir}/`), ".js");
    expect(loaded.map((migration) => migration.name)).toEqual(["001_first.sql", "002_second.sql"]);
  });

  it("fails loudly on a migration file that exports no migration, rather than skipping it", async () => {
    dir = mkdtempSync(join(tmpdir(), "migration-discovery-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "001_empty.js"), "export const notAMigration = 1;\n");
    await expect(loadMigrations(pathToFileURL(`${dir}/`), ".js")).rejects.toThrow(/001_empty\.js must export exactly one migration; it exports 0/);
  });
});
