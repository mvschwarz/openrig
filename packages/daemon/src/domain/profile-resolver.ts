import nodePath from "node:path";
import { canonicalCompactionStrategy, canonicalContinuityMechanic } from "./agent-manifest.js";
import { homedir as osHomedir } from "node:os";
import type {
  AgentSpec, AgentResources, ProfileSpec, LifecycleDefaults,
  RigSpec, RigSpecPod, RigSpecPodMember, StartupBlock,
  SkillResource, GuidanceResource, SubagentResource, RuntimeResource, PluginResource,
} from "./types.js";
import type { ResolvedAgentSpec, ResourceCollision } from "./agent-resolver.js";
import { resolveStartup } from "./startup-resolver.js";
import { discoverSkillsForRuntime, type SkillRuntime } from "./skill-discovery.js";
import { inspectSkillDirectory, resolveSkillLoadout, type SkillLoadout } from "./skill-catalog.js";

// -- Types --

export interface QualifiedResource {
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resource: SkillResource | GuidanceResource | SubagentResource | RuntimeResource | PluginResource;
}

export interface ResolvedResources {
  skills: QualifiedResource[];
  guidance: QualifiedResource[];
  subagents: QualifiedResource[];
  plugins: QualifiedResource[];
  runtimeResources: QualifiedResource[];
}

export interface ResolvedNodeConfig {
  runtime: string;
  model: string | undefined;
  cwd: string;
  restorePolicy: string;
  /** OPR.0.5.6.20 — resolved continuity mode (canonical vocabulary; most-specific-wins). */
  compactionStrategy: string;
  /** Resolved continuity mechanic; absent unless explicitly declared. */
  mechanic: string | undefined;
  lifecycle: LifecycleDefaults | undefined;
  selectedResources: ResolvedResources;
  startup: StartupBlock;
  resolvedSpecName: string;
  resolvedSpecVersion: string;
  resolvedSpecHash: string;
  /**
   * Per-seat activity-detection tuning. Forwarded verbatim from
   * `profile.activity` after agent-manifest normalization. Currently
   * inert: the live poller uses the global 3s default and does not
   * read per-seat windows. Retained for a future per-seat decision.
   */
  activity?: { silenceWindowSeconds?: number };
  /** The catalog-owned portion of the effective skill selection. Runtime
   *  projection uses this for exact-byte ownership reconciliation. */
  skillLoadout?: SkillLoadout;
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
  /** V0.3.0 daemon-skill-discovery (SC-29 #7): operator home directory
   *  used to scan filesystem-discovered skills (~/.openrig/skills/,
   *  ~/.claude/skills/, ~/.agents/skills/). Defaults to os.homedir()
   *  in production; tests inject a fixture root. */
  homedir?: string;
  /** Config-resolved managed skill catalog root. */
  skillsRoot?: string;
  /** System World-owned managed skill identities. When absent, the legacy
   *  catalog.yaml selector remains the compatibility fallback. */
  systemSkills?: string[];
  /** A selected System World that could not be resolved. This is a launch
   *  refusal, never a silent fallback to the legacy catalog selector. */
  systemWorldError?: string;
}

export type ResolutionResult =
  | { ok: true; config: ResolvedNodeConfig }
  | { ok: false; errors: string[] };

// -- Constants --

const RESOURCE_CATEGORIES = ["skills", "guidance", "subagents", "plugins", "runtimeResources"] as const;
type ResourceCategory = typeof RESOURCE_CATEGORIES[number];

