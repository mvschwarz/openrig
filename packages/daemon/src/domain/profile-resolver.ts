import nodePath from "node:path";
import type {
  AgentSpec, AgentResources, ProfileSpec, LifecycleDefaults,
  RigSpec, RigSpecPod, RigSpecPodMember, StartupBlock,
  SkillResource, GuidanceResource, SubagentResource, HookResource, RuntimeResource,
} from "./types.js";
import type { ResolvedAgentSpec, ResourceCollision } from "./agent-resolver.js";
import { resolveStartup } from "./startup-resolver.js";

// -- Types --

export interface QualifiedResource {
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resource: SkillResource | GuidanceResource | SubagentResource | HookResource | RuntimeResource;
}

export interface ResolvedResources {
  skills: QualifiedResource[];
  guidance: QualifiedResource[];
  subagents: QualifiedResource[];
  hooks: QualifiedResource[];
  runtimeResources: QualifiedResource[];
}

export interface ResolvedNodeConfig {
  runtime: string;
  model: string | undefined;
  cwd: string;
  restorePolicy: string;
  lifecycle: LifecycleDefaults | undefined;
  selectedResources: ResolvedResources;
  startup: StartupBlock;
  resolvedSpecName: string;
  resolvedSpecVersion: string;
  resolvedSpecHash: string;
}

export interface ResolutionContext {
  baseSpec: ResolvedAgentSpec;
  importedSpecs: ResolvedAgentSpec[];
  collisions: ResourceCollision[];
  profileName: string;
  specRoot?: string;
  cwdOverride?: string;
  member: RigSpecPodMember;
  pod: RigSpecPod;
  rig: RigSpec;
  operatorStartup?: StartupBlock;
}

export type ResolutionResult =
  | { ok: true; config: ResolvedNodeConfig }
  | { ok: false; errors: string[] };

// -- Constants --

const RESOURCE_CATEGORIES = ["skills", "guidance", "subagents", "hooks", "runtimeResources"] as const;
type ResourceCategory = typeof RESOURCE_CATEGORIES[number];

const YAML_CATEGORY_MAP: Record<string, ResourceCategory> = {
  skills: "skills",
  guidance: "guidance",
  subagents: "subagents",
  hooks: "hooks",
  runtime_resources: "runtimeResources",
  runtimeResources: "runtimeResources",
};

const RESTORE_POLICY_LEVEL: Record<string, number> = {
  resume_if_possible: 0,
  relaunch_fresh: 1,
  checkpoint_only: 2,
};

// -- Public API --

/**
 * Resolve effective node configuration from agent spec, profile, and rig context.
 * @param ctx - resolution context with all inputs
 * @returns resolved config or errors
 */
