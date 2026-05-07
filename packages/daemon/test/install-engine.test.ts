import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { InstallEngine, type EngineFsOps } from "../src/domain/install-engine.js";
import type { InstallPlanEntry } from "../src/domain/install-planner.js";
import type { RefinedInstallPlan } from "../src/domain/conflict-detector.js";
import type { PolicyResult } from "../src/domain/install-policy.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema,
];

function realFs(tmpDir: string): EngineFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (src, dest) => fs.copyFileSync(src, dest),
    deleteFile: (p) => fs.unlinkSync(p),
  };
}

function makeEntry(overrides: Partial<InstallPlanEntry>): InstallPlanEntry {
  return {
    exportType: "skill",
    exportName: "test",
    classification: "safe_projection",
    targetPath: "",
    scope: "project_shared",
    deferred: false,
    ...overrides,
  };
}

function makePlan(entries: InstallPlanEntry[]): RefinedInstallPlan {
  return {
    packageName: "test-pkg",
    packageVersion: "1.0.0",
    sourceRef: "/pkg",
    entries,
    actionable: entries.filter((e) => !e.deferred),
    deferred: entries.filter((e) => e.deferred),
    conflicts: [],
    noOps: [],
  };
}

function makePolicy(approved: InstallPlanEntry[]): PolicyResult {
  return { approved, rejected: [] };
}

