import fs from "node:fs";
import path from "node:path";
import { classifyResourceProjection, hashContent } from "./conflict-detector.js";
import type { ProjectionClassification, ProjectionEntry, ProjectionPlan } from "./projection-planner.js";
import type { ProjectionManifestStore } from "./projection-manifest-store.js";
import type { NodeBinding, ResolvedStartupFile, RuntimeAdapter } from "./runtime-adapter.js";

interface PlannedCopy {
  sourcePath: string;
  targetPath: string;
  sourceHash: string;
  classification: ProjectionClassification;
  required: boolean;
}

export interface CwdPreparationPlan {
  plan: ProjectionPlan;
  files: ResolvedStartupFile[];
  copies: PlannedCopy[];
  conflicts: PlannedCopy[];
  warnings: string[];
}

/** Inspect standalone copies at their actual destinations before either adapter
 * writes. Managed guidance and native configuration merges retain adapter policy. */
export function planCwdPreparation(
  plan: ProjectionPlan, files: ResolvedStartupFile[], binding: NodeBinding,
  adapter: RuntimeAdapter, manifest: ProjectionManifestStore,
): CwdPreparationPlan {
  const copies: PlannedCopy[] = [];
  const warnings: string[] = [];
  const inspect = (sourcePath: string, targetPath: string, required = true): PlannedCopy => {
    const content = fs.readFileSync(sourcePath, "utf8");
    const classification = classifyResourceProjection(sourcePath, targetPath, "resource", undefined, {
      exists: fs.existsSync,
      readFile: file => file === sourcePath ? content : fs.readFileSync(file, "utf8"),
    }, target => manifest.lastHash(target));
    return { sourcePath, targetPath, sourceHash: hashContent(content), classification, required };
  };

  const entries = plan.entries.map(entry => {
    const targetDir = projectionCopyDirectory(entry, plan.runtime, binding, adapter);
    if (!targetDir) return { ...entry };
    const entryCopies = copyFiles(entry.absolutePath, targetDir).map(([source, target]) => inspect(source, target));
    copies.push(...entryCopies);
    const classification = entryCopies.find(copy => copy.classification === "operator_conflict")?.classification
      ?? entryCopies.find(copy => copy.classification === "hash_conflict")?.classification
      ?? (entryCopies.length && entryCopies.every(copy => copy.classification === "no_op") ? "no_op" : "safe_projection");
    return { ...entry, classification };
  });

  const deliverable: ResolvedStartupFile[] = [];
  for (const file of files) {
    // Terminal startup delivery deliberately writes no filesystem resources.
    if (file.deliveryHint === "skill_install" && plan.runtime !== "terminal") {
      try {
        const targetDir = skillDirectory(plan.runtime, binding, adapter, path.basename(path.dirname(file.absolutePath)));
        if (!targetDir) throw new Error(`No skill destination for runtime ${plan.runtime}`);
        const copy = inspect(file.absolutePath, path.join(targetDir, path.basename(file.path)), file.required);
        copies.push(copy);
        // Some adapters record every startup write. Do not turn an identical
        // operator-owned file into an OpenRig-owned projection by replaying it.
        if (copy.classification === "no_op") continue;
      } catch (error) {
        if (file.required) throw error;
        warnings.push(`Startup file ${file.path} was skipped: ${(error as Error).message}`);
        continue;
      }
    }
    deliverable.push(file);
  }

  const conflicts = copies.filter(copy => copy.classification === "operator_conflict" || copy.classification === "hash_conflict");
  // Two different sources cannot both be the prepared bytes of one target.
  const selected = new Map<string, PlannedCopy>();
  for (const copy of copies) {
    const earlier = selected.get(copy.targetPath);
    if (earlier && earlier.sourceHash !== copy.sourceHash && !conflicts.includes(copy)) conflicts.push(copy);
    selected.set(copy.targetPath, copy);
  }
  return {
    plan: { ...plan, cwd: binding.cwd, entries,
      conflicts: entries.filter(entry => entry.classification === "operator_conflict" || entry.classification === "hash_conflict"),
      noOps: entries.filter(entry => entry.classification === "no_op") },
    files: deliverable, copies, conflicts, warnings,
  };
}

