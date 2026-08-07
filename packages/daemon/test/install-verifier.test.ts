import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { InstallEngine, type EngineFsOps } from "../src/domain/install-engine.js";
import { InstallVerifier } from "../src/domain/install-verifier.js";
import type { InstallPlanEntry } from "../src/domain/install-planner.js";
import type { RefinedInstallPlan } from "../src/domain/conflict-detector.js";
import type { PolicyResult } from "../src/domain/install-policy.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function realFs(): EngineFsOps {
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
    exportType: "skill", exportName: "test", classification: "safe_projection",
    targetPath: "", scope: "project_shared", deferred: false, ...overrides,
  };
}

function makePlan(entries: InstallPlanEntry[]): RefinedInstallPlan {
  return {
    packageName: "test-pkg", packageVersion: "1.0.0", sourceRef: "/pkg",
    entries, actionable: entries.filter((e) => !e.deferred),
    deferred: [], conflicts: [], noOps: [],
  };
}

describe("InstallVerifier", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-verify-"));
    repoRoot = path.join(tmpDir, "repo");
    pkgRoot = path.join(tmpDir, "pkg");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(pkgRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedAndInstallSkill(): string {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const srcPath = path.join(pkgRoot, "skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "# Foo", "utf-8");

    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    const entry = makeEntry({ targetPath, sourcePath: srcPath });
    const engine = new InstallEngine(installRepo, realFs());
    const result = engine.apply({ approved: [entry], rejected: [] }, makePlan([entry]), pkg.id, repoRoot);
    return result.installId;
  }

  function seedAndInstallGuidance(): string {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const srcPath = path.join(pkgRoot, "guidance/AGENTS.md");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "Review carefully.", "utf-8");

    const targetPath = path.join(repoRoot, "AGENTS.md");
    const entry = makeEntry({ exportType: "guidance", classification: "safe_projection", targetPath, sourcePath: srcPath });
    const engine = new InstallEngine(installRepo, realFs());
    const result = engine.apply({ approved: [entry], rejected: [] }, makePlan([entry]), pkg.id, repoRoot);
    return result.installId;
  }

  // Test 1: Clean install -> all checks pass
  it("clean install -> all checks pass", () => {
    const installId = seedAndInstallSkill();
    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(true);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of result.entries) {
      for (const check of entry.checks) {
        expect(check.passed).toBe(true);
      }
    }
  });

  // Test 2: Missing target file -> verification failure
  it("missing target file -> verification failure", () => {
    const installId = seedAndInstallSkill();
    // Delete the target file
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.unlinkSync(targetPath);

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    const failedCheck = result.entries[0]!.checks.find((c) => c.name === "target_exists");
    expect(failedCheck).toBeDefined();
    expect(failedCheck!.passed).toBe(false);
  });

  // Test 3: Modified target (hash mismatch) -> verification failure
  it("modified target content -> verification failure", () => {
    const installId = seedAndInstallSkill();
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.writeFileSync(targetPath, "# Tampered content", "utf-8");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    const hashCheck = result.entries[0]!.checks.find((c) => c.name === "content_hash");
    expect(hashCheck).toBeDefined();
    expect(hashCheck!.passed).toBe(false);
  });

  // Test 4: Missing managed block markers -> verification failure
  it("guidance missing managed block markers -> verification failure", () => {
    const installId = seedAndInstallGuidance();
    const targetPath = path.join(repoRoot, "AGENTS.md");
    // Overwrite with content missing markers
    fs.writeFileSync(targetPath, "No markers here.", "utf-8");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    const markerCheck = result.entries[0]!.checks.find((c) => c.name === "managed_block_markers");
    expect(markerCheck).toBeDefined();
    expect(markerCheck!.passed).toBe(false);
  });

  // Test 5: Backup integrity passes
  it("backup integrity check passes for overwritten files", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const srcPath = path.join(pkgRoot, "skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "# New", "utf-8");

    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "# Original", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath: srcPath });
    const engine = new InstallEngine(installRepo, realFs());
    const result = engine.apply({ approved: [entry], rejected: [] }, makePlan([entry]), pkg.id, repoRoot);

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const verifyResult = verifier.verify(result.installId);

    expect(verifyResult.passed).toBe(true);
    const backupCheck = verifyResult.entries[0]!.checks.find((c) => c.name === "backup_hash");
    expect(backupCheck).toBeDefined();
    expect(backupCheck!.passed).toBe(true);
  });

  // Test 6: Per-entry status with check details
  it("verification result includes per-entry check details", () => {
    const installId = seedAndInstallSkill();
    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.journalId).toBeDefined();
    expect(result.entries[0]!.targetPath).toContain("SKILL.md");
    expect(result.entries[0]!.checks.length).toBeGreaterThanOrEqual(2); // target_exists + content_hash
    for (const check of result.entries[0]!.checks) {
      expect(check.name).toBeDefined();
      expect(typeof check.passed).toBe("boolean");
    }
  });

  // Test 7: Install status != applied -> verification failure
  it("install with status != applied -> verification failure", () => {
    const installId = seedAndInstallSkill();
    // Manually set status to planned
    installRepo.updateInstallStatus(installId, "planned");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    expect(result.statusCheck.passed).toBe(false);
    expect(result.statusCheck.actual).toBe("planned");
  });

  // Test 8: Applied install with zero journal entries -> verification failure
  it("applied install with no journal entries -> verification failure", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const install = installRepo.createInstall(pkg.id, repoRoot, "project_shared");
    installRepo.updateInstallStatus(install.id, "applied");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(install.id);

    expect(result.passed).toBe(false);
  });

  // Test 9: Journal entry with missing after_hash -> verification failure
  it("journal entry with missing after_hash -> verification failure", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const install = installRepo.createInstall(pkg.id, repoRoot, "project_shared");
    installRepo.updateInstallStatus(install.id, "applied");

    // Create a target file
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Content", "utf-8");

    // Manually create journal entry WITHOUT afterHash
    installRepo.createJournalEntry({
      installId: install.id,
      action: "copy",
      exportType: "skill",
      classification: "safe_projection",
      targetPath,
      // No afterHash
    });

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(install.id);

    expect(result.passed).toBe(false);
    const hashCheck = result.entries[0]!.checks.find((c) => c.name === "content_hash" && !c.passed);
    expect(hashCheck).toBeDefined();
    expect(hashCheck!.actual).toContain("missing");
  });

  // Test 10: Backup exists but before_hash missing -> verification failure
  it("backup exists but before_hash missing -> verification failure", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const install = installRepo.createInstall(pkg.id, repoRoot, "project_shared");
    installRepo.updateInstallStatus(install.id, "applied");

    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Content", "utf-8");

    const backupPath = path.join(repoRoot, ".rigged-backups", install.id, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, "Original", "utf-8");

    // Create hash for after but NOT before
    const crypto = require("node:crypto");
    const afterHash = crypto.createHash("sha256").update("Content").digest("hex");

    installRepo.createJournalEntry({
      installId: install.id,
      action: "copy",
      exportType: "skill",
      classification: "safe_projection",
      targetPath,
      backupPath,
      afterHash,
      // No beforeHash
    });

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(install.id);

    expect(result.passed).toBe(false);
    const backupCheck = result.entries[0]!.checks.find((c) => c.name === "backup_hash" && !c.passed);
    expect(backupCheck).toBeDefined();
    expect(backupCheck!.actual).toContain("missing");
  });
});
