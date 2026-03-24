import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";

function validRaw(): Record<string, unknown> {
  return {
    schema_version: 1,
    name: "test-rig",
    version: "1.0.0",
    nodes: [
      { id: "orchestrator", runtime: "claude-code", role: "orchestrator" },
      { id: "worker", runtime: "codex", role: "worker" },
    ],
    edges: [
      { from: "orchestrator", to: "worker", kind: "delegates_to" },
    ],
  };
}

describe("RigSpecSchema", () => {
  describe("validate", () => {
    it("valid spec -> { valid: true, errors: [] }", () => {
      const result = RigSpecSchema.validate(validRaw());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("invalid schema_version (!= 1) -> error", () => {
      const raw = validRaw();
      raw["schema_version"] = 2;
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
    });

    it("missing name -> error", () => {
      const raw = validRaw();
      delete raw["name"];
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    });

    it("missing version -> error", () => {
      const raw = validRaw();
      delete raw["version"];
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    });

    it("missing or non-array nodes -> error", () => {
      const raw1 = validRaw();
      delete raw1["nodes"];
      expect(RigSpecSchema.validate(raw1).valid).toBe(false);

      const raw2 = validRaw();
      raw2["nodes"] = "not-an-array";
      const result = RigSpecSchema.validate(raw2);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("nodes"))).toBe(true);
    });

    it("present but non-array edges -> error", () => {
      const raw = validRaw();
      raw["edges"] = "bad";
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("edges"))).toBe(true);
    });

    it("unknown runtime -> error with runtime name", () => {
      const raw = validRaw();
      (raw["nodes"] as Record<string, unknown>[])[0]!["runtime"] = "unknown-runtime";
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unknown-runtime"))).toBe(true);
    });

    it("unknown restorePolicy -> error", () => {
      const raw = validRaw();
      (raw["nodes"] as Record<string, unknown>[])[0]!["restore_policy"] = "bad_policy";
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("bad_policy"))).toBe(true);
    });

    it("edge missing kind -> error", () => {
      const raw = validRaw();
      delete (raw["edges"] as Record<string, unknown>[])[0]!["kind"];
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("kind"))).toBe(true);
    });

    it("edge missing from -> error", () => {
      const raw = validRaw();
      delete (raw["edges"] as Record<string, unknown>[])[0]!["from"];
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("from"))).toBe(true);
    });

    it("edge missing to -> error", () => {
      const raw = validRaw();
      delete (raw["edges"] as Record<string, unknown>[])[0]!["to"];
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("to"))).toBe(true);
    });

    it("unknown edge kind -> error", () => {
      const raw = validRaw();
      (raw["edges"] as Record<string, unknown>[])[0]!["kind"] = "unknown_kind";
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unknown_kind"))).toBe(true);
    });

    it("package_refs non-array -> error", () => {
      const raw = validRaw();
      (raw["nodes"] as Record<string, unknown>[])[0]!["package_refs"] = "not-an-array";
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("package_refs"))).toBe(true);
    });

    it("package_refs with non-string elements -> error", () => {
      const raw = validRaw();
      (raw["nodes"] as Record<string, unknown>[])[0]!["package_refs"] = [123, true];
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("package_refs"))).toBe(true);
    });

    it("edge references nonexistent node -> error", () => {
      const raw = validRaw();
      (raw["edges"] as Record<string, unknown>[])[0]!["to"] = "nonexistent";
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
    });

    it("self-edge -> error", () => {
      const raw = validRaw();
      (raw["edges"] as Record<string, unknown>[])[0]!["to"] = "orchestrator";
      (raw["edges"] as Record<string, unknown>[])[0]!["from"] = "orchestrator";
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes("self"))).toBe(true);
    });

    it("duplicate node ids -> error", () => {
      const raw = validRaw();
      (raw["nodes"] as Record<string, unknown>[]).push({ id: "orchestrator", runtime: "codex" });
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("duplicate") || e.includes("orchestrator"))).toBe(true);
    });

    it("multiple errors reported (not short-circuit)", () => {
      const raw = { nodes: "bad", edges: "bad" }; // missing name, version, bad nodes, bad edges
      const result = RigSpecSchema.validate(raw);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("normalize", () => {
    it("applies schemaVersion default (missing -> 1)", () => {
      const raw = validRaw();
      delete raw["schema_version"];
      const spec = RigSpecSchema.normalize(raw);
      expect(spec.schemaVersion).toBe(1);
    });

    it("applies restorePolicy default (missing -> resume_if_possible)", () => {
      const raw = validRaw();
      // No restore_policy on nodes
      const spec = RigSpecSchema.normalize(raw);
      for (const node of spec.nodes) {
        expect(node.restorePolicy).toBe("resume_if_possible");
      }
    });

    it("applies packageRefs default (missing -> [])", () => {
      const raw = validRaw();
      const spec = RigSpecSchema.normalize(raw);
      for (const node of spec.nodes) {
        expect(node.packageRefs).toEqual([]);
      }
    });

    it("applies edges default (missing edges -> [])", () => {
      const raw = validRaw();
      delete raw["edges"];
      const spec = RigSpecSchema.normalize(raw);
      expect(spec.edges).toEqual([]);
    });

    it("normalize on invalid raw -> throws", () => {
      const raw = { nodes: "bad" }; // missing required fields
      expect(() => RigSpecSchema.normalize(raw)).toThrow();
    });
  });
});
