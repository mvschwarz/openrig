import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RigSpec } from "./types.js";

/**
 * Pure YAML codec for RigSpec files.
 * parse() returns untyped unknown — no semantic validation, no defaults.
 * serialize() takes a typed RigSpec and produces YAML.
 */
export class RigSpecCodec {
  /**
   * Parse a YAML string into an untyped object.
   * No semantic validation, no defaults, no shape coercion.
   */
  static parse(yamlString: string): unknown {
    return parseYaml(yamlString);
  }

  /**
   * Serialize a typed RigSpec to a YAML string.
   * Maps camelCase domain fields to snake_case YAML keys.
   */
  static serialize(spec: RigSpec): string {
    const doc = {
      schema_version: spec.schemaVersion,
      name: spec.name,
      version: spec.version,
      nodes: spec.nodes.map((node) => {
        const n: Record<string, unknown> = {
          id: node.id,
          runtime: node.runtime,
        };
        if (node.role != null) n["role"] = node.role;
        if (node.model != null) n["model"] = node.model;
        if (node.cwd != null) n["cwd"] = node.cwd;
        if (node.surfaceHint != null) n["surface_hint"] = node.surfaceHint;
        if (node.workspace != null) n["workspace"] = node.workspace;
        if (node.restorePolicy != null) n["restore_policy"] = node.restorePolicy;
        if (node.packageRefs && node.packageRefs.length > 0) n["package_refs"] = node.packageRefs;
        return n;
      }),
      edges: spec.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
      })),
    };

    return stringifyYaml(doc);
  }
}
