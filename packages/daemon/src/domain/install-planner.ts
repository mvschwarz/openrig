import path from "node:path";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";
import { resolveExports, type ResolvedExports, type DeferredExport } from "./role-resolver.js";

// --- Types ---

export type ActionClassification =
  | "safe_projection"
  | "managed_merge"
  | "config_mutation"
  | "external_install"
  | "manual_only";

export interface ConflictInfo {
  existingPath: string;
  existingHash?: string;
  sourceHash?: string;
  reason: string;
}

export interface InstallPlanEntry {
  exportType: string;
  exportName: string;
  classification: ActionClassification;
  targetPath: string;
  scope: string;
  sourcePath?: string; // Absent for requirements (no source file)
  conflict?: ConflictInfo;
  deferred: boolean;
  deferReason?: string;
}

export interface InstallPlan {
  packageId?: string; // Set by caller when persisting to DB
  packageName: string;
  packageVersion: string;
  sourceRef: string;
  entries: InstallPlanEntry[];
  actionable: InstallPlanEntry[];
  deferred: InstallPlanEntry[];
  conflicts: InstallPlanEntry[];
}

export interface PlanOptions {
  roleName?: string;
}

// --- Planner ---

export class InstallPlanner {
  private fs: FsOps;

  constructor(fs: FsOps) {
    this.fs = fs;
  }

  plan(
    resolved: ResolvedPackage,
    targetRoot: string,
    runtime: "claude-code" | "codex",
    options?: PlanOptions,
  ): InstallPlan {
    const exports = resolveExports(resolved.manifest, options?.roleName);
    const entries: InstallPlanEntry[] = [];

    // Plan skills
    for (const skill of exports.skills) {
      const targetPath = runtime === "claude-code"
        ? path.join(targetRoot, ".claude", "skills", skill.name, "SKILL.md")
        : path.join(targetRoot, ".agents", "skills", skill.name, "SKILL.md");

      const exists = this.fs.exists(targetPath);
      const entry: InstallPlanEntry = {
        exportType: "skill",
        exportName: skill.name,
        classification: "safe_projection",
        targetPath,
        sourcePath: path.join(resolved.sourceRef, skill.source, "SKILL.md"),
        scope: "project_shared",
        deferred: false,
      };

      if (exists) {
        entry.conflict = {
          existingPath: targetPath,
          reason: `Skill '${skill.name}' already exists at target`,
        };
      }

      entries.push(entry);
    }

    // Plan guidance
    for (const g of exports.guidance) {
      // Runtime/guidance kind mismatch → defer
      if (g.kind === "agents_md" && runtime === "claude-code") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: "agents_md guidance not applicable to claude-code",
        });
        continue;
      }
      if (g.kind === "claude_md" && runtime === "codex") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: "claude_md guidance not applicable to codex",
        });
        continue;
      }

      // generic_rules_overlay → defer
      if (g.kind === "generic_rules_overlay") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: "generic_rules_overlay not supported in Phase 4",
        });
        continue;
      }

      // replace/manual strategy → defer
      if (g.mergeStrategy === "replace" || g.mergeStrategy === "manual") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "manual_only",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `${g.mergeStrategy} merge not supported in Phase 4`,
        });
        continue;
      }

      // Determine target path
      const targetFile = g.kind === "agents_md" ? "AGENTS.md" : "CLAUDE.md";
      const targetPath = path.join(targetRoot, targetFile);
      const exists = this.fs.exists(targetPath);

      entries.push({
        exportType: "guidance",
        exportName: g.name,
        classification: exists ? "managed_merge" : "safe_projection",
        targetPath,
        sourcePath: path.join(resolved.sourceRef, g.source),
        scope: "project_shared",
        deferred: false,
      });
    }

    // Plan agents (single YAML files, not directories)
    for (const agent of exports.agents) {
      const agentName = agent.name ?? path.basename(agent.source, path.extname(agent.source));
      const targetPath = runtime === "claude-code"
        ? path.join(targetRoot, ".claude", "agents", `${agentName}.yaml`)
        : path.join(targetRoot, ".agents", `${agentName}.yaml`);

      const exists = this.fs.exists(targetPath);
      const entry: InstallPlanEntry = {
        exportType: "agent",
        exportName: agentName,
        classification: "safe_projection",
        targetPath,
        sourcePath: path.join(resolved.sourceRef, agent.source),
        scope: "project_shared",
        deferred: false,
      };

      if (exists) {
        entry.conflict = {
          existingPath: targetPath,
          reason: `Agent '${agentName}' already exists at target`,
        };
      }

      entries.push(entry);
    }

    // Plan deferred (hooks, mcp from role resolver)
    for (const d of exports.deferred) {
      entries.push({
        exportType: d.exportType,
        exportName: d.source,
        classification: "config_mutation",
        targetPath: "",
        scope: "project_shared",
        deferred: true,
        deferReason: d.reason,
      });
    }

    // Plan requirements as deferred
    if (resolved.manifest.requirements?.cliTools) {
      for (const tool of resolved.manifest.requirements.cliTools) {
        entries.push({
          exportType: "requirement",
          exportName: tool.name,
          classification: "external_install",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `CLI tool '${tool.name}' requires external install (Phase 5)`,
        });
      }
    }
    if (resolved.manifest.requirements?.systemPackages) {
      for (const pkg of resolved.manifest.requirements.systemPackages) {
        entries.push({
          exportType: "requirement",
          exportName: pkg.name,
          classification: "external_install",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `System package '${pkg.name}' requires external install (Phase 5)`,
        });
      }
    }

    // Split into categories
    const actionable = entries.filter((e) => !e.deferred && !e.conflict);
    const deferred = entries.filter((e) => e.deferred);
    const conflicts = entries.filter((e) => !!e.conflict && !e.deferred);

    return {
      // packageId is undefined until caller persists to DB
      packageName: resolved.manifest.name,
      packageVersion: resolved.manifest.version,
      sourceRef: resolved.sourceRef,
      entries,
      actionable,
      deferred,
      conflicts,
    };
  }
}
