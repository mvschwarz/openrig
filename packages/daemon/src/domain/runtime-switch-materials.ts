import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Node, RigSpec, RigSpecPod, RigSpecPodMember, StartupAction } from "./types.js";
import type { NodeBinding, RuntimeAdapter, ResolvedStartupFile } from "./runtime-adapter.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import type { ParsedStartupContext } from "./seat-lifecycle-service.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig, type ResolutionContext } from "./profile-resolver.js";
import { planProjection, claudeConflictTargetPath, type ProjectionPlan } from "./projection-planner.js";
import { ProjectionManifestStore } from "./projection-manifest-store.js";
import { reconcileSkillLoadout } from "./skill-catalog.js";
import { reanchorShippedProjectionEntry } from "./builtin-startup-files.js";

export interface RuntimeSwitchMaterials {
  plan: ProjectionPlan;
  files: ResolvedStartupFile[];
  actions: StartupAction[];
  model: string | null;
  effort: string | null;
  context: string;
  prepare(binding: NodeBinding, adapter: RuntimeAdapter): Promise<void>;
}

/** Re-resolve the same role/profile for the target runtime. Saved projection
 * entries are already runtime-filtered and cannot simply be replayed: a Codex
 * seat's saved plan does not contain the Claude settings/hooks at all. */
export function planRuntimeSwitchMaterials(input: {
  db: Database.Database; node: Node; rigName: string; session: string; runtime: "codex" | "claude-code";
  saved: ParsedStartupContext | null; model?: string; effort?: string;
  claudeManagedBlockFile?: NodeBinding["claudeManagedBlockFile"];
  materialContext?: Pick<ResolutionContext, "skillsRoot" | "systemSkills" | "systemWorldError" | "homedir">;
  fsOps?: AgentResolverFsOps;
}): RuntimeSwitchMaterials {
  const fsOps = input.fsOps ?? { exists: existsSync, readFile: (file: string) => readFileSync(file, "utf8") };
  const cwd = input.node.cwd!;
  let plan: ProjectionPlan = { runtime: input.runtime, cwd, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
  let skillLoadout: import("./skill-catalog.js").SkillLoadout | undefined;
  let model = input.model ?? null;
  let effort = input.effort ?? null;
  if (input.node.agentRef) {
    if (!input.saved) throw new Error("The seat's saved startup context is missing; restore its managed materials before switching runtimes.");
    const candidates = new Set<string>();
    if (input.node.agentRef.startsWith("path:")) {
      const root = input.node.agentRef.slice(5);
      candidates.add(reanchorShippedProjectionEntry({ sourcePath: root, absolutePath: path.join(root, "agent.yaml") }).sourcePath);
    }
    for (const entry of input.saved.plan.entries) candidates.add(entry.sourcePath);
    for (const file of input.saved.resolvedStartupFiles) candidates.add(file.ownerRoot);
    const sources = [...candidates].filter(root => path.isAbsolute(root) && fsOps.exists(path.join(root, "agent.yaml")))
      .map(root => resolveAgentRef(`path:${root}`, root, fsOps))
      .filter(result => result.ok && result.resolved.spec.name === input.node.resolvedSpecName);
    if (sources.length !== 1 || !sources[0]!.ok) {
      throw new Error("The seat's saved agent source is missing or ambiguous. Restore its agent.yaml and imports before switching runtimes.");
    }
    const source = sources[0]!;
    const member: RigSpecPodMember = { id: input.node.logicalId, agentRef: input.node.agentRef, profile: input.node.profile ?? "default",
      runtime: input.runtime, cwd, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) };
    const pod: RigSpecPod = { id: "seat", label: "seat", members: [member], edges: [] };
    const rig: RigSpec = { version: "0.2", name: input.rigName, pods: [pod], edges: [] };
    const resolved = resolveNodeConfig({ baseSpec: source.resolved, importedSpecs: source.imports, collisions: source.collisions,
      profileName: member.profile, specRoot: source.resolved.sourcePath, member, pod, rig, ...input.materialContext });
    if (!resolved.ok) throw new Error(resolved.errors.join("; "));
    model = resolved.config.model ?? null;
    effort = resolved.config.effort ?? null;
    skillLoadout = resolved.config.skillLoadout;
    const manifests = new ProjectionManifestStore(input.db);
    const projection = planProjection({ config: resolved.config, collisions: source.collisions, fsOps,
      resolveTargetPath: (category, id, root, file) => input.runtime === "codex"
        ? category === "skill" ? path.join(root, ".agents", "skills", id, "SKILL.md") : category === "guidance" ? path.join(root, "AGENTS.md") : null
        : claudeConflictTargetPath(category, id, root, file, input.claudeManagedBlockFile),
      lastHashLookup: file => manifests.lastHash(file) });
    if (!projection.ok) throw new Error(projection.errors.join("; "));
    plan = projection.plan;
    // A migration must not overwrite a different target-runtime skill or
    // subagent that the operator already installed in this workspace.
    const conflicts = plan.conflicts.filter(entry => entry.classification === "operator_conflict" || entry.classification === "hash_conflict");
    if (conflicts.length) throw new Error(`Target material conflicts: ${conflicts.map(entry => entry.effectiveId).join(", ")}. Resolve them before switching.`);
  } else if (input.saved?.plan.entries.length) {
    throw new Error("This seat has saved projections but no resolvable agent source; target-runtime materials cannot be inferred.");
  }

  const files = input.saved?.resolvedStartupFiles ?? [];
  const preLaunch: ResolvedStartupFile[] = [];
  const context: string[] = [];
  for (const file of files.filter(file => file.appliesOn.includes("fresh_start"))) {
    if (!fsOps.exists(file.absolutePath)) {
      if (file.required) throw new Error(`Required startup file is missing: ${file.absolutePath}`);
      continue;
    }
    const content = fsOps.readFile(file.absolutePath);
    const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
    if (hint === "send_text") context.push(`--- Seat material: ${file.path} ---\n${content}`);
    else preLaunch.push({ ...file, deliveryHint: hint });
  }
  const actions = (input.saved?.startupActions ?? []).map(action => action.builtin === "session_identity"
    ? { ...action, value: `You are ${input.session}, running ${input.runtime}. Your durable node id is ${input.node.id}. Use rig whoami and rig queue list --owned to recover current seat responsibility.` }
    : action);
  return { plan, files, actions, model, effort, context: context.join("\n\n"),
    async prepare(binding, adapter) {
      if (skillLoadout) {
        const projected = reconcileSkillLoadout({ loadout: skillLoadout, runtime: input.runtime, cwd, apply: true, topologyOwner: input.session });
        if (!projected.ok) throw new Error(projected.errors.map(error => error.message).join("; "));
      }
      const projected = await adapter.project(plan, binding);
      if (projected.failed.length) throw new Error(projected.failed.map(failure => `${failure.effectiveId}: ${failure.error}`).join("; "));
      // Always provision the target's native bootstrap, including legacy seats
      // with no saved files. Interactive actions wait for the handover packet.
      const delivered = await adapter.deliverStartup(preLaunch, binding);
      if (delivered.failed.length) throw new Error(delivered.failed.map(failure => `${failure.path}: ${failure.error}`).join("; "));
    },
  };
}