const YAML_CATEGORY_MAP: Record<string, ResourceCategory> = {
  skills: "skills",
  guidance: "guidance",
  subagents: "subagents",
  plugins: "plugins",
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
  if (ctx.systemWorldError) return { ok: false, errors: [`system_world_invalid: ${ctx.systemWorldError}`] };
  const { baseSpec, importedSpecs, profileName, member, pod, rig } = ctx;
  const spec = baseSpec.spec;

  // 1. Validate profile exists
  const profile = spec.profiles[profileName];
  if (!profile) {
    return { ok: false, errors: [`Profile "${profileName}" not found in spec "${spec.name}". Available: ${Object.keys(spec.profiles).join(", ") || "(none)"}` ] };
  }

  // 2. Build combined resource pool
  const pool = buildResourcePool(baseSpec, importedSpecs);

  // V0.3.0 daemon-skill-discovery (SC-29 #7): runtime + cwd must be
  // resolved BEFORE the pool is queried, so the filesystem skill scan
  // targets the right runtime's path layout (claude-code → .claude/;
  // codex → .agents/) at the right cwd. Order swapped from prior
  // versions where runtime/cwd were computed AFTER the pool.
  const runtime = member.runtime
    ?? profile.preferences?.runtime
    ?? spec.defaults?.runtime
    ?? "claude-code";

  const model = member.model
    ?? profile.preferences?.model
    ?? spec.defaults?.model;

  const cwd = ctx.cwdOverride
    ? nodePath.resolve(ctx.cwdOverride)
    : ctx.specRoot
      ? (nodePath.isAbsolute(member.cwd) ? member.cwd : nodePath.resolve(ctx.specRoot, member.cwd))
      : member.cwd;

  // 2b. Augment the pool with filesystem-discovered skills. Rig-local
  // resources.skills (already in the pool from buildResourcePool) win
  // over discovered same-id entries. Most-specific-wins precedence:
  // rig-local agent.yaml > rig-bundled cwd > spec-install-dir >
  // runtime-specific user library > shared ~/.openrig/skills/. The
  // internal ordering among discovery roots lives in
  // skill-discovery.listScanRoots; here we only enforce that
  // rig-local declarations are not overwritten by discovery.
  let rejectedSkillsByBasename: Map<string, { path: string; reason: string }> = new Map();
  if (runtime === "claude-code" || runtime === "codex") {
    const discovery = discoverSkillsForRuntime({
      runtime: runtime as SkillRuntime,
      homedir: ctx.homedir ?? osHomedir(),
      cwd,
      specInstallDir: ctx.specRoot,
      ...(ctx.skillsRoot ? { skillsRoot: ctx.skillsRoot } : {}),
    });
    for (const discovered of discovery.skills) {
      if (pool.skills.has(discovered.id)) continue; // rig-local-wins
      pool.skills.set(discovered.id, [{
        effectiveId: discovered.id,
        sourceSpec: "discovered",
        sourcePath: discovered.path,
        resource: discovered,
      }]);
    }
    // Index rejected skills by directory basename so a profile that
    // references the same name as a structurally-broken SKILL.md gets
    // the precise rejection reason instead of a bare "not found in
    // resource pool" error.
    for (const r of discovery.rejected) {
      const base = nodePath.basename(r.path);
      if (!rejectedSkillsByBasename.has(base)) rejectedSkillsByBasename.set(base, r);
    }
  }

  // 3. Resolve profile uses against the augmented pool
  const selectedResult = resolveProfileUses(profile, pool, spec.name, errors);
  if (errors.length > 0) {
    // Augment "skills: \"<id>\" not found in resource pool" errors
    // with the structural-rejection reason when the basename matches
    // a discovered-but-rejected SKILL.md directory. Operators see
    // exactly what to fix instead of a vague pool miss.
    const enhanced = errors.map((err) => {
      const m = err.match(/^Profile uses skills: "([^"]+)" not found in resource pool$/);
      if (!m) return err;
      const ref = m[1]!;
      const rejection = rejectedSkillsByBasename.get(ref);
      if (!rejection) return err;
      return `Profile uses skills: "${ref}" rejected — ${rejection.reason} (at ${rejection.path})`;
    });
    return { ok: false, errors: enhanced };
  }

  // S04 — compose independently-selected managed skills around the existing
  // topology selector (profile.uses.skills). System comes from catalog.yaml;
  // project comes from project.yaml install.skills. Topology resources that
  // are not catalog-managed retain the established AgentSpec/local behavior.
  const catalogRoot = ctx.skillsRoot ?? nodePath.join(ctx.homedir ?? osHomedir(), ".openrig", "skills");
  const catalogResult = resolveSkillLoadout({
    catalogRoot,
    ...(ctx.systemSkills !== undefined ? { systemSkills: ctx.systemSkills } : {}),
    topologySkills: profile.uses.skills,
    projectRoot: cwd,
    allowMissingTopology: true,
  });
  if (!catalogResult.ok) {
    return { ok: false, errors: catalogResult.errors.map((error) => `${error.code}: ${error.message}`) };
  }
  for (const managed of catalogResult.loadout.entries) {
    const qualified: QualifiedResource = {
      effectiveId: managed.id,
      sourceSpec: `skill-catalog@${managed.revision}`,
      sourcePath: managed.sourceRoot,
      resource: { id: managed.id, path: nodePath.relative(managed.sourceRoot, managed.sourceDir) },
    };
    const index = selectedResult!.skills.findIndex((entry) => {
      const resource = entry.resource as SkillResource;
      return entry.effectiveId === managed.id || resource.id === managed.id;
    });
    if (index >= 0) {
      const existing = selectedResult!.skills[index]!;
      const resource = existing.resource as SkillResource;
      const existingPath = nodePath.isAbsolute(resource.path)
        ? resource.path
        : nodePath.resolve(existing.sourcePath, resource.path);
      try {
        const existingDigest = inspectSkillDirectory(existingPath).digest;
        if (existingDigest !== managed.digest) {
          return {
            ok: false,
            errors: [
              `skill_identity_conflict: topology selection '${managed.id}' resolves to different content at ${existingPath} than managed catalog ${managed.sourceDir}; remove the duplicate source or make the bytes identical`,
            ],
          };
        }
      } catch (err) {
        return {
          ok: false,
          errors: [`skill_identity_conflict: cannot compare topology selection '${managed.id}' at ${existingPath}: ${(err as Error).message}`],
        };
      }
      selectedResult!.skills[index] = qualified;
    }
    else selectedResult!.skills.push(qualified);
  }
  selectedResult!.skills.sort((a, b) => a.effectiveId < b.effectiveId ? -1 : a.effectiveId > b.effectiveId ? 1 : 0);

  // 7. Resolve restorePolicy with narrowing
  const restorePolicyResult = resolveRestorePolicy(spec, profile, member);
  if (!restorePolicyResult.ok) {
    return { ok: false, errors: [restorePolicyResult.error] };
  }

  // 7b. Resolve compactionStrategy (OPR.0.5.6.20 — override-wins, aliases normalized)
  const compactionResult = resolveCompactionStrategy(spec, profile, member);
  if (!compactionResult.ok) {
    return { ok: false, errors: [compactionResult.error] };
  }
  const mechanicResult = resolveContinuityMechanic(spec, profile, member);
  if (!mechanicResult.ok) {
    return { ok: false, errors: [mechanicResult.error] };
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
      compactionStrategy: compactionResult.strategy,
      mechanic: mechanicResult.mechanic,
      lifecycle,
      selectedResources: selectedResult!,
      startup,
      resolvedSpecName: spec.name,
      resolvedSpecVersion: spec.version,
      resolvedSpecHash: baseSpec.hash,
      // Slice 15 — pass through the parsed activity block (or undefined
      // when the profile didn't declare one). NodeLauncher applies the
      // default 3s when this is missing.
      activity: profile.activity,
      skillLoadout: catalogResult.loadout,
    },
  };
}

