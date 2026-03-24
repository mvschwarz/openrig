import { describe, it, expect } from "vitest";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { RigSpec } from "../src/domain/types.js";

const VALID_YAML = `
schema_version: 1
name: review-rig
version: 0.1.0
nodes:
  - id: orchestrator
    runtime: claude-code
    role: orchestrator
    model: opus
    cwd: /repo
  - id: worker
    runtime: codex
    role: worker
edges:
  - from: orchestrator
    to: worker
    kind: delegates_to
`;

describe("RigSpecCodec", () => {
  it("parse valid YAML -> returns object with expected keys", () => {
    const result = RigSpecCodec.parse(VALID_YAML);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    const obj = result as Record<string, unknown>;
    expect(obj["schema_version"]).toBe(1);
    expect(obj["name"]).toBe("review-rig");
    expect(obj["version"]).toBe("0.1.0");
    expect(Array.isArray(obj["nodes"])).toBe(true);
    expect(Array.isArray(obj["edges"])).toBe(true);
  });

  it("parse invalid YAML syntax -> throws with clear error", () => {
    const badYaml = "name: test\n  broken: [indent";
    expect(() => RigSpecCodec.parse(badYaml)).toThrow();
  });

  it("parse returns raw untyped object (no defaults, no missing-field errors)", () => {
    // Minimal YAML with only name — no version, no nodes, no edges
    const minimal = "name: minimal-rig\n";
    const result = RigSpecCodec.parse(minimal) as Record<string, unknown>;

    // Should return what's in the YAML, nothing more
    expect(result["name"]).toBe("minimal-rig");
    // Missing fields should be undefined, not defaulted
    expect(result["version"]).toBeUndefined();
    expect(result["nodes"]).toBeUndefined();
    expect(result["schema_version"]).toBeUndefined();
  });

  it("serialize RigSpec -> valid YAML string parseable by parse", () => {
    const spec: RigSpec = {
      schemaVersion: 1,
      name: "test-rig",
      version: "1.0.0",
      nodes: [
        { id: "worker", runtime: "claude-code", role: "worker" },
      ],
      edges: [
      ],
    };

    const yaml = RigSpecCodec.serialize(spec);
    expect(typeof yaml).toBe("string");
    expect(yaml.length).toBeGreaterThan(0);

    // Should be parseable back
    const parsed = RigSpecCodec.parse(yaml) as Record<string, unknown>;
    expect(parsed["name"]).toBe("test-rig");
    expect(parsed["version"]).toBe("1.0.0");
  });

  it("parse ignores unknown fields (forward compatibility)", () => {
    const yamlWithExtra = `
name: test-rig
version: 1.0.0
schema_version: 1
future_field: some_value
nodes:
  - id: worker
    runtime: codex
    unknown_node_field: hello
edges: []
`;
    // Should not throw
    const result = RigSpecCodec.parse(yamlWithExtra) as Record<string, unknown>;
    expect(result["name"]).toBe("test-rig");
    expect(result["future_field"]).toBe("some_value");
  });
});
