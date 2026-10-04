import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// --- Types ---

export interface PackageManifest {
  schemaVersion: number;
  name: string;
  version: string;
  summary: string;
  compatibility: { runtimes: string[] };
  exports: PackageExports;
  requirements?: PackageRequirements;
  installPolicy?: InstallPolicy;
  verification?: VerificationConfig;
  roles?: RoleDefinition[];
}

export interface PackageExports {
  skills?: SkillExport[];
  guidance?: GuidanceExport[];
  agents?: AgentExport[];
  hooks?: HookExport[];
  mcp?: McpExport[];
}

export interface SkillExport {
  source: string;
  name: string;
  supportedScopes: string[];
  defaultScope: string;
}

export interface GuidanceExport {
  source: string;
  name: string;
  kind: string;
  supportedScopes: string[];
  defaultScope: string;
  mergeStrategy: string;
}

export interface AgentExport {
  source: string;
  name?: string;
  supportedScopes?: string[];
  defaultScope?: string;
}

export interface HookExport {
  source: string;
  supportedRuntimes?: string[];
  supportedScopes?: string[];
  defaultScope?: string;
}

export interface McpExport {
  source: string;
  supportedRuntimes?: string[];
  supportedScopes?: string[];
  defaultScope?: string;
}

export interface PackageRequirements {
  cliTools?: Array<{ name: string; requiredFor?: string[]; installHints?: Record<string, string> }>;
  systemPackages?: Array<{ name: string }>;
}

export interface InstallPolicy {
  requireReviewForExternalInstalls?: boolean;
  allowUserGlobalWrites?: boolean;
  allowAgentMergeOfGuidance?: boolean;
}

export interface RoleDefinition {
  name: string;
  description?: string;
  skills?: string[];
  guidance?: string[];
  hooks?: string[];
  context?: string[];
}

export interface VerificationCheck {
  type: string;
  name?: string;
  command?: string;
}