// -- Resource pool --

interface PoolEntry {
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resource: SkillResource | GuidanceResource | SubagentResource | RuntimeResource | PluginResource;
}

type ResourcePool = Record<ResourceCategory, Map<string, PoolEntry[]>>;

function buildResourcePool(base: ResolvedAgentSpec, imports: ResolvedAgentSpec[]): ResourcePool {
  const pool: ResourcePool = {
    skills: new Map(),
    guidance: new Map(),
    subagents: new Map(),
    plugins: new Map(),
    runtimeResources: new Map(),
  };

  // Base spec resources (unqualified id)
  for (const cat of RESOURCE_CATEGORIES) {
    const resources = (base.spec.resources[cat] as Array<{ id: string }> | undefined) ?? [];
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
      const resources = (imp.spec.resources[cat] as Array<{ id: string }> | undefined) ?? [];
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
          pool[cat].set(r.id, [{ effectiveId: r.id, sourceSpec: imp.spec.name, sourcePath: imp.sourcePath, resource: r as PoolEntry["resource"] }]);
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
    plugins: [],
    runtimeResources: [],
  };

  const usesMap: Record<string, string[]> = {
    skills: profile.uses.skills,
    guidance: profile.uses.guidance,
    subagents: profile.uses.subagents,
    plugins: profile.uses.plugins,
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

/** OPR.0.5.6.20 — most-specific-WINS (spec default < profile < member), the
 * restore-policy PATTERN without its narrowing lattice: the four continuity modes are
 * unordered, so each more-specific level simply overrides. Aliases normalize through
 * the manifest's one vocabulary site; an invalid value at any level errors naming it. */
function resolveCompactionStrategy(
  spec: AgentSpec,
  profile: ProfileSpec,
  member: RigSpecPodMember,
): { ok: true; strategy: string } | { ok: false; error: string } {
  let current = "default-compaction";
  const specValue = spec.defaults?.lifecycle?.compactionStrategy;
  if (specValue) {
    const canonical = canonicalCompactionStrategy(specValue);
    if (canonical === null) return { ok: false, error: `Invalid compactionStrategy in spec defaults: "${specValue}"` };
    current = canonical;
  }
  const profileValue = (profile.lifecycle as { compactionStrategy?: string } | undefined)?.compactionStrategy;
  if (profileValue) {
    const canonical = canonicalCompactionStrategy(profileValue);
    if (canonical === null) return { ok: false, error: `Invalid compactionStrategy in profile: "${profileValue}"` };
    current = canonical;
  }
  if (member.compactionStrategy) {
    const canonical = canonicalCompactionStrategy(member.compactionStrategy);
    if (canonical === null) return { ok: false, error: `Invalid compactionStrategy in member: "${member.compactionStrategy}"` };
    current = canonical;
  }
  return { ok: true, strategy: current };
}

/** S20 A8: mechanic follows the exact shipped strategy path: spec default < profile < member. */
function resolveContinuityMechanic(
  spec: AgentSpec,
  profile: ProfileSpec,
  member: RigSpecPodMember,
): { ok: true; mechanic: string | undefined } | { ok: false; error: string } {
  let current: string | undefined;
  for (const [level, value] of [
    ["spec defaults", spec.defaults?.lifecycle?.mechanic],
    ["profile", profile.lifecycle?.mechanic],
    ["member", member.mechanic],
  ] as const) {
    if (value === undefined) continue;
    const canonical = canonicalContinuityMechanic(value);
    if (canonical === null) {
      return { ok: false, error: `Invalid mechanic in ${level}: "${String(value)}"` };
    }
    current = canonical;
  }
  return { ok: true, mechanic: current };
}

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
