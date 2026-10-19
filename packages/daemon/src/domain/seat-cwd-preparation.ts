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
  /** Destination files set-cwd's preflight policy protects: operator-edited, unrecorded with different content, or
   *  claimed by two different sources. (Launch itself overwrites an unrecorded differing file with a warning.) */
  conflicts: PlannedCopy[];
  warnings: string[];
}

/** Read-only: inspect the copies the seat's next launch would make, at their actual destinations in the new
 * directory, without writing anything. Launch writes the startup files as it does today. Managed guidance and native
 * configuration merges keep the adapter's own policy, so they aren't inspected here. */
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

  for (const entry of plan.entries) {
    const targetDir = projectionCopyDirectory(entry, plan.runtime, binding, adapter);
    if (targetDir) copies.push(...copyFiles(entry.absolutePath, targetDir).map(([source, target]) => inspect(source, target)));
  }

  for (const file of files) {
    // Terminal startup delivery deliberately writes no filesystem resources.
    if (file.deliveryHint !== "skill_install" || plan.runtime === "terminal") continue;
    try {
      const targetDir = skillDirectory(plan.runtime, binding, adapter, path.basename(path.dirname(file.absolutePath)));
      if (!targetDir) throw new Error(`No skill destination for runtime ${plan.runtime}`);
      copies.push(inspect(file.absolutePath, path.join(targetDir, path.basename(file.path)), file.required));
    } catch (error) {
      if (file.required) throw error;
      warnings.push(`Startup file ${file.path} couldn't be checked: ${(error as Error).message}`);
    }
  }

  const conflicts = copies.filter(copy => copy.classification === "operator_conflict" || copy.classification === "hash_conflict");
  // Two different sources cannot both be the prepared bytes of one target.
  const selected = new Map<string, PlannedCopy>();
  for (const copy of copies) {
    const earlier = selected.get(copy.targetPath);
    if (earlier && earlier.sourceHash !== copy.sourceHash && !conflicts.includes(copy)) conflicts.push(copy);
    selected.set(copy.targetPath, copy);
  }
  return { conflicts, warnings };
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