export interface VerificationConfig {
  checks: VerificationCheck[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// --- Constants ---

const KNOWN_RUNTIMES = new Set(["claude-code", "codex"]);
const KNOWN_SCOPES = new Set(["project_shared", "project_local", "user_global", "system_managed", "session_ephemeral"]);
const KNOWN_GUIDANCE_KINDS = new Set(["agents_md", "claude_md", "generic_rules_overlay"]);
const KNOWN_MERGE_STRATEGIES = new Set(["managed_block", "append", "prepend", "replace", "manual"]);
const SEMVER_LIKE = /^\d+\.\d+\.\d+/;

// --- Parse ---

export function parseManifest(yamlString: string): unknown {
  return parseYaml(yamlString);
}

// --- Validate ---

function hasPathTraversal(source: string): boolean {
  return source.includes("../") || source === ".." || source.endsWith("/..");
}

const PACKAGE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const m = raw as Record<string, unknown>;

  // schema_version
  if (m["schema_version"] !== undefined && m["schema_version"] !== 1) {
    errors.push("schema_version must be 1");
  }

  // name
  if (!m["name"] || typeof m["name"] !== "string") {
    errors.push("name is required and must be a string");
  } else if (!PACKAGE_NAME_PATTERN.test(m["name"] as string)) {
    errors.push("name must match [a-zA-Z0-9][a-zA-Z0-9._-]* (alphanumeric, dots, hyphens, underscores)");
  }

  // version
  if (!m["version"] || typeof m["version"] !== "string") {
    errors.push("version is required and must be a string");
  } else if (!SEMVER_LIKE.test(m["version"] as string)) {
    errors.push("version must be semver-like (e.g., 1.0.0)");
  }

  // summary
  if (!m["summary"] || typeof m["summary"] !== "string") {
    errors.push("summary is required and must be a string");
  }

  // compatibility.runtimes
  const compat = m["compatibility"] as Record<string, unknown> | undefined;
  if (!compat || !Array.isArray(compat["runtimes"]) || compat["runtimes"].length === 0) {
    errors.push("compatibility.runtimes is required and must be a non-empty array");
  } else {
    for (const rt of compat["runtimes"] as string[]) {
      if (!KNOWN_RUNTIMES.has(rt)) {
        errors.push(`Unknown runtime: '${rt}'`);
      }
    }
  }

  // exports
  const exports = m["exports"] as Record<string, unknown> | undefined;
  if (!exports || typeof exports !== "object") {
    errors.push("exports is required and must be an object");
  } else {
    // Collect export names for role validation
    const skillNames = new Set<string>();
    const guidanceNames = new Set<string>();

    // skills
    if (Array.isArray(exports["skills"])) {
      for (const skill of exports["skills"] as Record<string, unknown>[]) {
        if (!skill["source"] || typeof skill["source"] !== "string") {
          errors.push("Skill export: source is required");
        } else if (hasPathTraversal(skill["source"] as string)) {
          errors.push(`Skill export source must not contain path traversal: '${skill["source"]}'`);
        }
        if (!skill["name"] || typeof skill["name"] !== "string") {
          errors.push("Skill export: name is required");
        } else {
          const name = skill["name"] as string;
          if (skillNames.has(name)) {
            errors.push(`Duplicate skill name: '${name}'`);
          }
          skillNames.add(name);
        }
        // Validate scopes
        if (Array.isArray(skill["supported_scopes"])) {
          for (const scope of skill["supported_scopes"] as string[]) {
            if (!KNOWN_SCOPES.has(scope)) {
              errors.push(`Skill '${skill["name"] ?? "?"}': unknown scope '${scope}'`);
            }
          }
        }
        if (skill["default_scope"] && !KNOWN_SCOPES.has(skill["default_scope"] as string)) {
          errors.push(`Skill '${skill["name"] ?? "?"}': unknown default_scope '${skill["default_scope"]}'`);
        }
      }
    }

    // guidance
    if (Array.isArray(exports["guidance"])) {
      for (const g of exports["guidance"] as Record<string, unknown>[]) {
        if (!g["source"] || typeof g["source"] !== "string") {
          errors.push("Guidance export: source is required");
        } else if (hasPathTraversal(g["source"] as string)) {
          errors.push(`Guidance export source must not contain path traversal: '${g["source"]}'`);
        }
        if (g["kind"] && !KNOWN_GUIDANCE_KINDS.has(g["kind"] as string)) {
          errors.push(`Unknown guidance kind: '${g["kind"]}'`);
        }
        if (!g["kind"]) {
          errors.push("Guidance export: kind is required");
        }
        if (g["merge_strategy"] && !KNOWN_MERGE_STRATEGIES.has(g["merge_strategy"] as string)) {
          errors.push(`Unknown merge strategy: '${g["merge_strategy"]}'`);
        }
        if (!g["merge_strategy"]) {
          errors.push("Guidance export: merge_strategy is required");
        }

        // Derive name for uniqueness check
        const name = (g["name"] as string | undefined) ??
          (g["source"] ? (g["source"] as string).split("/").pop()! : "");
        if (name && guidanceNames.has(name)) {
          errors.push(`Duplicate guidance name: '${name}'`);
        }
        // Validate scopes
        if (Array.isArray(g["supported_scopes"])) {
          for (const scope of g["supported_scopes"] as string[]) {
            if (!KNOWN_SCOPES.has(scope)) {
              errors.push(`Guidance '${name}': unknown scope '${scope}'`);
            }
          }
        }
        if (g["default_scope"] && !KNOWN_SCOPES.has(g["default_scope"] as string)) {
          errors.push(`Guidance '${name}': unknown default_scope '${g["default_scope"]}'`);
        }
        if (name) guidanceNames.add(name);
      }
    }

    // agents
    const agentNames = new Set<string>();
    if (Array.isArray(exports["agents"])) {
      for (const a of exports["agents"] as Record<string, unknown>[]) {
        if (!a["source"] || typeof a["source"] !== "string") {
          errors.push("Agent export: source is required");
        } else if (hasPathTraversal(a["source"] as string)) {
          errors.push(`Agent export source must not contain path traversal: '${a["source"]}'`);
        }
        const agentName = (a["name"] as string | undefined) ??
          (a["source"] ? (a["source"] as string).replace(/\.[^.]+$/, "").split("/").pop()! : "");
        if (agentName && agentNames.has(agentName)) {
          errors.push(`Duplicate agent name: '${agentName}'`);
        }
        if (agentName) agentNames.add(agentName);
      }
    }

    // hooks
    if (Array.isArray(exports["hooks"])) {
      for (const h of exports["hooks"] as Record<string, unknown>[]) {
        if (!h["source"] || typeof h["source"] !== "string") {
          errors.push("Hook export: source is required");
        } else if (hasPathTraversal(h["source"] as string)) {
          errors.push(`Hook export source must not contain path traversal: '${h["source"]}'`);
        }
      }
    }
    // mcp
    if (Array.isArray(exports["mcp"])) {
      for (const mc of exports["mcp"] as Record<string, unknown>[]) {
        if (!mc["source"] || typeof mc["source"] !== "string") {
          errors.push("MCP export: source is required");
        } else if (hasPathTraversal(mc["source"] as string)) {
          errors.push(`MCP export source must not contain path traversal: '${mc["source"]}'`);
        }
      }
    }

    // roles
    if (Array.isArray(m["roles"])) {
      for (const role of m["roles"] as Record<string, unknown>[]) {
        if (Array.isArray(role["skills"])) {
          for (const skillRef of role["skills"] as string[]) {
            if (!skillNames.has(skillRef)) {
              errors.push(`Role '${role["name"]}' references nonexistent skill: '${skillRef}'`);
            }
          }
        }
        if (Array.isArray(role["guidance"])) {
          for (const guidanceRef of role["guidance"] as string[]) {
            if (!guidanceNames.has(guidanceRef)) {
              errors.push(`Role '${role["name"]}' references nonexistent guidance: '${guidanceRef}'`);
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Normalize helpers ---

function normalizeRequirements(raw: unknown): PackageRequirements | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    cliTools: Array.isArray(r["cli_tools"])
      ? (r["cli_tools"] as Record<string, unknown>[]).map((t) => ({
          name: t["name"] as string,
          requiredFor: t["required_for"] as string[] | undefined,
          installHints: t["install_hints"] as Record<string, string> | undefined,
        }))
      : undefined,
    systemPackages: Array.isArray(r["system_packages"])
      ? (r["system_packages"] as Record<string, unknown>[]).map((p) => ({
          name: p["name"] as string,
        }))
      : undefined,
  };
}

function normalizeInstallPolicy(raw: unknown): InstallPolicy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  return {
    requireReviewForExternalInstalls: p["require_review_for_external_installs"] as boolean | undefined,
    allowUserGlobalWrites: p["allow_user_global_writes"] as boolean | undefined,
    allowAgentMergeOfGuidance: p["allow_agent_merge_of_guidance"] as boolean | undefined,
  };
}

function normalizeVerification(raw: unknown): VerificationConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (!Array.isArray(v["checks"])) return undefined;
  return {
    checks: (v["checks"] as Record<string, unknown>[]).map((c) => ({
      type: c["type"] as string,
      name: c["name"] as string | undefined,
      command: c["command"] as string | undefined,
    })),
  };
}

// --- Normalize ---

export function normalizeManifest(raw: unknown): PackageManifest {
  const m = raw as Record<string, unknown>;
  const exportsRaw = (m["exports"] ?? {}) as Record<string, unknown>;

  const skills: SkillExport[] = (Array.isArray(exportsRaw["skills"]) ? exportsRaw["skills"] : []).map((s: Record<string, unknown>) => ({
    source: s["source"] as string,
    name: s["name"] as string,
    supportedScopes: (s["supported_scopes"] as string[] | undefined) ?? ["project_shared"],
    defaultScope: (s["default_scope"] as string | undefined) ?? "project_shared",
  }));

  const guidance: GuidanceExport[] = (Array.isArray(exportsRaw["guidance"]) ? exportsRaw["guidance"] : []).map((g: Record<string, unknown>) => ({
    source: g["source"] as string,
    name: (g["name"] as string | undefined) ?? (g["source"] as string).split("/").pop()!,
    kind: g["kind"] as string,
    supportedScopes: (g["supported_scopes"] as string[] | undefined) ?? ["project_shared"],
    defaultScope: (g["default_scope"] as string | undefined) ?? "project_shared",
    mergeStrategy: g["merge_strategy"] as string,
  }));

  const agents: AgentExport[] = (Array.isArray(exportsRaw["agents"]) ? exportsRaw["agents"] : []).map((a: Record<string, unknown>) => ({
    source: a["source"] as string,
    name: a["name"] as string | undefined,
    supportedScopes: a["supported_scopes"] as string[] | undefined,
    defaultScope: a["default_scope"] as string | undefined,
  }));

  const hooks: HookExport[] = (Array.isArray(exportsRaw["hooks"]) ? exportsRaw["hooks"] : []).map((h: Record<string, unknown>) => ({
    source: h["source"] as string,
    supportedRuntimes: h["supported_runtimes"] as string[] | undefined,
    supportedScopes: h["supported_scopes"] as string[] | undefined,
    defaultScope: h["default_scope"] as string | undefined,
  }));

  const mcp: McpExport[] = (Array.isArray(exportsRaw["mcp"]) ? exportsRaw["mcp"] : []).map((mc: Record<string, unknown>) => ({
    source: mc["source"] as string,
    supportedRuntimes: mc["supported_runtimes"] as string[] | undefined,
    supportedScopes: mc["supported_scopes"] as string[] | undefined,
    defaultScope: mc["default_scope"] as string | undefined,
  }));

  const roles: RoleDefinition[] | undefined = Array.isArray(m["roles"])
    ? (m["roles"] as Record<string, unknown>[]).map((r) => ({
        name: r["name"] as string,
        description: r["description"] as string | undefined,
        skills: r["skills"] as string[] | undefined,
        guidance: r["guidance"] as string[] | undefined,
        hooks: r["hooks"] as string[] | undefined,
        context: r["context"] as string[] | undefined,
      }))
    : undefined;

  return {
    schemaVersion: (m["schema_version"] as number | undefined) ?? 1,
    name: m["name"] as string,
    version: m["version"] as string,
    summary: m["summary"] as string,
    compatibility: { runtimes: ((m["compatibility"] as Record<string, unknown>)?.["runtimes"] as string[]) ?? [] },
    exports: { skills, guidance, agents, hooks, mcp },
    requirements: normalizeRequirements(m["requirements"]),
    installPolicy: normalizeInstallPolicy(m["install_policy"]),
    verification: normalizeVerification(m["verification"]),
    roles,
  };
}

// --- Serialize ---

export function serializeManifest(manifest: PackageManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    compatibility: { runtimes: manifest.compatibility.runtimes },
    exports: {} as Record<string, unknown>,
  };

  const exports = doc["exports"] as Record<string, unknown>;

  if (manifest.exports.skills?.length) {
    exports["skills"] = manifest.exports.skills.map((s) => ({
      source: s.source,
      name: s.name,
      supported_scopes: s.supportedScopes,
      default_scope: s.defaultScope,
    }));
  }

  if (manifest.exports.guidance?.length) {
    exports["guidance"] = manifest.exports.guidance.map((g) => ({
      source: g.source,
      name: g.name,
      kind: g.kind,
      supported_scopes: g.supportedScopes,
      default_scope: g.defaultScope,
      merge_strategy: g.mergeStrategy,
    }));
  }

  if (manifest.exports.agents?.length) {
    exports["agents"] = manifest.exports.agents.map((a) => ({
      source: a.source,
      ...(a.name ? { name: a.name } : {}),
      ...(a.supportedScopes ? { supported_scopes: a.supportedScopes } : {}),
      ...(a.defaultScope ? { default_scope: a.defaultScope } : {}),
    }));
  }

  if (manifest.exports.hooks?.length) {
    exports["hooks"] = manifest.exports.hooks.map((h) => ({
      source: h.source,
      ...(h.supportedRuntimes ? { supported_runtimes: h.supportedRuntimes } : {}),
      ...(h.supportedScopes ? { supported_scopes: h.supportedScopes } : {}),
      ...(h.defaultScope ? { default_scope: h.defaultScope } : {}),
    }));
  }

  if (manifest.exports.mcp?.length) {
    exports["mcp"] = manifest.exports.mcp.map((mc) => ({
      source: mc.source,
      ...(mc.supportedRuntimes ? { supported_runtimes: mc.supportedRuntimes } : {}),
      ...(mc.supportedScopes ? { supported_scopes: mc.supportedScopes } : {}),
      ...(mc.defaultScope ? { default_scope: mc.defaultScope } : {}),
    }));
  }

  if (manifest.requirements) {
    const req: Record<string, unknown> = {};
    if (manifest.requirements.cliTools?.length) {
      req["cli_tools"] = manifest.requirements.cliTools.map((t) => ({
        name: t.name,
        ...(t.requiredFor ? { required_for: t.requiredFor } : {}),
        ...(t.installHints ? { install_hints: t.installHints } : {}),
      }));
    }
    if (manifest.requirements.systemPackages?.length) {
      req["system_packages"] = manifest.requirements.systemPackages.map((p) => ({ name: p.name }));
    }
    doc["requirements"] = req;
  }

  if (manifest.installPolicy) {
    const pol: Record<string, unknown> = {};
    if (manifest.installPolicy.requireReviewForExternalInstalls !== undefined) {
      pol["require_review_for_external_installs"] = manifest.installPolicy.requireReviewForExternalInstalls;
    }
    if (manifest.installPolicy.allowUserGlobalWrites !== undefined) {
      pol["allow_user_global_writes"] = manifest.installPolicy.allowUserGlobalWrites;
    }
    if (manifest.installPolicy.allowAgentMergeOfGuidance !== undefined) {
      pol["allow_agent_merge_of_guidance"] = manifest.installPolicy.allowAgentMergeOfGuidance;
    }
    doc["install_policy"] = pol;
  }

  if (manifest.verification?.checks.length) {
    doc["verification"] = {
      checks: manifest.verification.checks.map((c) => ({
        type: c.type,
        ...(c.name ? { name: c.name } : {}),
        ...(c.command ? { command: c.command } : {}),
      })),
    };
  }

  if (manifest.roles?.length) {
    doc["roles"] = manifest.roles.map((r) => ({
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      ...(r.skills ? { skills: r.skills } : {}),
      ...(r.guidance ? { guidance: r.guidance } : {}),
      ...(r.hooks ? { hooks: r.hooks } : {}),
      ...(r.context ? { context: r.context } : {}),
    }));
  }

  return stringifyYaml(doc);
}
