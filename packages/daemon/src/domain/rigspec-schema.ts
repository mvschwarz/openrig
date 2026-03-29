import type { LegacyRigSpec, LegacyRigSpecNode, LegacyRigSpecEdge, RigSpec, RigSpecPod, ValidationResult, StartupBlock, StartupFile, StartupAction } from "./types.js";
import { validateSafePath } from "./path-safety.js";

// -- Canonical pod-aware RigSpec validation (AgentSpec reboot) --

const VALID_EDGE_KINDS = new Set(["delegates_to", "spawned_by", "can_observe", "collaborates_with", "escalates_to"]);
const VALID_SYNC_TRIGGERS = new Set(["pre_compaction", "pre_shutdown", "manual", "milestone"]);

/**
 * Pod-aware RigSpec validator. Canonical contract for the AgentSpec reboot.
 */
export class RigSpecSchema {
  /**
   * Validate a parsed rig spec object. Collects all errors.
   * @param raw - parsed YAML object
   * @returns validation result
   */
  static validate(raw: unknown): ValidationResult {
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

    // rig-level startup
    if (obj["startup"] !== undefined) {
      errors.push(...validateStartupBlock(obj["startup"], "startup"));
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
      const allQualifiedIds = new Set<string>();
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

    return {
      version: raw["version"] as string,
      name: raw["name"] as string,
      summary: raw["summary"] as string | undefined,
      cultureFile: raw["culture_file"] as string | undefined,
      startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
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
  if (!member["cwd"] || typeof member["cwd"] !== "string") {
    errors.push(`${prefix}.cwd: required non-empty string`);
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

  return errors;
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
      artifacts: cp["artifacts"] as { sessionLog?: boolean; restoreBrief?: boolean; quiz?: boolean } | undefined,
      restoreProtocol: cp["restore_protocol"] as { peerDriven?: boolean; verifyViaQuiz?: boolean } | undefined,
    } : undefined,
    startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
    members,
    edges,
  };
}

const VALID_ACTION_TYPES = new Set(["slash_command", "send_text"]);
const VALID_PHASES = new Set(["after_files", "after_ready"]);
const VALID_APPLIES_ON = new Set(["fresh_start", "restore"]);

function validateStartupBlock(raw: unknown, prefix: string): string[] {
  if (typeof raw !== "object" || raw === null) return [`${prefix}: must be an object`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const VALID_DELIVERY_HINTS = new Set(["auto", "guidance_merge", "skill_install", "send_text"]);

  if (obj["files"] !== undefined) {
    if (!Array.isArray(obj["files"])) {
      errors.push(`${prefix}.files: must be an array`);
    } else {
      for (let i = 0; i < (obj["files"] as unknown[]).length; i++) {
        const f = (obj["files"] as Record<string, unknown>[])[i]!;
        const pathErr = validateSafePath(f["path"] as string, `${prefix}.files[${i}].path`);
        if (pathErr) errors.push(pathErr);
        if (f["delivery_hint"] !== undefined && !VALID_DELIVERY_HINTS.has(f["delivery_hint"] as string)) {
          errors.push(`${prefix}.files[${i}].delivery_hint: must be one of ${[...VALID_DELIVERY_HINTS].join(", ")}`);
        }
        if (f["applies_on"] !== undefined) {
          if (!Array.isArray(f["applies_on"])) {
            errors.push(`${prefix}.files[${i}].applies_on: must be an array`);
          } else {
            for (const v of f["applies_on"] as string[]) {
              if (!VALID_APPLIES_ON.has(v)) {
                errors.push(`${prefix}.files[${i}].applies_on: invalid value "${v}"`);
              }
            }
          }
        }
      }
    }
  }
  if (obj["actions"] !== undefined) {
    if (!Array.isArray(obj["actions"])) {
      errors.push(`${prefix}.actions: must be an array`);
    } else {
      for (let i = 0; i < (obj["actions"] as unknown[]).length; i++) {
        const a = (obj["actions"] as Record<string, unknown>[])[i]!;
        const type = a["type"] as string;
        if (type === "shell") {
          errors.push(`${prefix}.actions[${i}].type: "shell" is not supported in v1`);
        } else if (!VALID_ACTION_TYPES.has(type)) {
          errors.push(`${prefix}.actions[${i}].type: must be one of ${[...VALID_ACTION_TYPES].join(", ")}`);
        }
        if (a["phase"] !== undefined && !VALID_PHASES.has(a["phase"] as string)) {
          errors.push(`${prefix}.actions[${i}].phase: must be one of ${[...VALID_PHASES].join(", ")}`);
        }
        if (a["idempotent"] !== undefined && typeof a["idempotent"] !== "boolean") {
          errors.push(`${prefix}.actions[${i}].idempotent: must be a boolean`);
        }
        if (a["applies_on"] !== undefined) {
          if (!Array.isArray(a["applies_on"])) {
            errors.push(`${prefix}.actions[${i}].applies_on: must be an array`);
          } else {
            for (const v of a["applies_on"] as string[]) {
              if (!VALID_APPLIES_ON.has(v)) {
                errors.push(`${prefix}.actions[${i}].applies_on: invalid value "${v}"`);
              }
            }
            // Restore safety: non-idempotent actions must not apply on restore
            if (a["idempotent"] === false && (a["applies_on"] as string[]).includes("restore")) {
              errors.push(`${prefix}.actions[${i}]: non-idempotent action must not apply on restore`);
            }
          }
        }
      }
    }
  }
  return errors;
}

function normalizeStartupBlock(raw: unknown): StartupBlock {
  if (!raw || typeof raw !== "object") return { files: [], actions: [] };
  const obj = raw as Record<string, unknown>;
  const files: StartupFile[] = Array.isArray(obj["files"])
    ? (obj["files"] as Record<string, unknown>[]).map((f) => ({
        path: f["path"] as string,
        deliveryHint: (f["delivery_hint"] as StartupFile["deliveryHint"]) ?? "auto",
        required: f["required"] !== false,
        appliesOn: Array.isArray(f["applies_on"]) ? f["applies_on"] as StartupFile["appliesOn"] : ["fresh_start", "restore"],
      }))
    : [];
  const actions: StartupAction[] = Array.isArray(obj["actions"])
    ? (obj["actions"] as Record<string, unknown>[]).map((a) => ({
        type: a["type"] as StartupAction["type"],
        value: a["value"] as string,
        phase: (a["phase"] as StartupAction["phase"]) ?? "after_files",
        appliesOn: Array.isArray(a["applies_on"]) ? a["applies_on"] as StartupAction["appliesOn"] : ["fresh_start", "restore"],
        idempotent: a["idempotent"] as boolean,
      }))
    : [];
  return { files, actions };
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
