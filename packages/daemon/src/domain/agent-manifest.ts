import { parse as parseYaml } from "yaml";
import type {
  AgentSpec, ImportSpec, StartupBlock, StartupFile, StartupAction,
  LifecycleDefaults, AgentResources, ProfileSpec,
  SkillResource, GuidanceResource, SubagentResource, HookResource, RuntimeResource,
  ValidationResult,
} from "./types.js";

// -- Constants --

const VALID_DELIVERY_HINTS = new Set(["auto", "guidance_merge", "skill_install", "send_text"]);
const VALID_ACTION_TYPES = new Set(["slash_command", "send_text"]);
const VALID_PHASES = new Set(["after_files", "after_ready"]);
const VALID_APPLIES_ON = new Set(["fresh_start", "restore"]);
const VALID_EXECUTION_MODES = new Set(["interactive_resident"]);
const VALID_COMPACTION_STRATEGIES = new Set(["harness_native", "pod_continuity"]);
const VALID_RESTORE_POLICIES = new Set(["resume_if_possible", "relaunch_fresh", "checkpoint_only"]);
const VALID_IMPORT_PREFIXES = ["local:", "path:"];

import { validateSafePath } from "./path-safety.js";

// -- Import validation --

function validateImportRef(ref: string, index: number): string | null {
  if (!ref || typeof ref !== "string") return `imports[${index}].ref: must be a non-empty string`;
  const hasValidPrefix = VALID_IMPORT_PREFIXES.some((p) => ref.startsWith(p));
  if (!hasValidPrefix) return `imports[${index}].ref: must start with "local:" or "path:" (got "${ref}")`;
  if (ref.startsWith("local:")) {
    const path = ref.slice("local:".length);
    if (!path) return `imports[${index}].ref: local: ref must have a path`;
    if (path.startsWith("/")) return `imports[${index}].ref: local: ref must be a relative path (got "${ref}")`;
  }
  if (ref.startsWith("path:")) {
    const path = ref.slice("path:".length);
    if (!path) return `imports[${index}].ref: path: ref must have a path`;
    if (!path.startsWith("/")) return `imports[${index}].ref: path: ref must be an absolute path (got "${ref}")`;
  }
  return null;
}

function validateImportVersion(version: unknown, index: number): string | null {
  if (version === undefined || version === null) return null;
  if (typeof version !== "string") return `imports[${index}].version: must be a string`;
  if (/[~^>=<|]/.test(version)) return `imports[${index}].version: version ranges are not supported; use exact version (got "${version}")`;
  return null;
}

// -- Startup validation --

function validateStartupFile(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  const errors: string[] = [];
  const pathErr = validateSafePath(raw["path"] as string, `${prefix}files[${index}].path`);
  if (pathErr) errors.push(pathErr);
  if (raw["delivery_hint"] !== undefined && !VALID_DELIVERY_HINTS.has(raw["delivery_hint"] as string)) {
    errors.push(`${prefix}files[${index}].delivery_hint: must be one of ${[...VALID_DELIVERY_HINTS].join(", ")} (got "${raw["delivery_hint"]}")`);
  }
  if (raw["applies_on"] !== undefined) {
    if (!Array.isArray(raw["applies_on"])) {
      errors.push(`${prefix}files[${index}].applies_on: must be an array`);
    } else {
      for (const v of raw["applies_on"]) {
        if (!VALID_APPLIES_ON.has(v as string)) {
          errors.push(`${prefix}files[${index}].applies_on: invalid value "${v}"; must be one of ${[...VALID_APPLIES_ON].join(", ")}`);
        }
      }
    }
  }
  return errors;
}

