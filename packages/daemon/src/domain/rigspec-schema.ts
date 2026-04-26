import type {
  LegacyRigSpec,
  LegacyRigSpecNode,
  LegacyRigSpecEdge,
  RigSpec,
  RigSpecPod,
  RigServicesSpec,
  RigServicesWaitTarget,
  RigServicesSurface,
  RigServicesCheckpointHook,
  ValidationResult,
} from "./types.js";
import { validateSafePath } from "./path-safety.js";
import { validateStartupBlock, normalizeStartupBlock } from "./startup-validation.js";
import { COMPOSE_PROJECT_NAME_PATTERN, deriveComposeProjectName } from "./compose-project-name.js";

// -- Canonical pod-aware RigSpec validation (AgentSpec reboot) --

const VALID_EDGE_KINDS = new Set(["delegates_to", "spawned_by", "can_observe", "collaborates_with", "escalates_to"]);
const VALID_SYNC_TRIGGERS = new Set(["pre_compaction", "pre_shutdown", "manual", "milestone"]);
const VALID_RESTORE_POLICIES = new Set(["resume_if_possible", "relaunch_fresh", "checkpoint_only"]);
const VALID_IMPORT_PREFIXES = ["local:", "path:"];
const VALID_SERVICES_KIND = new Set(["compose"]);
const VALID_DOWN_POLICIES = new Set(["leave_running", "down", "down_and_volumes"]);
const VALID_WAIT_TARGET_CONDITIONS = new Set(["healthy"]);

/**
 * Pod-aware RigSpec validator. Canonical contract for the AgentSpec reboot.
 */
