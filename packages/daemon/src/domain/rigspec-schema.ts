import type { RigSpec, RigSpecNode, RigSpecEdge } from "./types.js";

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const KNOWN_RUNTIMES = new Set(["claude-code", "codex"]);
const KNOWN_RESTORE_POLICIES = new Set(["resume_if_possible", "relaunch_fresh", "checkpoint_only"]);
const KNOWN_EDGE_KINDS = new Set(["delegates_to", "spawned_by", "can_observe"]);

export class RigSpecSchema {
  static validate(raw: unknown): ValidationResult {
    const errors: string[] = [];

    if (!raw || typeof raw !== "object") {
      return { valid: false, errors: ["spec must be an object"] };
    }

    const obj = raw as Record<string, unknown>;

    // schema_version: must be 1 or absent (defaults to 1 in normalize)
    if (obj["schema_version"] != null && obj["schema_version"] !== 1) {
      errors.push(`schema_version must be 1, got ${obj["schema_version"]}`);
    }

    // Required string fields
    if (!obj["name"] || typeof obj["name"] !== "string") {
      errors.push("name is required and must be a string");
    }
    if (!obj["version"] || typeof obj["version"] !== "string") {
      errors.push("version is required and must be a string");
    }

    // nodes: required array
    if (!obj["nodes"] || !Array.isArray(obj["nodes"])) {
      errors.push("nodes is required and must be an array");
    }

    // edges: optional but must be array if present
    if (obj["edges"] !== undefined && !Array.isArray(obj["edges"])) {
      errors.push("edges must be an array if present");
    }

    // Validate nodes
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
        } else if (!KNOWN_RUNTIMES.has(node["runtime"] as string)) {
          errors.push(`node ${node["id"]}: unknown runtime '${node["runtime"]}'`);
        }

        if (node["restore_policy"] != null && !KNOWN_RESTORE_POLICIES.has(node["restore_policy"] as string)) {
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

    // Validate edges
    if (Array.isArray(obj["edges"])) {
      for (const edge of obj["edges"] as Record<string, unknown>[]) {
        const from = edge["from"] as string | undefined;
        const to = edge["to"] as string | undefined;
        const kind = edge["kind"] as string | undefined;

        if (!from || typeof from !== "string") {
          errors.push("each edge must have a string 'from' field");
          continue;
        }
        if (!to || typeof to !== "string") {
          errors.push("each edge must have a string 'to' field");
          continue;
        }
        if (!kind || typeof kind !== "string") {
          errors.push("each edge must have a string 'kind' field");
          continue;
        }

        if (from === to) {
          errors.push(`self-edge not allowed: ${from} -> ${to}`);
        }

        if (from && !nodeIds.has(from)) {
          errors.push(`edge references nonexistent node: '${from}'`);
        }
        if (to && !nodeIds.has(to)) {
          errors.push(`edge references nonexistent node: '${to}'`);
        }

        if (kind && !KNOWN_EDGE_KINDS.has(kind)) {
          errors.push(`unknown edge kind: '${kind}'`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  static normalize(raw: unknown): RigSpec {
    const result = this.validate(raw);
    if (!result.valid) {
      throw new Error(`RigSpec validation failed: ${result.errors.join("; ")}`);
    }

    const obj = raw as Record<string, unknown>;

    const rawNodes = obj["nodes"] as Record<string, unknown>[];
    const rawEdges = (obj["edges"] as Record<string, unknown>[] | undefined) ?? [];

    const nodes: RigSpecNode[] = rawNodes.map((n) => ({
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

    const edges: RigSpecEdge[] = rawEdges.map((e) => ({
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