function validateStartupAction(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  const errors: string[] = [];
  const type = raw["type"] as string;
  if (type === "shell") {
    errors.push(`${prefix}actions[${index}].type: "shell" startup actions are not supported in v1; use "slash_command" or "send_text"`);
  } else if (!VALID_ACTION_TYPES.has(type)) {
    errors.push(`${prefix}actions[${index}].type: must be one of ${[...VALID_ACTION_TYPES].join(", ")} (got "${type}")`);
  }
  if (!raw["value"] || typeof raw["value"] !== "string") {
    errors.push(`${prefix}actions[${index}].value: must be a non-empty string`);
  }
  if (raw["phase"] !== undefined && !VALID_PHASES.has(raw["phase"] as string)) {
    errors.push(`${prefix}actions[${index}].phase: must be one of ${[...VALID_PHASES].join(", ")} (got "${raw["phase"]}")`);
  }
  if (raw["idempotent"] === undefined || raw["idempotent"] === null) {
    errors.push(`${prefix}actions[${index}].idempotent: required field`);
  } else if (typeof raw["idempotent"] !== "boolean") {
    errors.push(`${prefix}actions[${index}].idempotent: must be a boolean`);
  }
  if (raw["applies_on"] !== undefined) {
    if (!Array.isArray(raw["applies_on"])) {
      errors.push(`${prefix}actions[${index}].applies_on: must be an array`);
    } else {
      for (const v of raw["applies_on"]) {
        if (!VALID_APPLIES_ON.has(v as string)) {
          errors.push(`${prefix}actions[${index}].applies_on: invalid value "${v}"; must be one of ${[...VALID_APPLIES_ON].join(", ")}`);
        }
      }
    }
  }
  // Restore-safety: non-idempotent actions must not apply on restore
  if (raw["idempotent"] === false) {
    const appliesOn = Array.isArray(raw["applies_on"]) ? raw["applies_on"] as string[] : ["fresh_start", "restore"];
    if (appliesOn.includes("restore")) {
      errors.push(`${prefix}actions[${index}]: non-idempotent action must not apply on restore`);
    }
  }
  return errors;
}

function validateStartupBlock(raw: unknown, prefix: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object") return [`${prefix}: must be an object`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (obj["files"] !== undefined) {
    if (!Array.isArray(obj["files"])) {
      errors.push(`${prefix}.files: must be an array`);
    } else {
      for (let i = 0; i < (obj["files"] as unknown[]).length; i++) {
        errors.push(...validateStartupFile((obj["files"] as Record<string, unknown>[])[i]!, i, `${prefix}.`));
      }
    }
  }
  if (obj["actions"] !== undefined) {
    if (!Array.isArray(obj["actions"])) {
      errors.push(`${prefix}.actions: must be an array`);
    } else {
      for (let i = 0; i < (obj["actions"] as unknown[]).length; i++) {
        errors.push(...validateStartupAction((obj["actions"] as Record<string, unknown>[])[i]!, i, `${prefix}.`));
      }
    }
  }
  return errors;
}

// -- Lifecycle validation --

function validateLifecycle(raw: unknown, prefix: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object") return [`${prefix}: must be an object`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (obj["execution_mode"] !== undefined) {
    if (obj["execution_mode"] === "wake_on_demand") {
      errors.push(`${prefix}.execution_mode: "wake_on_demand" is not supported in v1; use "interactive_resident"`);
    } else if (!VALID_EXECUTION_MODES.has(obj["execution_mode"] as string)) {
      errors.push(`${prefix}.execution_mode: must be "interactive_resident" (got "${obj["execution_mode"]}")`);
    }
  }
  if (obj["compaction_strategy"] !== undefined) {
    if (obj["compaction_strategy"] === "custom_prompt") {
      errors.push(`${prefix}.compaction_strategy: "custom_prompt" is not supported in v1; use "harness_native" or "pod_continuity"`);
    } else if (!VALID_COMPACTION_STRATEGIES.has(obj["compaction_strategy"] as string)) {
      errors.push(`${prefix}.compaction_strategy: must be one of ${[...VALID_COMPACTION_STRATEGIES].join(", ")} (got "${obj["compaction_strategy"]}")`);
    }
  }
  if (obj["restore_policy"] !== undefined && !VALID_RESTORE_POLICIES.has(obj["restore_policy"] as string)) {
    errors.push(`${prefix}.restore_policy: must be one of ${[...VALID_RESTORE_POLICIES].join(", ")} (got "${obj["restore_policy"]}")`);
  }
  return errors;
}