export class RigSpecSchema {
  /**
   * Validate a parsed rig spec object. Collects all errors.
   * @param raw - parsed YAML object
   * @returns validation result
   */
  static validate(raw: unknown, opts?: { externalQualifiedIds?: Iterable<string> }): ValidationResult {
    const errors: string[] = [];

    if (!raw || typeof raw !== "object") {
      return { valid: false, errors: ["rig spec must be an object"] };
    }

    const obj = raw as Record<string, unknown>;

    // Required fields
    if (!obj["name"] || typeof obj["name"] !== "string") errors.push("name: required non-empty string");
    if (!obj["version"] || typeof obj["version"] !== "string") errors.push("version: required non-empty string");

    // culture_file path safety
    if (obj["culture_file"] !== undefined && obj["culture_file"] !== null) {
      if (typeof obj["culture_file"] !== "string") {
        errors.push("culture_file: must be a string");
      } else {
        const pathErr = validateSafePath(obj["culture_file"] as string, "culture_file");
        if (pathErr) errors.push(pathErr);
      }
    }

    // docs: optional array of documentation file paths
    if (obj["docs"] !== undefined) {
      if (!Array.isArray(obj["docs"])) {
        errors.push("docs: must be an array");
      } else {
        for (let i = 0; i < (obj["docs"] as unknown[]).length; i++) {
          const entry = (obj["docs"] as unknown[])[i];
          if (!entry || typeof entry !== "object") {
            errors.push(`docs[${i}]: must be an object with a path field`);
            continue;
          }
          const doc = entry as Record<string, unknown>;
          if (!doc["path"] || typeof doc["path"] !== "string") {
            errors.push(`docs[${i}].path: required non-empty string`);
          } else {
            const pathErr = validateSafePath(doc["path"] as string, `docs[${i}].path`);
            if (pathErr) errors.push(pathErr);
          }
        }
      }
    }

    // rig-level startup
    if (obj["startup"] !== undefined) {
      errors.push(...validateStartupBlock(obj["startup"], "startup"));
    }

    // services: optional top-level sibling of pods
    if (obj["services"] !== undefined) {
      errors.push(...validateServicesBlock(obj["services"], "services"));
    }

    // pods: required array
    if (!obj["pods"] || !Array.isArray(obj["pods"])) {
      errors.push("pods: required non-empty array");
    } else {
      const pods = obj["pods"] as Record<string, unknown>[];
      if (pods.length === 0) errors.push("pods: must contain at least one pod");

      const podIds = new Set<string>();
      for (let pi = 0; pi < pods.length; pi++) {
        const pod = pods[pi]!;
        errors.push(...validatePod(pod, pi, podIds));
      }

      // Cross-pod edge validation
      const allQualifiedIds = new Set<string>(opts?.externalQualifiedIds ?? []);
      for (const pod of pods) {
        const podId = pod["id"] as string;
        const members = pod["members"] as Record<string, unknown>[] | undefined;
        if (podId && Array.isArray(members)) {
          for (const m of members) {
            if (m["id"]) allQualifiedIds.add(`${podId}.${m["id"]}`);
          }
        }
      }

      if (obj["edges"] !== undefined) {
        if (!Array.isArray(obj["edges"])) {
          errors.push("edges: must be an array");
        } else {
          for (let ei = 0; ei < (obj["edges"] as unknown[]).length; ei++) {
            const edge = (obj["edges"] as Record<string, unknown>[])[ei]!;
            errors.push(...validateCrossPodEdge(edge, ei, allQualifiedIds));
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Normalize a validated rig spec into the canonical typed shape.
   * @param raw - parsed YAML object (must pass validation first)
   * @returns normalized RigSpec
   */
  static normalize(raw: Record<string, unknown>): RigSpec {
    const pods = (raw["pods"] as Record<string, unknown>[]).map(normalizePod);
    const edges = Array.isArray(raw["edges"])
      ? (raw["edges"] as Record<string, unknown>[]).map((e) => ({
          kind: e["kind"] as string,
          from: e["from"] as string,
          to: e["to"] as string,
        }))
      : [];

    const docs = Array.isArray(raw["docs"])
      ? (raw["docs"] as Record<string, unknown>[]).map((d) => ({ path: d["path"] as string }))
      : undefined;

    return {
      version: raw["version"] as string,
      name: raw["name"] as string,
      summary: raw["summary"] as string | undefined,
      cultureFile: raw["culture_file"] as string | undefined,
      docs,
      startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
      services: raw["services"] ? normalizeServicesBlock(raw["services"], raw["name"] as string) : undefined,
      pods,
      edges,
    };
  }
}

// -- Pod validation --

function validatePod(pod: Record<string, unknown>, index: number, podIds: Set<string>): string[] {
  const errors: string[] = [];
  const prefix = `pods[${index}]`;

  // id
  if (!pod["id"] || typeof pod["id"] !== "string") {
    errors.push(`${prefix}.id: required non-empty string`);
  } else {
    const id = pod["id"] as string;
    if (id.includes(".")) errors.push(`${prefix}.id: must not contain dots (got "${id}")`);
    if (podIds.has(id)) errors.push(`${prefix}.id: duplicate pod id "${id}"`);
    podIds.add(id);
  }

  // label
  if (!pod["label"] || typeof pod["label"] !== "string") {
    errors.push(`${prefix}.label: required non-empty string`);
  }

  // continuity_policy
  if (pod["continuity_policy"] !== undefined) {
    errors.push(...validateContinuityPolicy(pod["continuity_policy"], `${prefix}.continuity_policy`));
  }

  // pod startup
  if (pod["startup"] !== undefined) {
    errors.push(...validateStartupBlock(pod["startup"], `${prefix}.startup`));
  }

  // members
  if (!pod["members"] || !Array.isArray(pod["members"])) {
    errors.push(`${prefix}.members: required array`);
  } else {
    const members = pod["members"] as Record<string, unknown>[];
    const memberIds = new Set<string>();
    for (let mi = 0; mi < members.length; mi++) {
      errors.push(...validateMember(members[mi]!, mi, `${prefix}`, memberIds));
    }

    // Pod-local edges
    if (pod["edges"] !== undefined) {
      if (!Array.isArray(pod["edges"])) {
        errors.push(`${prefix}.edges: must be an array`);
      } else {
        for (let ei = 0; ei < (pod["edges"] as unknown[]).length; ei++) {
          const edge = (pod["edges"] as Record<string, unknown>[])[ei]!;
          errors.push(...validatePodLocalEdge(edge, ei, `${prefix}`, memberIds));
        }
      }
    }
  }

  return errors;
}

function validateMember(member: Record<string, unknown>, index: number, podPrefix: string, memberIds: Set<string>): string[] {
  const errors: string[] = [];
  const prefix = `${podPrefix}.members[${index}]`;

  if (!member["id"] || typeof member["id"] !== "string") {
    errors.push(`${prefix}.id: required non-empty string`);
  } else {
    const id = member["id"] as string;
    if (id.includes(".")) errors.push(`${prefix}.id: must not contain dots (got "${id}")`);
    if (memberIds.has(id)) errors.push(`${prefix}.id: duplicate member id "${id}"`);
    memberIds.add(id);
  }

  if (!member["agent_ref"] || typeof member["agent_ref"] !== "string") {
    errors.push(`${prefix}.agent_ref: required non-empty string`);
  }
  if (!member["profile"] || typeof member["profile"] !== "string") {
    errors.push(`${prefix}.profile: required non-empty string`);
  }
  if (!member["runtime"] || typeof member["runtime"] !== "string") {
    errors.push(`${prefix}.runtime: required non-empty string`);
  }
  if (member["codex_config_profile"] !== undefined) {
    if (typeof member["codex_config_profile"] !== "string" || !member["codex_config_profile"].trim()) {
      errors.push(`${prefix}.codex_config_profile: must be a non-empty string`);
    } else if (!/^[A-Za-z0-9_.-]+$/.test(member["codex_config_profile"])) {
      errors.push(`${prefix}.codex_config_profile: must contain only letters, numbers, underscores, dots, or hyphens`);
    } else if (member["runtime"] !== "codex") {
      errors.push(`${prefix}.codex_config_profile: only valid when runtime is "codex"`);
    }
  }
  if (!member["cwd"] || typeof member["cwd"] !== "string") {
    errors.push(`${prefix}.cwd: required non-empty string`);
  }

  // Terminal sentinel validation: exact triple required
  const isTerminalRuntime = member["runtime"] === "terminal";
  const isTerminalRef = member["agent_ref"] === "builtin:terminal";
  const isNoneProfile = member["profile"] === "none";

  if (isTerminalRuntime) {
    if (!isTerminalRef) {
      errors.push(`${prefix}: terminal runtime requires agent_ref "builtin:terminal" (got "${member["agent_ref"]}")`);
    }
    if (!isNoneProfile) {
      errors.push(`${prefix}: terminal runtime requires profile "none" (got "${member["profile"]}")`);
    }
  } else {
    if (isTerminalRef) {
      errors.push(`${prefix}: agent_ref "builtin:terminal" is only valid with runtime "terminal" (got runtime "${member["runtime"]}")`);
    }
    if (isNoneProfile && typeof member["profile"] === "string") {
      errors.push(`${prefix}: profile "none" is only valid with runtime "terminal" (got runtime "${member["runtime"]}")`);
    }
  }

  // restore_policy: closed set
  if (member["restore_policy"] !== undefined && member["restore_policy"] !== null) {
    if (!VALID_RESTORE_POLICIES.has(member["restore_policy"] as string)) {
      errors.push(`${prefix}.restore_policy: must be one of ${[...VALID_RESTORE_POLICIES].join(", ")} (got "${member["restore_policy"]}")`);
    }
  }

  // agent_ref: must be local: or path: with correct shape (skip for terminal sentinel)
  if (typeof member["agent_ref"] === "string" && !isTerminalRef) {
    const ref = member["agent_ref"] as string;
    const hasValidPrefix = VALID_IMPORT_PREFIXES.some((p) => ref.startsWith(p));
    if (!hasValidPrefix) {
      errors.push(`${prefix}.agent_ref: must start with "local:" or "path:" (got "${ref}")`);
    } else if (ref.startsWith("local:")) {
      const path = ref.slice("local:".length);
      if (!path) errors.push(`${prefix}.agent_ref: local: ref must have a path`);
      else if (path.startsWith("/")) errors.push(`${prefix}.agent_ref: local: ref must be a relative path (got "${ref}")`);
    } else if (ref.startsWith("path:")) {
      const path = ref.slice("path:".length);
      if (!path) errors.push(`${prefix}.agent_ref: path: ref must have a path`);
      else if (!path.startsWith("/")) errors.push(`${prefix}.agent_ref: path: ref must be an absolute path (got "${ref}")`);
    }
  }

  // Member startup block validation
  if (member["startup"] !== undefined) {
    errors.push(...validateStartupBlock(member["startup"], `${prefix}.startup`));
  }

  return errors;
}

function validatePodLocalEdge(edge: Record<string, unknown>, index: number, podPrefix: string, memberIds: Set<string>): string[] {
  const errors: string[] = [];
  const prefix = `${podPrefix}.edges[${index}]`;
  const from = edge["from"] as string;
  const to = edge["to"] as string;
  const kind = edge["kind"] as string;

  if (!kind || !VALID_EDGE_KINDS.has(kind)) {
    errors.push(`${prefix}.kind: must be one of ${[...VALID_EDGE_KINDS].join(", ")} (got "${kind}")`);
  }
  if (!from || typeof from !== "string") {
    errors.push(`${prefix}.from: required string`);
  } else if (from.includes(".")) {
    errors.push(`${prefix}.from: pod-local edge must use unqualified member id, not fully-qualified (got "${from}")`);
  } else if (!memberIds.has(from)) {
    errors.push(`${prefix}.from: member "${from}" not found in pod`);
  }
  if (!to || typeof to !== "string") {
    errors.push(`${prefix}.to: required string`);
  } else if (to.includes(".")) {
    errors.push(`${prefix}.to: pod-local edge must use unqualified member id, not fully-qualified (got "${to}")`);
  } else if (!memberIds.has(to)) {
    errors.push(`${prefix}.to: member "${to}" not found in pod`);
  }

  return errors;
}

function validateCrossPodEdge(edge: Record<string, unknown>, index: number, allQualifiedIds: Set<string>): string[] {
  const errors: string[] = [];
  const prefix = `edges[${index}]`;
  const from = edge["from"] as string;
  const to = edge["to"] as string;
  const kind = edge["kind"] as string;

  if (!kind || !VALID_EDGE_KINDS.has(kind)) {
    errors.push(`${prefix}.kind: must be one of ${[...VALID_EDGE_KINDS].join(", ")} (got "${kind}")`);
  }
  if (!from || typeof from !== "string") {
    errors.push(`${prefix}.from: required string`);
  } else if (!from.includes(".")) {
    errors.push(`${prefix}.from: cross-pod edge must use fully-qualified pod.member id (got "${from}")`);
  } else if (!allQualifiedIds.has(from)) {
    errors.push(`${prefix}.from: "${from}" does not resolve to a pod member`);
  }
  if (!to || typeof to !== "string") {
    errors.push(`${prefix}.to: required string`);
  } else if (!to.includes(".")) {
    errors.push(`${prefix}.to: cross-pod edge must use fully-qualified pod.member id (got "${to}")`);
  } else if (!allQualifiedIds.has(to)) {
    errors.push(`${prefix}.to: "${to}" does not resolve to a pod member`);
  }

  // Same-pod check: cross-pod edges must reference different pods
  if (from && to && from.includes(".") && to.includes(".")) {
    const fromPod = from.split(".")[0];
    const toPod = to.split(".")[0];
    if (fromPod === toPod) {
      errors.push(`${prefix}: cross-pod edge must reference different pods (both reference "${fromPod}"); use pod-local edges instead`);
    }
  }

  return errors;
}

function validateServicesBlock(raw: unknown, prefix: string): string[] {
  if (!raw || typeof raw !== "object") return [`${prefix}: must be an object`];

  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!obj["kind"] || typeof obj["kind"] !== "string" || !VALID_SERVICES_KIND.has(obj["kind"] as string)) {
    errors.push(`${prefix}.kind: must be one of ${[...VALID_SERVICES_KIND].join(", ")} (got "${obj["kind"]}")`);
  }

  if (!obj["compose_file"] || typeof obj["compose_file"] !== "string") {
    errors.push(`${prefix}.compose_file: required non-empty string`);
  } else {
    const pathErr = validateSafePath(obj["compose_file"] as string, `${prefix}.compose_file`);
    if (pathErr) errors.push(pathErr);
  }

  if (obj["project_name"] !== undefined) {
    if (typeof obj["project_name"] !== "string") {
      errors.push(`${prefix}.project_name: must be a string`);
    } else if (!COMPOSE_PROJECT_NAME_PATTERN.test(obj["project_name"] as string)) {
      errors.push(`${prefix}.project_name: must match ${COMPOSE_PROJECT_NAME_PATTERN.source} (got "${obj["project_name"]}")`);
    }
  }

  if (obj["profiles"] !== undefined) {
    if (!Array.isArray(obj["profiles"])) {
      errors.push(`${prefix}.profiles: must be an array`);
    } else {
      obj["profiles"].forEach((p, index) => {
        if (typeof p !== "string" || !p) errors.push(`${prefix}.profiles[${index}]: must be a non-empty string`);
      });
    }
  }

  if (obj["down_policy"] !== undefined && !VALID_DOWN_POLICIES.has(obj["down_policy"] as string)) {
    errors.push(`${prefix}.down_policy: must be one of ${[...VALID_DOWN_POLICIES].join(", ")} (got "${obj["down_policy"]}")`);
  }

  if (obj["wait_for"] !== undefined) {
    if (!Array.isArray(obj["wait_for"])) {
      errors.push(`${prefix}.wait_for: must be an array`);
    } else {
      for (let i = 0; i < (obj["wait_for"] as unknown[]).length; i++) {
        errors.push(...validateWaitTarget((obj["wait_for"] as Record<string, unknown>[])[i]!, i, prefix));
      }
    }
  }

  if (obj["surfaces"] !== undefined) {
    errors.push(...validateSurfaces(obj["surfaces"], prefix));
  }

  if (obj["checkpoints"] !== undefined) {
    errors.push(...validateCheckpointHooks(obj["checkpoints"], prefix));
  }

  return errors;
}

function validateWaitTarget(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  const errors: string[] = [];
  const targetPrefix = `${prefix}.wait_for[${index}]`;
  const hasService = typeof raw["service"] === "string" && raw["service"];
  const hasUrl = typeof raw["url"] === "string" && raw["url"];
  const hasTcp = typeof raw["tcp"] === "string" && raw["tcp"];
  const targetCount = [hasService, hasUrl, hasTcp].filter(Boolean).length;

  if (targetCount === 0) {
    errors.push(`${targetPrefix}: must define exactly one of service, url, or tcp`);
  } else if (targetCount > 1) {
    errors.push(`${targetPrefix}: must define exactly one of service, url, or tcp`);
  }

  if (hasService) {
    if (!raw["condition"] || raw["condition"] !== "healthy") {
      errors.push(`${targetPrefix}.condition: service targets must use condition "healthy"`);
    }
  }

  if (raw["condition"] !== undefined && !VALID_WAIT_TARGET_CONDITIONS.has(raw["condition"] as string)) {
    errors.push(`${targetPrefix}.condition: must be one of ${[...VALID_WAIT_TARGET_CONDITIONS].join(", ")} (got "${raw["condition"]}")`);
  } else if (!hasService && raw["condition"] !== undefined) {
    errors.push(`${targetPrefix}.condition: only service targets may specify condition`);
  }

  return errors;
}

function validateSurfaces(raw: unknown, prefix: string): string[] {
  if (!raw || typeof raw !== "object") return [`${prefix}.surfaces: must be an object`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (obj["urls"] !== undefined) {
    if (!Array.isArray(obj["urls"])) {
      errors.push(`${prefix}.surfaces.urls: must be an array`);
    } else {
      for (let i = 0; i < (obj["urls"] as unknown[]).length; i++) {
        const url = (obj["urls"] as Record<string, unknown>[])[i]!;
        if (!url["name"] || typeof url["name"] !== "string") {
          errors.push(`${prefix}.surfaces.urls[${i}].name: required non-empty string`);
        }
        if (!url["url"] || typeof url["url"] !== "string") {
          errors.push(`${prefix}.surfaces.urls[${i}].url: required non-empty string`);
        }
      }
    }
  }

  if (obj["commands"] !== undefined) {
    if (!Array.isArray(obj["commands"])) {
      errors.push(`${prefix}.surfaces.commands: must be an array`);
    } else {
      for (let i = 0; i < (obj["commands"] as unknown[]).length; i++) {
        const command = (obj["commands"] as Record<string, unknown>[])[i]!;
        if (!command["name"] || typeof command["name"] !== "string") {
          errors.push(`${prefix}.surfaces.commands[${i}].name: required non-empty string`);
        }
        if (!command["command"] || typeof command["command"] !== "string") {
          errors.push(`${prefix}.surfaces.commands[${i}].command: required non-empty string`);
        }
      }
    }
  }

  return errors;
}

function validateCheckpointHooks(raw: unknown, prefix: string): string[] {
  if (!raw || typeof raw !== "object") return [`${prefix}.checkpoints: must be an array`];
  if (!Array.isArray(raw)) return [`${prefix}.checkpoints: must be an array`];

  const errors: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const hook = raw[i] as Record<string, unknown>;
    if (!hook["id"] || typeof hook["id"] !== "string") {
      errors.push(`${prefix}.checkpoints[${i}].id: required non-empty string`);
    }
    if (!hook["export"] || typeof hook["export"] !== "string") {
      errors.push(`${prefix}.checkpoints[${i}].export: required non-empty string`);
    }
    if (hook["import"] !== undefined && typeof hook["import"] !== "string") {
      errors.push(`${prefix}.checkpoints[${i}].import: must be a string`);
    }
  }

  return errors;
}

function normalizeServicesBlock(raw: unknown, rigName: string): RigServicesSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const waitFor = Array.isArray(obj["wait_for"])
    ? (obj["wait_for"] as Record<string, unknown>[]).map((target) => normalizeWaitTarget(target))
    : undefined;
  const surfaces = obj["surfaces"] ? normalizeSurfaces(obj["surfaces"]) : undefined;
  const checkpoints = Array.isArray(obj["checkpoints"])
    ? (obj["checkpoints"] as Record<string, unknown>[]).map((hook) => normalizeCheckpointHook(hook))
    : undefined;

  return {
    kind: obj["kind"] as "compose",
    composeFile: obj["compose_file"] as string,
    projectName: obj["project_name"] as string | undefined ?? deriveComposeProjectName(rigName),
    profiles: Array.isArray(obj["profiles"]) ? (obj["profiles"] as string[]) : undefined,
    downPolicy: obj["down_policy"] as RigServicesSpec["downPolicy"] | undefined,
    waitFor,
    surfaces,
    checkpoints,
  };
}

function normalizeWaitTarget(raw: Record<string, unknown>): RigServicesWaitTarget {
  return {
    service: raw["service"] as string | undefined,
    condition: raw["condition"] as RigServicesWaitTarget["condition"] | undefined,
    url: raw["url"] as string | undefined,
    tcp: raw["tcp"] as string | undefined,
  };
}

function normalizeSurfaces(raw: unknown): RigServicesSurface | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    urls: Array.isArray(obj["urls"])
      ? (obj["urls"] as Record<string, unknown>[]).map((u) => ({ name: u["name"] as string, url: u["url"] as string }))
      : undefined,
    commands: Array.isArray(obj["commands"])
      ? (obj["commands"] as Record<string, unknown>[]).map((c) => ({ name: c["name"] as string, command: c["command"] as string }))
      : undefined,
  };
}

function normalizeCheckpointHook(raw: Record<string, unknown>): RigServicesCheckpointHook {
  return {
    id: raw["id"] as string,
    exportCommand: raw["export"] as string,
    importCommand: raw["import"] as string | undefined,
  };
}

function validateContinuityPolicy(raw: unknown, prefix: string): string[] {
  if (typeof raw !== "object" || raw === null) return [`${prefix}: must be an object`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj["enabled"] !== "boolean") {
    errors.push(`${prefix}.enabled: required boolean`);
  }
  if (obj["sync_triggers"] !== undefined) {
    if (!Array.isArray(obj["sync_triggers"])) {
      errors.push(`${prefix}.sync_triggers: must be an array`);
    } else {
      for (const t of obj["sync_triggers"] as string[]) {
        if (!VALID_SYNC_TRIGGERS.has(t)) {
          errors.push(`${prefix}.sync_triggers: invalid trigger "${t}"; must be one of ${[...VALID_SYNC_TRIGGERS].join(", ")}`);
        }
      }
    }
  }

  if (obj["artifacts"] !== undefined) {
    if (typeof obj["artifacts"] !== "object" || obj["artifacts"] === null || Array.isArray(obj["artifacts"])) {
      errors.push(`${prefix}.artifacts: must be an object`);
    } else {
      const art = obj["artifacts"] as Record<string, unknown>;
      for (const key of ["session_log", "restore_brief", "quiz"]) {
        if (art[key] !== undefined && typeof art[key] !== "boolean") {
          errors.push(`${prefix}.artifacts.${key}: must be a boolean`);
        }
      }
    }
  }

  if (obj["restore_protocol"] !== undefined) {
    if (typeof obj["restore_protocol"] !== "object" || obj["restore_protocol"] === null || Array.isArray(obj["restore_protocol"])) {
      errors.push(`${prefix}.restore_protocol: must be an object`);
    } else {
      const rp = obj["restore_protocol"] as Record<string, unknown>;
      for (const key of ["peer_driven", "verify_via_quiz"]) {
        if (rp[key] !== undefined && typeof rp[key] !== "boolean") {
          errors.push(`${prefix}.restore_protocol.${key}: must be a boolean`);
        }
      }
    }
  }

  return errors;
}

// -- Normalization helpers --

function normalizePod(raw: Record<string, unknown>): RigSpecPod {
  const members = (raw["members"] as Record<string, unknown>[]).map((m) => ({
    id: m["id"] as string,
    label: m["label"] as string | undefined,
    agentRef: m["agent_ref"] as string,
    profile: m["profile"] as string,
    runtime: m["runtime"] as string,
    codexConfigProfile: m["codex_config_profile"] as string | undefined,
    model: m["model"] as string | undefined,
    cwd: m["cwd"] as string,
    restorePolicy: m["restore_policy"] as string | undefined,
    startup: m["startup"] ? normalizeStartupBlock(m["startup"]) : undefined,
  }));

  const edges = Array.isArray(raw["edges"])
    ? (raw["edges"] as Record<string, unknown>[]).map((e) => ({
        kind: e["kind"] as string,
        from: e["from"] as string,
        to: e["to"] as string,
      }))
    : [];

  const cp = raw["continuity_policy"] as Record<string, unknown> | undefined;

  return {
    id: raw["id"] as string,
    label: raw["label"] as string,
    summary: raw["summary"] as string | undefined,
    continuityPolicy: cp ? {
      enabled: cp["enabled"] as boolean,
      syncTriggers: cp["sync_triggers"] as string[] | undefined,
      artifacts: cp["artifacts"] && typeof cp["artifacts"] === "object" ? {
        sessionLog: (cp["artifacts"] as Record<string, unknown>)["session_log"] as boolean | undefined,
        restoreBrief: (cp["artifacts"] as Record<string, unknown>)["restore_brief"] as boolean | undefined,
        quiz: (cp["artifacts"] as Record<string, unknown>)["quiz"] as boolean | undefined,
      } : undefined,
      restoreProtocol: cp["restore_protocol"] && typeof cp["restore_protocol"] === "object" ? {
        peerDriven: (cp["restore_protocol"] as Record<string, unknown>)["peer_driven"] as boolean | undefined,
        verifyViaQuiz: (cp["restore_protocol"] as Record<string, unknown>)["verify_via_quiz"] as boolean | undefined,
      } : undefined,
    } : undefined,
    startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
    members,
    edges,
  };
}

// -- Legacy flat-node RigSpec validation (pre-reboot) --
// TODO: Remove when AS-T08b/AS-T12 migrate all consumers

const LEGACY_KNOWN_RUNTIMES = new Set(["claude-code", "codex"]);
const LEGACY_KNOWN_RESTORE_POLICIES = new Set(["resume_if_possible", "relaunch_fresh", "checkpoint_only"]);
const LEGACY_KNOWN_EDGE_KINDS = new Set(["delegates_to", "spawned_by", "can_observe"]);

export class LegacyRigSpecSchema {
  static validate(raw: unknown): ValidationResult {
    const errors: string[] = [];

    if (!raw || typeof raw !== "object") {
      return { valid: false, errors: ["spec must be an object"] };
    }

    const obj = raw as Record<string, unknown>;

    if (obj["schema_version"] != null && obj["schema_version"] !== 1) {
      errors.push(`schema_version must be 1, got ${obj["schema_version"]}`);
    }

    if (!obj["name"] || typeof obj["name"] !== "string") {
      errors.push("name is required and must be a string");
    }
    if (!obj["version"] || typeof obj["version"] !== "string") {
      errors.push("version is required and must be a string");
    }

    if (!obj["nodes"] || !Array.isArray(obj["nodes"])) {
      errors.push("nodes is required and must be an array");
    }

    if (obj["edges"] !== undefined && !Array.isArray(obj["edges"])) {
      errors.push("edges must be an array if present");
    }

    const nodeIds = new Set<string>();
    if (Array.isArray(obj["nodes"])) {
      for (const node of obj["nodes"] as Record<string, unknown>[]) {
        if (!node["id"] || typeof node["id"] !== "string") {
          errors.push("each node must have a string id");
          continue;
        }

        if (nodeIds.has(node["id"] as string)) {
          errors.push(`duplicate node id: ${node["id"]}`);
        }
        nodeIds.add(node["id"] as string);

        if (!node["runtime"] || typeof node["runtime"] !== "string") {
          errors.push(`node ${node["id"]}: runtime is required`);
        } else if (!LEGACY_KNOWN_RUNTIMES.has(node["runtime"] as string)) {
          errors.push(`node ${node["id"]}: unknown runtime '${node["runtime"]}'`);
        }

        if (node["restore_policy"] != null && !LEGACY_KNOWN_RESTORE_POLICIES.has(node["restore_policy"] as string)) {
          errors.push(`node ${node["id"]}: unknown restorePolicy '${node["restore_policy"]}'`);
        }

        if (node["package_refs"] != null) {
          if (!Array.isArray(node["package_refs"])) {
            errors.push(`node ${node["id"]}: package_refs must be an array`);
          } else if (!(node["package_refs"] as unknown[]).every((r) => typeof r === "string")) {
            errors.push(`node ${node["id"]}: package_refs must contain only strings`);
          }
        }
      }
    }

    if (Array.isArray(obj["edges"])) {
      for (const edge of obj["edges"] as Record<string, unknown>[]) {
        const from = edge["from"] as string | undefined;
        const to = edge["to"] as string | undefined;
        const kind = edge["kind"] as string | undefined;

        if (!from || typeof from !== "string") { errors.push("each edge must have a string 'from' field"); continue; }
        if (!to || typeof to !== "string") { errors.push("each edge must have a string 'to' field"); continue; }
        if (!kind || typeof kind !== "string") { errors.push("each edge must have a string 'kind' field"); continue; }

        if (from === to) errors.push(`self-edge not allowed: ${from} -> ${to}`);
        if (from && !nodeIds.has(from)) errors.push(`edge references nonexistent node: '${from}'`);
        if (to && !nodeIds.has(to)) errors.push(`edge references nonexistent node: '${to}'`);
        if (kind && !LEGACY_KNOWN_EDGE_KINDS.has(kind)) errors.push(`unknown edge kind: '${kind}'`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  static normalize(raw: unknown): LegacyRigSpec {
    const result = this.validate(raw);
    if (!result.valid) {
      throw new Error(`RigSpec validation failed: ${result.errors.join("; ")}`);
    }

    const obj = raw as Record<string, unknown>;
    const rawNodes = obj["nodes"] as Record<string, unknown>[];
    const rawEdges = (obj["edges"] as Record<string, unknown>[] | undefined) ?? [];

    const nodes: LegacyRigSpecNode[] = rawNodes.map((n) => ({
      id: n["id"] as string,
      runtime: n["runtime"] as string,
      role: (n["role"] as string) ?? undefined,
      model: (n["model"] as string) ?? undefined,
      cwd: (n["cwd"] as string) ?? undefined,
      surfaceHint: (n["surface_hint"] as string) ?? undefined,
      workspace: (n["workspace"] as string) ?? undefined,
      restorePolicy: (n["restore_policy"] as string) ?? "resume_if_possible",
      packageRefs: (n["package_refs"] as string[]) ?? [],
    }));

    const edges: LegacyRigSpecEdge[] = rawEdges.map((e) => ({
      from: e["from"] as string,
      to: e["to"] as string,
      kind: e["kind"] as string,
    }));

    return {
      schemaVersion: (obj["schema_version"] as number) ?? 1,
      name: obj["name"] as string,
      version: obj["version"] as string,
      nodes,
      edges,
    };
  }
}