export function resolveNodeConfig(ctx: ResolutionContext): ResolutionResult {
  const errors: string[] = [];
  const { baseSpec, importedSpecs, profileName, member, pod, rig } = ctx;
  const spec = baseSpec.spec;

  // 1. Validate profile exists
  const profile = spec.profiles[profileName];
  if (!profile) {
    return { ok: false, errors: [`Profile "${profileName}" not found in spec "${spec.name}". Available: ${Object.keys(spec.profiles).join(", ") || "(none)"}` ] };
  }

  // 2. Build combined resource pool
  const pool = buildResourcePool(baseSpec, importedSpecs);

  // 3. Resolve profile uses against pool
  const selectedResult = resolveProfileUses(profile, pool, spec.name, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 4. Resolve runtime (member authoritative)
  const runtime = member.runtime
    ?? profile.preferences?.runtime
    ?? spec.defaults?.runtime
    ?? "claude-code";

  // 5. Resolve model (member overrides)
  const model = member.model
    ?? profile.preferences?.model
    ?? spec.defaults?.model;

  // 6. Resolve cwd (member authoritative, required)
  const cwd = ctx.cwdOverride
    ? nodePath.resolve(ctx.cwdOverride)
    : ctx.specRoot
      ? (nodePath.isAbsolute(member.cwd) ? member.cwd : nodePath.resolve(ctx.specRoot, member.cwd))
      : member.cwd;

  // 7. Resolve restorePolicy with narrowing
  const restorePolicyResult = resolveRestorePolicy(spec, profile, member);
  if (!restorePolicyResult.ok) {
    return { ok: false, errors: [restorePolicyResult.error] };
  }

  // 8. Resolve lifecycle
  const lifecycle = profile.lifecycle ?? spec.defaults?.lifecycle;

  // 9. Resolve startup layering
  const startup = resolveStartup({
    specStartup: spec.startup,
    profileStartup: profile.startup,
    rigCultureFile: rig.cultureFile,
    rigStartup: rig.startup,
    podStartup: pod.startup,
    memberStartup: member.startup,
    operatorStartup: ctx.operatorStartup,
  });

  return {
    ok: true,
    config: {
      runtime,
      model,
      cwd,
      restorePolicy: restorePolicyResult.policy,
      lifecycle,
      selectedResources: selectedResult!,
      startup,
      resolvedSpecName: spec.name,
      resolvedSpecVersion: spec.version,
      resolvedSpecHash: baseSpec.hash,
    },
  };
}

// -- Resource pool --

interface PoolEntry {
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resource: SkillResource | GuidanceResource | SubagentResource | HookResource | RuntimeResource;
}

type ResourcePool = Record<ResourceCategory, Map<string, PoolEntry[]>>;

function buildResourcePool(base: ResolvedAgentSpec, imports: ResolvedAgentSpec[]): ResourcePool {
  const pool: ResourcePool = {
    skills: new Map(),
    guidance: new Map(),
    subagents: new Map(),
    hooks: new Map(),
    runtimeResources: new Map(),
  };

  // Base spec resources (unqualified id)
  for (const cat of RESOURCE_CATEGORIES) {
    const resources = base.spec.resources[cat] as Array<{ id: string }>;
    for (const r of resources) {
      const entries = pool[cat].get(r.id) ?? [];
      entries.push({ effectiveId: r.id, sourceSpec: base.spec.name, sourcePath: base.sourcePath, resource: r as PoolEntry["resource"] });
      pool[cat].set(r.id, entries);
    }
  }

  // Imported spec resources (qualified id only)
  // Per proposal: "base resources keep the unqualified local id" and
  // "colliding imported resources remain addressable only by qualified id"
  for (const imp of imports) {
    for (const cat of RESOURCE_CATEGORIES) {
      const resources = imp.spec.resources[cat] as Array<{ id: string }>;
      for (const r of resources) {
        const qualifiedId = `${imp.spec.name}:${r.id}`;
        // Index under qualified id only
        const qualEntries = pool[cat].get(qualifiedId) ?? [];
        qualEntries.push({ effectiveId: qualifiedId, sourceSpec: imp.spec.name, sourcePath: imp.sourcePath, resource: r as PoolEntry["resource"] });
        pool[cat].set(qualifiedId, qualEntries);

        // If no base resource with this id exists, also index under unqualified id
        // so a single import's resource can be referenced without qualification.
        // If a base resource exists, the base owns the unqualified id (no collision).
        // If multiple imports share the same unqualified id (no base), it's ambiguous.
        if (!pool[cat].has(r.id)) {
          pool[cat].set(r.id, [{ effectiveId: qualifiedId, sourceSpec: imp.spec.name, sourcePath: imp.sourcePath, resource: r as PoolEntry["resource"] }]);
        } else {
          const existing = pool[cat].get(r.id)!;
          // Only add for ambiguity if the existing entry is NOT from the base spec
          const hasBase = existing.some((e) => e.sourceSpec === base.spec.name);
          if (!hasBase) {
            existing.push({ effectiveId: qualifiedId, sourceSpec: imp.spec.name, sourcePath: imp.sourcePath, resource: r as PoolEntry["resource"] });
          }
          // If base owns it, imported version is only reachable via qualified id — no unqualified indexing
        }
      }
    }
  }

  return pool;
}

function resolveProfileUses(
  profile: ProfileSpec,
  pool: ResourcePool,
  baseSpecName: string,
  errors: string[],
): ResolvedResources | null {
  const result: ResolvedResources = {
    skills: [],
    guidance: [],
    subagents: [],
    hooks: [],
    runtimeResources: [],
  };

  const usesMap: Record<string, string[]> = {
    skills: profile.uses.skills,
    guidance: profile.uses.guidance,
    subagents: profile.uses.subagents,
    hooks: profile.uses.hooks,
    runtimeResources: profile.uses.runtimeResources,
  };

  for (const cat of RESOURCE_CATEGORIES) {
    const refs = usesMap[cat] ?? [];
    for (const ref of refs) {
      const entries = pool[cat].get(ref);
      if (!entries || entries.length === 0) {
        errors.push(`Profile uses ${cat}: "${ref}" not found in resource pool`);
        continue;
      }
      if (entries.length > 1) {
        // Ambiguous unqualified reference
        const sources = entries.map((e) => e.sourceSpec).join(", ");
        errors.push(`Profile uses ${cat}: "${ref}" is ambiguous (declared in: ${sources}). Use a qualified id like "specname:${ref}"`);
        continue;
      }
      result[cat].push({
        effectiveId: entries[0]!.effectiveId,
        sourceSpec: entries[0]!.sourceSpec,
        sourcePath: entries[0]!.sourcePath,
        resource: entries[0]!.resource,
      });
    }
  }

  return errors.length > 0 ? null : result;
}

// -- Restore policy narrowing --

function resolveRestorePolicy(
  spec: AgentSpec,
  profile: ProfileSpec,
  member: RigSpecPodMember,
): { ok: true; policy: string } | { ok: false; error: string } {
  let current: string = spec.defaults?.lifecycle?.restorePolicy ?? "resume_if_possible";
  let currentLevel = RESTORE_POLICY_LEVEL[current] ?? 0;

  // Profile narrows
  if (profile.lifecycle?.restorePolicy) {
    const profileLevel = RESTORE_POLICY_LEVEL[profile.lifecycle.restorePolicy];
    if (profileLevel === undefined) {
      return { ok: false, error: `Invalid restorePolicy in profile: "${profile.lifecycle.restorePolicy}"` };
    }
    if (profileLevel < currentLevel) {
      return { ok: false, error: `Profile restorePolicy "${profile.lifecycle.restorePolicy}" broadens "${current}" — only narrowing is allowed` };
    }
    current = profile.lifecycle.restorePolicy;
    currentLevel = profileLevel;
  }

  // Member narrows
  if (member.restorePolicy) {
    const memberLevel = RESTORE_POLICY_LEVEL[member.restorePolicy];
    if (memberLevel === undefined) {
      return { ok: false, error: `Invalid restorePolicy on member: "${member.restorePolicy}"` };
    }
    if (memberLevel < currentLevel) {
      return { ok: false, error: `Member restorePolicy "${member.restorePolicy}" broadens "${current}" — only narrowing is allowed` };
    }
    current = member.restorePolicy;
  }

  return { ok: true, policy: current };
}