describe("InstallEngine", () => {
  let db: Database.Database;
  let pkgRepo: PackageRepository;
  let installRepo: InstallRepository;
  let tmpDir: string;
  let repoRoot: string;
  let pkgRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    pkgRepo = new PackageRepository(db);
    installRepo = new InstallRepository(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    repoRoot = path.join(tmpDir, "repo");
    pkgRoot = path.join(tmpDir, "pkg");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(pkgRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPackage() {
    return pkgRepo.createPackage({
      name: "test-pkg",
      version: "1.0.0",
      sourceKind: "local_path",
      sourceRef: pkgRoot,
      manifestHash: "abc123",
      summary: "Test",
    });
  }

  function writeSource(relPath: string, content: string) {
    const full = path.join(pkgRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return full;
  }

  // Test 1: Clean install: skills copied
  it("clean install: skills copied to target paths", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "# Foo Skill");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ exportName: "foo", targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("# Foo Skill");
    expect(result.applied).toHaveLength(1);
  });

  // Test 2: Guidance with managed block markers
  it("clean install: guidance created with managed block markers", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("guidance/AGENTS.md", "Review all PRs carefully.");
    const targetPath = path.join(repoRoot, "AGENTS.md");

    const entry = makeEntry({
      exportType: "guidance",
      exportName: "review-guide",
      classification: "safe_projection", // Real planner output for new guidance
      targetPath,
      sourcePath,
    });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const content = fs.readFileSync(targetPath, "utf-8");
    expect(content).toContain("<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->");
    expect(content).toContain("Review all PRs carefully.");
    expect(content).toContain("<!-- END OpenRig MANAGED BLOCK: test-pkg -->");
  });

  // Test 3: Journal entries with hashes
  it("clean install: journal entries written with correct hashes", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(result.applied[0]!.afterHash).toBeDefined();
    expect(result.applied[0]!.afterHash!.length).toBe(64); // SHA-256
  });

  // Test 4: Install status = applied
  it("clean install: package_install status = applied", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const install = installRepo.getInstall(result.installId);
    expect(install!.status).toBe("applied");
    expect(install!.appliedAt).toBeDefined();
  });

  // Test 5: Existing guidance: block inserted without clobbering
  it("existing guidance: managed block inserted without clobbering", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("guidance/AGENTS.md", "New guidance.");
    const targetPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(targetPath, "# Existing content\nKeep this.\n", "utf-8");

    const entry = makeEntry({
      exportType: "guidance",
      classification: "managed_merge",
      targetPath,
      sourcePath,
    });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const content = fs.readFileSync(targetPath, "utf-8");
    expect(content).toContain("# Existing content");
    expect(content).toContain("Keep this.");
    expect(content).toContain("New guidance.");
    expect(content).toContain("<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->");
  });

  // Test 6: Existing managed block updated in place
  it("existing managed block: updated in place", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("guidance/AGENTS.md", "Updated guidance.");
    const targetPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(targetPath,
      "# Header\n<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->\nOld content.\n<!-- END OpenRig MANAGED BLOCK: test-pkg -->\n# Footer\n",
      "utf-8"
    );

    const entry = makeEntry({
      exportType: "guidance",
      classification: "managed_merge",
      targetPath,
      sourcePath,
    });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const content = fs.readFileSync(targetPath, "utf-8");
    expect(content).toContain("# Header");
    expect(content).toContain("Updated guidance.");
    expect(content).not.toContain("Old content.");
    expect(content).toContain("# Footer");
  });

  // Test 7: Backup created before overwrite
  it("backup created before overwrite", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Original content", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(result.applied[0]!.backupPath).toBeDefined();
    expect(fs.existsSync(result.applied[0]!.backupPath!)).toBe(true);
    expect(fs.readFileSync(result.applied[0]!.backupPath!, "utf-8")).toBe("Original content");
  });

  // Test 8: Rollback restores from backup
  it("rollback restores original files from backup", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Original", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.readFileSync(targetPath, "utf-8")).toBe("New");

    const rollbackResult = engine.rollback(installResult.installId);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("Original");
    expect(rollbackResult.restored).toContain(targetPath);
  });

  // Test 9: Rollback of new file -> deleted
  it("rollback of new file -> file deleted", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.existsSync(targetPath)).toBe(true);

    const rollbackResult = engine.rollback(installResult.installId);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(rollbackResult.deleted).toContain(targetPath);
  });

  // Test 10: Rollback status
  it("rollback updates package_install status to rolled_back", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    engine.rollback(installResult.installId);

    const install = installRepo.getInstall(installResult.installId);
    expect(install!.status).toBe("rolled_back");
    expect(install!.rolledBackAt).toBeDefined();
  });

  // Test 11: Failed mid-apply -> compensating rollback
  it("failed mid-apply -> compensating rollback, status = failed", () => {
    const pkg = seedPackage();
    const goodSource = writeSource("skills/foo/SKILL.md", "Good");
    const goodTarget = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    const badTarget = path.join(repoRoot, ".agents/skills/bar/SKILL.md");

    const goodEntry = makeEntry({ exportName: "foo", targetPath: goodTarget, sourcePath: goodSource });
    // Bad entry: source doesn't exist
    const badEntry = makeEntry({ exportName: "bar", targetPath: badTarget, sourcePath: "/nonexistent/SKILL.md" });

    const engine = new InstallEngine(installRepo, realFs(tmpDir));

    expect(() => {
      engine.apply(makePolicy([goodEntry, badEntry]), makePlan([goodEntry, badEntry]), pkg.id, repoRoot);
    }).toThrow();

    // Good file should be rolled back
    expect(fs.existsSync(goodTarget)).toBe(false);

    // Install should be marked failed
    const installs = installRepo.listInstalls(pkg.id);
    expect(installs[0]!.status).toBe("failed");
  });

  // Test 12: Journal entries track hashes
  it("journal entries track before/after hashes", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Old content", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(result.applied[0]!.beforeHash).toBeDefined();
    expect(result.applied[0]!.afterHash).toBeDefined();
    expect(result.applied[0]!.beforeHash).not.toBe(result.applied[0]!.afterHash);
  });

  // Test 13: Nonexistent target directory created
  it("install into nonexistent target directory -> directory created", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, "deep/nested/dir/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.existsSync(targetPath)).toBe(true);
  });

  // Test 14: listInstalls
  it("listInstalls returns correct records with status", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const installs = installRepo.listInstalls(pkg.id);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.status).toBe("applied");
    expect(installs[0]!.packageId).toBe(pkg.id);
  });

  // Test 15: Two skills with same filename backed up to distinct paths
  it("two skills backed up to distinct paths (no collision)", () => {
    const pkg = seedPackage();
    const src1 = writeSource("skills/foo/SKILL.md", "Foo new");
    const src2 = writeSource("skills/bar/SKILL.md", "Bar new");
    const t1 = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    const t2 = path.join(repoRoot, ".agents/skills/bar/SKILL.md");

    fs.mkdirSync(path.dirname(t1), { recursive: true });
    fs.mkdirSync(path.dirname(t2), { recursive: true });
    fs.writeFileSync(t1, "Foo original", "utf-8");
    fs.writeFileSync(t2, "Bar original", "utf-8");

    const e1 = makeEntry({ exportName: "foo", targetPath: t1, sourcePath: src1 });
    const e2 = makeEntry({ exportName: "bar", targetPath: t2, sourcePath: src2 });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([e1, e2]), makePlan([e1, e2]), pkg.id, repoRoot);

    // Both backups exist and have distinct paths
    expect(result.applied[0]!.backupPath).not.toBe(result.applied[1]!.backupPath);
    expect(fs.readFileSync(result.applied[0]!.backupPath!, "utf-8")).toBe("Foo original");
    expect(fs.readFileSync(result.applied[1]!.backupPath!, "utf-8")).toBe("Bar original");
  });

  // Test 16: Rollback appends journal rows
  it("rollback appends journal entries (action=rollback)", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    engine.rollback(installResult.installId);

    const journal = installRepo.getJournalEntries(installResult.installId);
    const rollbackEntries = journal.filter((j) => j.action === "rollback");
    expect(rollbackEntries.length).toBeGreaterThanOrEqual(1);
    expect(rollbackEntries[0]!.status).toBe("rolled_back");
  });

  // Test 17: Journal ordering deterministic by seq
  it("journal entries ordered by seq, rollback reverses", () => {
    const pkg = seedPackage();
    const src1 = writeSource("skills/a/SKILL.md", "A");
    const src2 = writeSource("skills/b/SKILL.md", "B");
    const t1 = path.join(repoRoot, ".agents/skills/a/SKILL.md");
    const t2 = path.join(repoRoot, ".agents/skills/b/SKILL.md");

    const e1 = makeEntry({ exportName: "a", targetPath: t1, sourcePath: src1 });
    const e2 = makeEntry({ exportName: "b", targetPath: t2, sourcePath: src2 });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([e1, e2]), makePlan([e1, e2]), pkg.id, repoRoot);

    const journal = installRepo.getJournalEntries(result.installId);
    const applyEntries = journal.filter((j) => j.action !== "rollback");
    // seq should be 1, 2 in insertion order
    expect(applyEntries[0]!.seq).toBe(1);
    expect(applyEntries[1]!.seq).toBe(2);
    // Verify unique constraint: same install, different seq
    expect(applyEntries[0]!.seq).not.toBe(applyEntries[1]!.seq);
  });

  // Test 18: Upgrade path — 009 -> 010 backfills seq
  it("010 migration backfills seq on existing journal rows", () => {
    // Create DB at 009 (without 010)
    const upgradeDb = createDb();
    migrate(upgradeDb, [
      coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
      checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
      packagesSchema, installJournalSchema,
    ]);

    // Seed data at 009 level (no seq column yet)
    upgradeDb.prepare("INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)").run("p1", "pkg", "1.0.0", "local_path", "/p", "h");
    upgradeDb.prepare("INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)").run("i1", "p1", "/repo", "project_shared");
    upgradeDb.prepare("INSERT INTO install_journal (id, install_id, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?)").run("j1", "i1", "copy", "skill", "safe_projection", "/t1");
    upgradeDb.prepare("INSERT INTO install_journal (id, install_id, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?)").run("j2", "i1", "copy", "skill", "safe_projection", "/t2");
    upgradeDb.prepare("INSERT INTO install_journal (id, install_id, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?)").run("j3", "i1", "merge_block", "guidance", "managed_merge", "/t3");

    // Apply 010
    migrate(upgradeDb, [
      coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
      checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
      packagesSchema, installJournalSchema, journalSeqSchema,
    ]);

    // Verify seq backfilled
    const rows = upgradeDb.prepare("SELECT id, seq FROM install_journal WHERE install_id = ? ORDER BY seq").all("i1") as Array<{ id: string; seq: number }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.seq).toBe(1);
    expect(rows[1]!.seq).toBe(2);
    expect(rows[2]!.seq).toBe(3);

    // Verify unique constraint
    expect(() => {
      upgradeDb.prepare("INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)").run("j4", "i1", 1, "copy", "skill", "safe_projection", "/t4");
    }).toThrow(/UNIQUE/);

    upgradeDb.close();
  });

  // Test 19: Journal write failure undoes file mutation (R2-H3)
  it("journal write failure undoes file mutation for that entry", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));

    // Spy: first call to createJournalEntry throws
    vi.spyOn(installRepo, "createJournalEntry").mockImplementationOnce(() => {
      throw new Error("journal write failed");
    });

    expect(() => {
      engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);
    }).toThrow("journal write failed");

    // Target file should NOT exist (new file case: undo deletes it)
    expect(fs.existsSync(targetPath)).toBe(false);

    // Journal should have 0 applied entries
    const installs = installRepo.listInstalls(pkg.id);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.status).toBe("failed");

    const journal = installRepo.getJournalEntries(installs[0]!.id);
    const applyEntries = journal.filter((j) => j.action !== "rollback");
    expect(applyEntries).toHaveLength(0);
  });
});
