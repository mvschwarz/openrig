import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import type { AgentSpec, Node, RigSpec, RigSpecPod, RigSpecPodMember, StartupAction } from "./types.js";
import type { NodeBinding, ResolvedStartupFile, RuntimeAdapter } from "./runtime-adapter.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import type { ParsedStartupContext } from "./seat-lifecycle-service.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig, selectedPluginPaths, type ResolutionContext } from "./profile-resolver.js";
import { claudeConflictTargetPath, filterProtectedProjections, planProjection, projectionConflictWarnings, type ProjectionPlan } from "./projection-planner.js";
import { ProjectionManifestStore } from "./projection-manifest-store.js";
import { isKeptPluginSkill, reconcileSkillLoadout, type SkillLoadout } from "./skill-catalog.js";
import { reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import { ensureSeatSkillPlugin, seatCatalogKeptNote, seatSkillLocation, seatSkillPaths, writeSeatSkillCatalog, type SeatSkillPaths } from "./seat-skill-storage.js";
import { seatSkillsPointerStartupFile } from "./seat-skills-pointer.js";
import { readSeatEffort } from "./seat-effort.js";
import type { ClaudeManagedBlockFile } from "./managed-blocks.js";

export type SwitchRuntime = "codex" | "claude-code";

/** Where an effective target setting came from. `native_default` means OpenRig passes no flag. */
export type RuntimeSwitchSettingSource = "explicit" | "agent_spec" | "native_default";
export interface RuntimeSwitchSetting { value: string | null; source: RuntimeSwitchSettingSource }
export interface RuntimeSwitchSettings {
  model: RuntimeSwitchSetting;
  effort: RuntimeSwitchSetting;
  advisor: RuntimeSwitchSetting;
  codexConfigProfile: RuntimeSwitchSetting;
}

export interface RuntimeSwitchMaterials {
  settings: RuntimeSwitchSettings;
  /** Source-runtime settings the switch clears instead of mapping. */
  dropped: Array<{ setting: string; value: string }>;
  /** The seat's own agent spec, re-resolved for the target; null for a seat launched without one. */
  resolvedSpec: { name: string; version: string; hash: string; restorePolicy: string } | null;
  plan: ProjectionPlan;
  files: ResolvedStartupFile[];
  actions: StartupAction[];
  seatSkills: SeatSkillPaths;
  /** Plugin paths the target's resolved spec selects (what decides its openrig-core plugin, as at launch). */
  pluginPaths: string[];
  /** Startup text the successor reads as part of its first turn (its identity first, then send_text files and actions). */
  firstTurn: string;
  /** Startup slash commands a switch does not run, named in the preview. */
  notRun: string[];
  warnings: string[];
  /** Writes the target's seat storage, projects its materials and delivers its pre-launch files. Returns notes. */
  prepare(binding: NodeBinding, adapter: RuntimeAdapter): Promise<string[]>;
  bindingAdditions(): Pick<NodeBinding, "seatSkillsRoot" | "claudeManagedBlockFile">;
}

export interface RuntimeSwitchMaterialsInput {
  db: Database.Database;
  node: Node;
  rigName: string;
  canonicalSession: string;
  runtime: SwitchRuntime;
  explicit: { model?: string; effort?: string; codexConfigProfile?: string };
  saved: ParsedStartupContext | null;
  claudeManagedBlockFile?: ClaudeManagedBlockFile;
  resolution?: Pick<ResolutionContext, "skillsRoot" | "systemSkills" | "systemWorldError" | "homedir">;
  fsOps?: AgentResolverFsOps;
  openrigHome?: string;
}

const IDENTITY_RUNTIME_LINE = /^- runtime: .*$/m;

/**
 * Plan the target runtime's launch as if the seat had been declared on it: explicit options first, then the seat's own
 * agent spec resolved for the target, otherwise the target's native default. Source-runtime settings are cleared and
 * listed, never mapped. Planning reads only; `prepare` writes, and only into the target runtime's own seat storage and
 * projection targets (the predecessor's storage is keyed by its runtime and is not touched). Throws a message that
 * names what is missing when the target can't be planned.
 */
export function planRuntimeSwitchMaterials(input: RuntimeSwitchMaterialsInput): RuntimeSwitchMaterials {
  const fsOps = input.fsOps ?? { exists: existsSync, readFile: (file: string) => readFileSync(file, "utf8") };
  const { node, runtime } = input;
  const cwd = node.cwd!;
  const warnings: string[] = [];
  const seatSkills = seatSkillPaths({ rigId: node.rigId, logicalId: node.logicalId, runtime }, input.openrigHome);
  const emptyPlan: ProjectionPlan = { runtime, cwd, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
  let plan = emptyPlan;
  let resolvedSpec: RuntimeSwitchMaterials["resolvedSpec"] = null;
  let specModel: string | undefined;
  let specEffort: string | undefined;
  let specAdvisor: string | undefined;
  let otherRuntimeSpecSettings: RuntimeSwitchMaterials["dropped"] = [];
  let skillLoadout: SkillLoadout | undefined;
  let pluginPaths: string[] = [];

  if (node.agentRef) {
    if (!input.saved) throw new Error("The seat's saved startup context is missing, so its materials can't be planned for the target runtime.");
    const source = findAgentSource(node, input.saved, fsOps);
    const member: RigSpecPodMember = {
      id: node.logicalId.split(".").at(-1)!, agentRef: node.agentRef, profile: node.profile ?? "default", runtime, cwd,
      ...(input.explicit.model ? { model: input.explicit.model } : {}),
      ...(input.explicit.effort ? { effort: input.explicit.effort } : {}),
    };
    const pod: RigSpecPod = { id: node.logicalId.split(".")[0]!, label: node.logicalId.split(".")[0]!, members: [member], edges: [] };
    const rig: RigSpec = { version: "0.2", name: input.rigName, pods: [pod], edges: [] };
    const resolved = resolveNodeConfig({ baseSpec: source.resolved, importedSpecs: source.imports, collisions: source.collisions,
      profileName: member.profile, specRoot: source.resolved.sourcePath, member, pod, rig, ...input.resolution });
    if (!resolved.ok) throw new Error(`The seat's agent spec doesn't resolve for ${runtime}: ${resolved.errors.join("; ")}`);
    const config = resolved.config;
    resolvedSpec = { name: config.resolvedSpecName, version: config.resolvedSpecVersion, hash: config.resolvedSpecHash, restorePolicy: config.restorePolicy };
    const declared = specSettingsForRuntime(source.resolved.spec, member.profile, runtime);
    specModel = declared.model;
    specEffort = declared.effort;
    otherRuntimeSpecSettings = declared.skipped;
    specAdvisor = config.advisor;
    skillLoadout = config.skillLoadout;
    pluginPaths = selectedPluginPaths(config.selectedResources);
    warnings.push(...(config.skillWarnings ?? []));
    const manifests = new ProjectionManifestStore(input.db);
    const projected = planProjection({ config, collisions: source.collisions, fsOps,
      // The instantiator's targets for the same runtime, with the target's own seat storage for skills.
      resolveTargetPath: (category, effectiveId, root, sourcePath) => category === "skill"
        ? nodePath.join(seatSkills.skillsRoot, effectiveId, "SKILL.md")
        : claudeConflictTargetPath(category, effectiveId, root, sourcePath, runtime === "claude-code" ? input.claudeManagedBlockFile : undefined),
      lastHashLookup: (file) => manifests.lastHash(file) });
    if (!projected.ok) throw new Error(`The seat's materials can't be planned for ${runtime}: ${projected.errors.join("; ")}`);
    plan = projected.plan;
    warnings.push(...projectionConflictWarnings(plan));
    // As at launch: an operator-edited skill target is protected, not overwritten.
    if (runtime === "codex") plan.entries = plan.entries.filter((entry) => entry.category !== "skill" || entry.classification !== "operator_conflict");
  } else if (input.saved?.plan.entries.length) {
    throw new Error("This seat has saved projections but no agent spec to resolve them from, so its materials can't be planned for the target runtime.");
  }

  const settings = resolveSettings(input.explicit, runtime, { model: specModel, effort: specEffort, advisor: specAdvisor });
  const dropped = [...droppedSourceSettings(input.db, node), ...otherRuntimeSpecSettings];

  // Saved startup files are runtime-neutral except the seat-skills pointer and a Codex seat's catalog; those are rebuilt
  // for the target. Managed guidance the target projects isn't also delivered as a file (the launch's own rule).
  const sourceSeat = node.runtime === "codex" || node.runtime === "claude-code"
    ? seatSkillPaths({ rigId: node.rigId, logicalId: node.logicalId, runtime: node.runtime }, input.openrigHome) : undefined;
  const pointer = seatSkillsPointerStartupFile();
  const projectedGuidance = new Set(plan.entries
    .filter((entry) => entry.category === "guidance" && entry.mergeStrategy === "managed_block").map((entry) => entry.absolutePath));
  const neutral = (input.saved?.resolvedStartupFiles ?? []).filter((file) => file.absolutePath !== pointer.absolutePath
    && file.absolutePath !== sourceSeat?.catalogPath && !(file.deliveryHint === "guidance_merge" && projectedGuidance.has(file.absolutePath)));
  const delivered = filterProtectedProjections(neutral, plan).delivered;
  const files: ResolvedStartupFile[] = [...delivered, pointer, ...(runtime === "codex" ? [{
    path: "openrig-seat-skills.md", absolutePath: seatSkills.catalogPath, ownerRoot: seatSkills.root,
    deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start", "restore"] as ("fresh_start" | "restore")[],
  }] : [])];

  const actions = (input.saved?.startupActions ?? []).map((action) => action.builtin === "session_identity" && IDENTITY_RUNTIME_LINE.test(action.value)
    ? { ...action, value: action.value.replace(IDENTITY_RUNTIME_LINE, `- runtime: ${runtime}`) } : action);
  const identity = actions.find((action) => action.builtin === "session_identity");
  const firstTurn: string[] = identity ? [identity.value] : [];
  const notRun: string[] = [];
  const preLaunch: ResolvedStartupFile[] = [];
  const postLaunch: ResolvedStartupFile[] = [];
  for (const file of files) {
    if (!file.appliesOn.includes("fresh_start")) continue;
    // The Codex catalog is written by `prepare`; it is read then, not now.
    if (file.absolutePath === seatSkills.catalogPath) { postLaunch.push(file); continue; }
    if (!fsOps.exists(file.absolutePath)) {
      if (file.required) throw new Error(`A required startup file is missing: ${file.absolutePath}`);
      continue;
    }
    const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, fsOps.readFile(file.absolutePath), file.orientation) : file.deliveryHint;
    (hint === "send_text" ? postLaunch : preLaunch).push({ ...file, deliveryHint: hint });
  }
  for (const action of actions) {
    if (action === identity || !action.appliesOn.includes("fresh_start")) continue;
    if (action.type === "send_text") firstTurn.push(action.value);
    else if (action.type === "slash_command") notRun.push(action.value);
  }

  return {
    settings, dropped, resolvedSpec, plan, files, actions, seatSkills, pluginPaths, notRun, warnings,
    get firstTurn() {
      const texts = postLaunch.flatMap((file) => {
        try { return [`--- Seat material: ${file.path} ---\n${fsOps.readFile(file.absolutePath)}`]; }
        catch { return []; }
      });
      return [...firstTurn, ...texts].join("\n\n");
    },
    bindingAdditions: () => ({
      seatSkillsRoot: seatSkills.skillsRoot,
      ...(runtime === "claude-code" && input.claudeManagedBlockFile ? { claudeManagedBlockFile: input.claudeManagedBlockFile } : {}),
    }),
    async prepare(binding, adapter) {
      const notes: string[] = [];
      if (runtime === "claude-code") notes.push(...ensureSeatSkillPlugin(seatSkills));
      if (skillLoadout) {
        const reconcile = (selected: SkillLoadout) => reconcileSkillLoadout({ loadout: selected, runtime, cwd, apply: true,
          topologyOwner: input.canonicalSession, location: seatSkillLocation(seatSkills, runtime) });
        let projection = reconcile(skillLoadout);
        // As at launch: plugin skills that can't be projected don't stop the seat; it starts without them and says why.
        if (!projection.ok && skillLoadout.entries.some((entry) => entry.pluginId)) {
          const withoutPlugins = reconcile({ ...skillLoadout, entries: skillLoadout.entries.filter((entry) => !entry.pluginId) });
          if (withoutPlugins.ok) {
            notes.push(`plugin_skills_not_projected: ${projection.errors.map((error) => `${error.code}: ${error.message}`).join("; ")}`);
            projection = withoutPlugins;
          }
        }
        if (!projection.ok) throw new Error(projection.errors.map((error) => `${error.code}: ${error.message}`).join("; "));
        for (const receipt of projection.receipts.filter(isKeptPluginSkill)) notes.push(`plugin_skill_kept: ${receipt.id} (${receipt.target})`);
      }
      const projected = await adapter.project(plan, binding);
      if (projected.failed.length) throw new Error(projected.failed.map((failure) => `${failure.effectiveId}: ${failure.error}`).join("; "));
      if (runtime === "codex") {
        const catalog = writeSeatSkillCatalog(seatSkills);
        if (catalog.kept) notes.push(seatCatalogKeptNote(catalog));
      }
      const delivered = await adapter.deliverStartup(preLaunch, binding);
      if (delivered.failed.length) throw new Error(delivered.failed.map((failure) => `${failure.path}: ${failure.error}`).join("; "));
      return notes;
    },
  };
}

function findAgentSource(node: Node, saved: ParsedStartupContext, fsOps: AgentResolverFsOps) {
  // The rig root isn't recorded, so the agent spec is found where the saved launch read it from.
  const candidates = new Set<string>();
  if (node.agentRef?.startsWith("path:")) candidates.add(node.agentRef.slice("path:".length));
  for (const entry of saved.plan.entries) candidates.add(reanchorShippedProjectionEntry(entry).sourcePath);
  for (const file of saved.resolvedStartupFiles) candidates.add(file.ownerRoot);
  const sources = [...candidates]
    .filter((root) => nodePath.isAbsolute(root) && fsOps.exists(nodePath.join(root, "agent.yaml")))
    .map((root) => resolveAgentRef(`path:${root}`, root, fsOps))
    .flatMap((result) => result.ok && result.resolved.spec.name === node.resolvedSpecName ? [result] : []);
  const unique = new Map(sources.map((source) => [source.resolved.sourcePath, source]));
  if (unique.size !== 1) {
    throw new Error(unique.size === 0
      ? `The seat's agent spec (${node.resolvedSpecName ?? node.agentRef}) wasn't found where its last launch read it.`
      : `The seat's agent spec (${node.resolvedSpecName}) was found in more than one place: ${[...unique.keys()].join(", ")}.`);
  }
  return [...unique.values()][0]!;
}

/**
 * The spec's model and effort for the target, where the spec declared them for it. A profile preference belongs to the
 * profile's runtime (or the spec's), a spec default to the spec's runtime; one declared for another runtime doesn't
 * reach the target and is listed as dropped. The rule is #1214's (Aschenbath), applied to this operation only: ordinary
 * resolution is unchanged.
 */
function specSettingsForRuntime(spec: AgentSpec, profileName: string, runtime: SwitchRuntime) {
  const preferences = spec.profiles[profileName]?.preferences;
  const profileRuntime = preferences?.runtime ?? spec.defaults?.runtime;
  const layers = [
    { runtime: profileRuntime, values: preferences, label: `profile ${profileName}` },
    { runtime: spec.defaults?.runtime, values: spec.defaults, label: "spec defaults" },
  ];
  const skipped: RuntimeSwitchMaterials["dropped"] = [];
  const pick = (key: "model" | "effort") => {
    for (const layer of layers) {
      const value = layer.values?.[key]?.trim();
      if (!value) continue;
      if (!layer.runtime || layer.runtime === runtime) return value;
      skipped.push({ setting: `${key} (agent spec, ${layer.label}, declared for ${layer.runtime})`, value });
    }
    return undefined;
  };
  return { model: pick("model"), effort: pick("effort"), skipped };
}

function resolveSettings(
  explicit: RuntimeSwitchMaterialsInput["explicit"],
  runtime: SwitchRuntime,
  spec: { model?: string; effort?: string; advisor?: string },
): RuntimeSwitchSettings {
  const pick = (given: string | undefined, fromSpec: string | undefined): RuntimeSwitchSetting => given
    ? { value: given, source: "explicit" } : fromSpec ? { value: fromSpec, source: "agent_spec" } : { value: null, source: "native_default" };
  return {
    model: pick(explicit.model, spec.model),
    effort: pick(explicit.effort, spec.effort),
    // Advisor is Claude's; a Codex successor launches without one.
    advisor: runtime === "claude-code" ? pick(undefined, spec.advisor) : { value: null, source: "native_default" },
    codexConfigProfile: runtime === "codex" ? pick(explicit.codexConfigProfile, undefined) : { value: null, source: "native_default" },
  };
}

function droppedSourceSettings(db: Database.Database, node: Node): RuntimeSwitchMaterials["dropped"] {
  const dropped: RuntimeSwitchMaterials["dropped"] = [];
  const effort = readSeatEffort(db, node.id);
  if (node.model) dropped.push({ setting: "model", value: node.model });
  if (effort?.choice) dropped.push({ setting: "effort choice (rig seat set-effort)", value: effort.choice });
  if (effort?.authored) dropped.push({ setting: "effort", value: effort.authored });
  if (node.advisor) dropped.push({ setting: "advisor", value: node.advisor });
  if (node.codexConfigProfile) dropped.push({ setting: "codex config profile", value: node.codexConfigProfile });
  return dropped;
}
