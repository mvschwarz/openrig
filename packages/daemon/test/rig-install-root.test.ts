import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { rigInstallRootSchema } from "../src/db/migrations/096_rig_install_root.js";
import { RigRepository } from "../src/domain/rig-repository.js";

describe("rig installation folder persistence", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it("upgrades an existing database without inventing roots and survives reopen/archive/unarchive", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rig-install-root-")); roots.push(root);
    const file = path.join(root, "state.sqlite");
    let db = createDb(file);
    try {
      migrate(db, ALL_MIGRATIONS.filter(m => m.name !== rigInstallRootSchema.name));
      const old = new RigRepository(db).createRig("workshop");
      migrate(db, ALL_MIGRATIONS);
      migrate(db, ALL_MIGRATIONS);
      const repo = new RigRepository(db);
      expect(repo.getRigInstallRoot(old.id)).toBeNull();
      const installed = repo.createRig("workshop", root);
      repo.archiveRig(installed.id);
      db.close(); db = createDb(file);
      const reopened = new RigRepository(db);
      expect(reopened.getRigInstallRoot(old.id)).toBeNull();
      expect(reopened.getRigInstallRoot(installed.id)).toBe(root);
      reopened.unarchiveRig(installed.id);
      expect(reopened.getRigInstallRoot(installed.id)).toBe(root);
      expect(reopened.getRigInstallRoot(reopened.createRig("local-spec").id)).toBeNull();
    } finally { db.close(); }
  });
});
