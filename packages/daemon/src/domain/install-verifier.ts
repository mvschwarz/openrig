import { createHash } from "node:crypto";
import type { InstallRepository, JournalEntry } from "./install-repository.js";
import type { PackageRepository } from "./package-repository.js";

export interface Check {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}

export interface EntryVerification {
  journalId: string;
  targetPath: string;
  checks: Check[];
}

export interface VerificationResult {
  passed: boolean;
  installId: string;
  entries: EntryVerification[];
  statusCheck: Check;
}

export interface VerifierFsOps {
  readFile: (filePath: string) => string;
  exists: (filePath: string) => boolean;
}

const BLOCK_START = (name: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${name} -->`;
const BLOCK_END = (name: string) => `<!-- END OpenRig MANAGED BLOCK: ${name} -->`;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class InstallVerifier {
  private installRepo: InstallRepository;
  private packageRepo: PackageRepository;
  private fs: VerifierFsOps;

  constructor(installRepo: InstallRepository, packageRepo: PackageRepository, fs: VerifierFsOps) {
    this.installRepo = installRepo;
    this.packageRepo = packageRepo;
    this.fs = fs;
  }

  verify(installId: string): VerificationResult {
    const install = this.installRepo.getInstall(installId);
    if (!install) {
      return {
        passed: false,
        installId,
        entries: [],
        statusCheck: { name: "install_exists", passed: false, expected: "exists", actual: "not found" },
      };
    }

    // Status check
    const statusCheck: Check = {
      name: "install_status",
      passed: install.status === "applied",
      expected: "applied",
      actual: install.status,
    };

    if (!statusCheck.passed) {
      return { passed: false, installId, entries: [], statusCheck };
    }

    // Get package name for guidance marker checks
    const pkg = this.packageRepo.getPackage(install.packageId);
    const packageName = pkg?.name ?? "unknown";

    // Get applied journal entries (not rollback entries)
    const journal = this.installRepo.getJournalEntries(installId);
    const applyEntries = journal.filter((e) => e.action !== "rollback");

    // Empty journal for applied install is a verification failure
    if (applyEntries.length === 0) {
      return {
        passed: false,
        installId,
        entries: [],
        statusCheck: { ...statusCheck, name: "journal_not_empty", passed: false, expected: "at least 1 applied entry", actual: "0 entries" },
      };
    }

    const entries: EntryVerification[] = [];
    let allPassed = true;

    for (const entry of applyEntries) {
      const checks: Check[] = [];

      // Check 1: Target file exists
      const exists = this.fs.exists(entry.targetPath);
      checks.push({
        name: "target_exists",
        passed: exists,
        expected: "exists",
        actual: exists ? "exists" : "missing",
      });

      if (exists) {
        if (!entry.afterHash) {
          // Missing after_hash — integrity cannot be verified
          checks.push({
            name: "content_hash",
            passed: false,
            expected: "hash recorded",
            actual: "after_hash missing from journal",
          });
        }

        // Check 2: Content hash matches (only if after_hash recorded)
        const content = this.fs.readFile(entry.targetPath);
        const currentHash = hashContent(content);

        if (entry.afterHash) {
          checks.push({
            name: "content_hash",
            passed: currentHash === entry.afterHash,
            expected: entry.afterHash,
            actual: currentHash,
          });
        }

        // Check 3: Guidance managed block markers — recognize both
        // the OpenRig form (current writes) and the legacy RIGGED form
        // from prior installs so verification of pre-rename installs
        // does not falsely report missing markers.
        if (entry.exportType === "guidance") {
          const legacyStart = `<!-- BEGIN RIGGED MANAGED BLOCK: ${packageName} -->`;
          const legacyEnd = `<!-- END RIGGED MANAGED BLOCK: ${packageName} -->`;
          const hasStart = content.includes(BLOCK_START(packageName)) || content.includes(legacyStart);
          const hasEnd = content.includes(BLOCK_END(packageName)) || content.includes(legacyEnd);
          checks.push({
            name: "managed_block_markers",
            passed: hasStart && hasEnd,
            expected: "BEGIN + END markers present",
            actual: hasStart && hasEnd ? "present" : `BEGIN: ${hasStart}, END: ${hasEnd}`,
          });
        }
      }

      // Check 4-5: Backup integrity
      if (entry.backupPath) {
        const backupExists = this.fs.exists(entry.backupPath);
        checks.push({
          name: "backup_exists",
          passed: backupExists,
          expected: "exists",
          actual: backupExists ? "exists" : "missing",
        });

        if (backupExists && !entry.beforeHash) {
          checks.push({
            name: "backup_hash",
            passed: false,
            expected: "hash recorded",
            actual: "before_hash missing from journal",
          });
        } else if (backupExists && entry.beforeHash) {
          const backupContent = this.fs.readFile(entry.backupPath);
          const backupHash = hashContent(backupContent);
          checks.push({
            name: "backup_hash",
            passed: backupHash === entry.beforeHash,
            expected: entry.beforeHash,
            actual: backupHash,
          });
        }
      }

      const entryPassed = checks.every((c) => c.passed);
      if (!entryPassed) allPassed = false;

      entries.push({
        journalId: entry.id,
        targetPath: entry.targetPath,
        checks,
      });
    }

    return {
      passed: allPassed && statusCheck.passed,
      installId,
      entries,
      statusCheck,
    };
  }
}