// -- Resource validation --

function validateResourcePaths(resources: Array<{ id: string; path: string }>, category: string): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i]!;
    if (!r.id || typeof r.id !== "string") {
      errors.push(`resources.${category}[${i}].id: must be a non-empty string`);
    } else if (ids.has(r.id)) {
      errors.push(`resources.${category}: duplicate id "${r.id}"`);
    } else {
      ids.add(r.id);
    }
    const pathErr = validateSafePath(r.path, `resources.${category}[${i}].path`);
    if (pathErr) errors.push(pathErr);
  }
  return errors;
}

// -- Public API --

/**
 * Parse raw YAML text into an untyped object.
 * @param yamlText - raw YAML content of agent.yaml
 * @returns parsed object
 */
export function parseAgentSpec(yamlText: string): Record<string, unknown> {
  return parseYaml(yamlText) as Record<string, unknown>;
}

/**
 * Validate a parsed AgentSpec object. Collects all errors.
 * @param raw - parsed YAML object
 * @returns validation result with all errors
 */
export function validateAgentSpec(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["agent spec must be an object"] };
  }

  const obj = raw as Record<string, unknown>;

  // Required fields
  if (!obj["name"] || typeof obj["name"] !== "string") errors.push("name: required non-empty string");
  if (!obj["version"] || typeof obj["version"] !== "string") errors.push("version: required non-empty string");

  // Imports
  if (obj["imports"] !== undefined) {
    if (!Array.isArray(obj["imports"])) {
      errors.push("imports: must be an array");
    } else {
      for (let i = 0; i < (obj["imports"] as unknown[]).length; i++) {
        const imp = (obj["imports"] as Record<string, unknown>[])[i]!;
        const refErr = validateImportRef(imp["ref"] as string, i);
        if (refErr) errors.push(refErr);
        const verErr = validateImportVersion(imp["version"], i);
        if (verErr) errors.push(verErr);
      }
    }
  }

  // Defaults lifecycle
  if (obj["defaults"] && typeof obj["defaults"] === "object") {
    const defaults = obj["defaults"] as Record<string, unknown>;
    if (defaults["lifecycle"]) {
      errors.push(...validateLifecycle(defaults["lifecycle"], "defaults.lifecycle"));
    }
  }

  // Startup
  errors.push(...validateStartupBlock(obj["startup"], "startup"));

  // Profiles shape validation
  if (obj["profiles"] !== undefined && (typeof obj["profiles"] !== "object" || Array.isArray(obj["profiles"]) || obj["profiles"] === null)) {
    errors.push("profiles: must be a map (object), not an array or scalar");
  }

  // Profile startup + lifecycle
  if (obj["profiles"] && typeof obj["profiles"] === "object" && !Array.isArray(obj["profiles"])) {
    for (const [profileName, profileRaw] of Object.entries(obj["profiles"] as Record<string, unknown>)) {
      if (profileRaw && typeof profileRaw === "object") {
        const p = profileRaw as Record<string, unknown>;
        errors.push(...validateStartupBlock(p["startup"], `profiles.${profileName}.startup`));
        if (p["lifecycle"]) {
          errors.push(...validateLifecycle(p["lifecycle"], `profiles.${profileName}.lifecycle`));
        }
      }
    }
  }

  // Resources
  if (obj["resources"] && typeof obj["resources"] === "object") {
    const res = obj["resources"] as Record<string, unknown>;
    const allLocalIds: Record<string, Set<string>> = {};

    for (const category of ["skills", "guidance", "subagents", "hooks", "runtime_resources"]) {
      const items = res[category];
      if (items !== undefined) {
        if (!Array.isArray(items)) {
          errors.push(`resources.${category}: must be an array`);
        } else {
          const entries = items as Array<Record<string, unknown>>;
          errors.push(...validateResourcePaths(entries as Array<{ id: string; path: string }>, category));
          allLocalIds[category] = new Set(entries.map((e) => e["id"] as string).filter(Boolean));

          // runtime_resources must have runtime field
          if (category === "runtime_resources") {
            for (let i = 0; i < entries.length; i++) {
              if (!entries[i]!["runtime"] || typeof entries[i]!["runtime"] !== "string") {
                errors.push(`resources.runtime_resources[${i}].runtime: required non-empty string`);
              }
            }
          }
        }
      } else {
        allLocalIds[category] = new Set();
      }
    }

    // Profile uses validation
    if (obj["profiles"] && typeof obj["profiles"] === "object" && !Array.isArray(obj["profiles"])) {
      for (const [profileName, profileRaw] of Object.entries(obj["profiles"] as Record<string, unknown>)) {
        if (profileRaw && typeof profileRaw === "object") {
          const p = profileRaw as Record<string, unknown>;
          if (p["uses"] && typeof p["uses"] === "object") {
            const uses = p["uses"] as Record<string, unknown>;
            for (const category of ["skills", "guidance", "subagents", "hooks", "runtime_resources"]) {
              const refs = uses[category];
              if (Array.isArray(refs)) {
                for (const ref of refs as string[]) {
                  // Qualified refs (namespace:id) are accepted for later resolution
                  if (typeof ref === "string" && ref.includes(":")) {
                    const parts = ref.split(":");
                    if (parts.length < 2 || !parts[0] || !parts[1]) {
                      errors.push(`profiles.${profileName}.uses.${category}: invalid qualified ref "${ref}" (must be namespace:id)`);
                    }
                    // Otherwise accepted — import resolution in AS-T03
                  } else if (typeof ref === "string") {
                    // Unqualified ref must exist in local declarations
                    if (!allLocalIds[category]?.has(ref)) {
                      errors.push(`profiles.${profileName}.uses.${category}: resource "${ref}" not found in declared resources`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Normalize a validated AgentSpec into the canonical typed shape.
 * Applies defaults for optional fields.
 * @param raw - parsed YAML object (must pass validation first)
 * @returns normalized AgentSpec
 */
export function normalizeAgentSpec(raw: Record<string, unknown>): AgentSpec {
  const imports: ImportSpec[] = Array.isArray(raw["imports"])
    ? (raw["imports"] as Record<string, unknown>[]).map((imp) => ({
        ref: imp["ref"] as string,
        version: imp["version"] as string | undefined,
      }))
    : [];

  const startup = normalizeStartupBlock(raw["startup"]);

  const resources = normalizeResources(raw["resources"]);

  const profiles: Record<string, ProfileSpec> = {};
  if (raw["profiles"] && typeof raw["profiles"] === "object" && !Array.isArray(raw["profiles"])) {
    for (const [name, profileRaw] of Object.entries(raw["profiles"] as Record<string, unknown>)) {
      profiles[name] = normalizeProfile(profileRaw as Record<string, unknown>);
    }
  }

  const defaults = raw["defaults"] as Record<string, unknown> | undefined;

  const result: AgentSpec = {
    version: raw["version"] as string,
    name: raw["name"] as string,
    summary: raw["summary"] as string | undefined,
    imports,
    startup,
    resources,
    profiles,
  };

  if (defaults) {
    result.defaults = {
      runtime: defaults["runtime"] as string | undefined,
      model: defaults["model"] as string | undefined,
    };
    if (defaults["lifecycle"]) {
      result.defaults.lifecycle = normalizeLifecycle(defaults["lifecycle"] as Record<string, unknown>);
    }
  }

  return result;
}

// -- Normalization helpers --

function normalizeStartupBlock(raw: unknown): StartupBlock {
  if (!raw || typeof raw !== "object") return { files: [], actions: [] };
  const obj = raw as Record<string, unknown>;

  const files: StartupFile[] = Array.isArray(obj["files"])
    ? (obj["files"] as Record<string, unknown>[]).map((f) => ({
        path: f["path"] as string,
        deliveryHint: (f["delivery_hint"] as StartupFile["deliveryHint"]) ?? "auto",
        required: f["required"] !== false,
        appliesOn: Array.isArray(f["applies_on"])
          ? (f["applies_on"] as StartupFile["appliesOn"])
          : ["fresh_start", "restore"],
      }))
    : [];

  const actions: StartupAction[] = Array.isArray(obj["actions"])
    ? (obj["actions"] as Record<string, unknown>[]).map((a) => ({
        type: a["type"] as StartupAction["type"],
        value: a["value"] as string,
        phase: (a["phase"] as StartupAction["phase"]) ?? "after_files",
        appliesOn: Array.isArray(a["applies_on"])
          ? (a["applies_on"] as StartupAction["appliesOn"])
          : ["fresh_start", "restore"],
        idempotent: a["idempotent"] as boolean,
      }))
    : [];

  return { files, actions };
}

function normalizeLifecycle(raw: Record<string, unknown>): LifecycleDefaults {
  return {
    executionMode: (raw["execution_mode"] as LifecycleDefaults["executionMode"]) ?? "interactive_resident",
    compactionStrategy: (raw["compaction_strategy"] as LifecycleDefaults["compactionStrategy"]) ?? "harness_native",
    restorePolicy: (raw["restore_policy"] as LifecycleDefaults["restorePolicy"]) ?? "resume_if_possible",
  };
}

function normalizeResources(raw: unknown): AgentResources {
  if (!raw || typeof raw !== "object") {
    return { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] };
  }
  const obj = raw as Record<string, unknown>;

  return {
    skills: Array.isArray(obj["skills"])
      ? (obj["skills"] as Record<string, unknown>[]).map((s) => ({ id: s["id"] as string, path: s["path"] as string }))
      : [],
    guidance: Array.isArray(obj["guidance"])
      ? (obj["guidance"] as Record<string, unknown>[]).map((g) => ({
          id: g["id"] as string, path: g["path"] as string,
          target: g["target"] as string, merge: (g["merge"] as GuidanceResource["merge"]) ?? "managed_block",
        }))
      : [],
    subagents: Array.isArray(obj["subagents"])
      ? (obj["subagents"] as Record<string, unknown>[]).map((s) => ({ id: s["id"] as string, path: s["path"] as string }))
      : [],
    hooks: Array.isArray(obj["hooks"])
      ? (obj["hooks"] as Record<string, unknown>[]).map((h) => ({
          id: h["id"] as string, path: h["path"] as string,
          runtimes: Array.isArray(h["runtimes"]) ? h["runtimes"] as string[] : undefined,
        }))
      : [],
    runtimeResources: Array.isArray(obj["runtime_resources"])
      ? (obj["runtime_resources"] as Record<string, unknown>[]).map((r) => ({
          id: r["id"] as string, path: r["path"] as string,
          runtime: r["runtime"] as string, type: r["type"] as string,
        }))
      : [],
  };
}

function normalizeProfile(raw: Record<string, unknown>): ProfileSpec {
  const uses = raw["uses"] as Record<string, unknown> | undefined;
  return {
    summary: raw["summary"] as string | undefined,
    preferences: raw["preferences"] as { runtime?: string; model?: string } | undefined,
    startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
    lifecycle: raw["lifecycle"] ? normalizeLifecycle(raw["lifecycle"] as Record<string, unknown>) : undefined,
    uses: {
      skills: Array.isArray(uses?.["skills"]) ? uses["skills"] as string[] : [],
      guidance: Array.isArray(uses?.["guidance"]) ? uses["guidance"] as string[] : [],
      subagents: Array.isArray(uses?.["subagents"]) ? uses["subagents"] as string[] : [],
      hooks: Array.isArray(uses?.["hooks"]) ? uses["hooks"] as string[] : [],
      runtimeResources: Array.isArray(uses?.["runtime_resources"]) ? uses["runtime_resources"] as string[] : [],
    },
  };
}