/** Record only verified writes. An identical pre-existing file is not evidence
 * that OpenRig owns it, so a no-op must not acquire a projection manifest entry. */
export function recordCwdPreparation(preparation: CwdPreparationPlan, manifest: ProjectionManifestStore): string[] {
  const warnings: string[] = [];
  const writtenAt = new Date().toISOString();
  for (const copy of preparation.copies) {
    try {
      if (hashContent(fs.readFileSync(copy.targetPath, "utf8")) !== copy.sourceHash) {
        throw new Error(`Prepared content changed or was not written: ${copy.targetPath}`);
      }
      if (copy.classification === "safe_projection" || copy.classification === "stale_overwrite") {
        manifest.record({ targetPath: copy.targetPath, lastHash: copy.sourceHash, writtenAt });
      }
    } catch (error) {
      if (copy.required) throw error;
      warnings.push(`Optional startup copy ${copy.targetPath}: ${(error as Error).message}`);
    }
  }
  return warnings;
}

function skillDirectory(runtime: string, binding: NodeBinding, adapter: RuntimeAdapter, id: string): string | null {
  if (adapter.skillTargetPath) {
    const representative = adapter.skillTargetPath(binding.tmuxSession, id);
    return representative ? path.dirname(representative) : null;
  }
  if (runtime === "claude-code") return path.join(binding.cwd, ".claude", "skills", id);
  if (runtime === "codex") return path.join(binding.cwd, ".agents", "skills", id);
  if (runtime === "stub") return path.join(binding.cwd, ".openrig", "stub", "skills", id);
  return null;
}

function projectionCopyDirectory(entry: ProjectionEntry, runtime: string, binding: NodeBinding, adapter: RuntimeAdapter): string | null {
  if (entry.category === "guidance") return null;
  if (entry.category === "skill") return skillDirectory(runtime, binding, adapter, entry.effectiveId);
  if (runtime !== "claude-code" && runtime !== "codex") return null;
  if (entry.category === "subagent") return path.join(binding.cwd, runtime === "claude-code" ? ".claude/agents" : ".agents");
  if (entry.category === "plugin") {
    const pluginRuntime = runtime === "claude-code" ? "claude" : "codex";
    if (entry.pluginType && entry.pluginType !== "auto" && entry.pluginType !== pluginRuntime) return null;
    if ((!entry.pluginType || entry.pluginType === "auto")
      && !fs.existsSync(path.join(entry.absolutePath, `.${pluginRuntime}-plugin`, "plugin.json"))) return null;
    return path.join(binding.cwd, runtime === "claude-code" ? ".claude" : ".codex", "plugins", entry.effectiveId);
  }
  if (entry.category === "runtime_resource") {
    const merged = runtime === "claude-code"
      ? ["claude_settings_fragment", "claude_mcp_fragment", "claude_activity_hooks"] : ["codex_config_fragment"];
    if (merged.includes(entry.resourceType ?? "")) return null;
    return path.join(binding.cwd, runtime === "claude-code" ? ".claude" : ".agents", "extensions", entry.effectiveId);
  }
  return null;
}

/** Inspect every file in a directory projection, including nested helpers. */
function copyFiles(source: string, targetDir: string, ancestors = new Set<string>()): Array<[string, string]> {
  if (!fs.statSync(source).isDirectory()) return [[source, path.join(targetDir, path.basename(source))]];
  const realSource = fs.realpathSync(source);
  if (ancestors.has(realSource)) throw new Error(`Cyclic startup resource directory: ${source}`);
  const parents = new Set(ancestors).add(realSource);
  return fs.readdirSync(source).flatMap(name => {
    const child = path.join(source, name);
    // Match the adapters' Dirent walk: directory symlinks remain file-shaped
    // and fail the preflight read before any startup files are written.
    return fs.lstatSync(child).isDirectory()
      ? copyFiles(child, path.join(targetDir, name), parents)
      : [[child, path.join(targetDir, name)] as [string, string]];
  });
}
