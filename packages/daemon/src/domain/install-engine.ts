import path from "node:path";
import { createHash } from "node:crypto";
import type { InstallPlanEntry } from "./install-planner.js";
import type { PolicyResult } from "./install-policy.js";
import type { RefinedInstallPlan } from "./conflict-detector.js";
import { InstallRepository, type JournalEntry } from "./install-repository.js";

export interface EngineFsOps {
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  exists: (filePath: string) => boolean;
  mkdirp: (dirPath: string) => void;
  copyFile: (src: string, dest: string) => void;
  deleteFile: (filePath: string) => void;
}

export interface InstallResult {
  installId: string;
  applied: JournalEntry[];
  deferred: InstallPlanEntry[];
  conflicts: InstallPlanEntry[];
}

export interface RollbackResult {
  installId: string;
  restored: string[];
  deleted: string[];
}

const BLOCK_START = (name: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${name} -->`;
const BLOCK_END = (name: string) => `<!-- END RIGGED MANAGED BLOCK: ${name} -->`;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class InstallEngine {
  private installRepo: InstallRepository;
  private fs: EngineFsOps;

  constructor(installRepo: InstallRepository, fs: EngineFsOps) {
    this.installRepo = installRepo;
    this.fs = fs;
  }

  apply(
    policyResult: PolicyResult,
    plan: RefinedInstallPlan,
    packageId: string,
    targetRoot: string,
    bootstrapId?: string,
  ): InstallResult {
    const install = this.installRepo.createInstall(packageId, targetRoot, "project_shared", bootstrapId);
    const applied: JournalEntry[] = [];
    const backupRoot = path.join(targetRoot, ".rigged-backups", install.id);

    try {
      for (const entry of policyResult.approved) {
        // Ensure target directory
        this.fs.mkdirp(path.dirname(entry.targetPath));

        // Backup existing file if it exists
        let backupPath: string | undefined;
        let beforeHash: string | undefined;
        if (this.fs.exists(entry.targetPath)) {
          const relativePath = path.relative(targetRoot, entry.targetPath);
          backupPath = path.join(backupRoot, relativePath);
          this.fs.mkdirp(path.dirname(backupPath));
          this.fs.copyFile(entry.targetPath, backupPath);
          beforeHash = hashContent(this.fs.readFile(entry.targetPath));
        }

        // Apply — guidance always uses managed-block merge (even for new files)
        if (entry.exportType === "guidance") {
          this.applyGuidanceMerge(entry, plan.packageName);
        } else if (entry.sourcePath) {
          // Copy source to target (skills, agents)
          this.fs.copyFile(entry.sourcePath, entry.targetPath);
        }

        const afterHash = this.fs.exists(entry.targetPath)
          ? hashContent(this.fs.readFile(entry.targetPath))
          : undefined;

        try {
          const journal = this.installRepo.createJournalEntry({
            installId: install.id,
            action: entry.classification === "managed_merge" ? "merge_block" : "copy",
            exportType: entry.exportType,
            classification: entry.classification,
            targetPath: entry.targetPath,
            backupPath,
            beforeHash,
            afterHash,
            status: "applied",
          });
          applied.push(journal);
        } catch (journalErr) {
          // Undo this entry's file mutation since it won't be in the rollback list
          try {
            if (backupPath && this.fs.exists(backupPath)) {
              this.fs.copyFile(backupPath, entry.targetPath);
            } else if (this.fs.exists(entry.targetPath)) {
              this.fs.deleteFile(entry.targetPath);
            }
          } catch { /* best-effort undo */ }
          throw journalErr;
        }
      }

      this.installRepo.updateInstallStatus(install.id, "applied");
    } catch (err) {
      // Compensating rollback on failure
      this.rollbackEntries(install.id, applied);
      this.installRepo.updateInstallStatus(install.id, "failed");
      throw err;
    }

    return {
      installId: install.id,
      applied,
      deferred: plan.deferred,
      conflicts: plan.conflicts,
    };
  }

  rollback(installId: string): RollbackResult {
    const entries = this.installRepo.getJournalEntries(installId);
    const applyEntries = entries.filter((e) => e.action !== "rollback");
    const { restored, deleted } = this.rollbackEntries(installId, applyEntries);
    this.installRepo.updateInstallStatus(installId, "rolled_back");
    return { installId, restored, deleted };
  }

  private rollbackEntries(
    installId: string,
    entries: JournalEntry[],
  ): { restored: string[]; deleted: string[] } {
    const restored: string[] = [];
    const deleted: string[] = [];

    // Reverse order for rollback
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.backupPath && this.fs.exists(entry.backupPath)) {
          // Restore from backup
          this.fs.mkdirp(path.dirname(entry.targetPath));
          this.fs.copyFile(entry.backupPath, entry.targetPath);
          restored.push(entry.targetPath);
        } else if (this.fs.exists(entry.targetPath)) {
          // No backup = new file, delete it
          this.fs.deleteFile(entry.targetPath);
          deleted.push(entry.targetPath);
        }

        // Journal the rollback action
        this.installRepo.createJournalEntry({
          installId,
          action: "rollback",
          exportType: entry.exportType,
          classification: entry.classification,
          targetPath: entry.targetPath,
          status: "rolled_back",
        });
      } catch {
        // Best-effort rollback — continue with remaining entries
      }
    }

    return { restored, deleted };
  }

  private applyGuidanceMerge(entry: InstallPlanEntry, packageName: string): void {
    if (!entry.sourcePath) return;

    const content = this.fs.readFile(entry.sourcePath);
    const block = `${BLOCK_START(packageName)}\n${content}\n${BLOCK_END(packageName)}`;

    if (this.fs.exists(entry.targetPath)) {
      const existing = this.fs.readFile(entry.targetPath);
      const startMarker = BLOCK_START(packageName);
      const endMarker = BLOCK_END(packageName);
      const startIdx = existing.indexOf(startMarker);
      const endIdx = existing.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        // Update existing block
        const updated = existing.slice(0, startIdx) + block + existing.slice(endIdx + endMarker.length);
        this.fs.writeFile(entry.targetPath, updated);
      } else {
        // Insert new block at end
        this.fs.writeFile(entry.targetPath, existing + "\n\n" + block + "\n");
      }
    } else {
      // New file
      this.fs.writeFile(entry.targetPath, block + "\n");
    }
  }
}
