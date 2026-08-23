// OPR.0.5.3.3 slice 03 item 2 — alias-form model-pin advisory.
import { describe, it, expect } from "vitest";
import { aliasModelPinAdvisory } from "../src/domain/spec-validation-advisory.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";

describe("aliasModelPinAdvisory — names the canonical id for an alias pin", () => {
  it("returns a named advisory stating the canonical id for a known alias", () => {
    const adv = aliasModelPinAdvisory("fable", "pods.dev.members.driver");
    expect(adv).not.toBeNull();
    expect(adv).toContain("pods.dev.members.driver");
    expect(adv).toContain('"fable"');
    expect(adv).toContain("claude-fable-5"); // the canonical id
  });

  it("case/whitespace-insensitive on the alias", () => {
    expect(aliasModelPinAdvisory("  Fable ", "x")).toContain("claude-fable-5");
  });

  it("returns null for a canonical pin, an unknown pin, or a non-string", () => {
    expect(aliasModelPinAdvisory("claude-fable-5", "x")).toBeNull();
    expect(aliasModelPinAdvisory("gpt-5.6-codex", "x")).toBeNull();
    expect(aliasModelPinAdvisory(undefined, "x")).toBeNull();
    expect(aliasModelPinAdvisory(42 as unknown, "x")).toBeNull();
  });
});

describe("RigSpecSchema.validate — alias pins surface as advisories, never errors (fail-open)", () => {
  const base = (model: string) => ({
    name: "test-rig",
    version: "0.2",
    pods: [{ id: "dev", members: [{ id: "driver", model }] }],
  });

  it("an alias-form pin emits a named advisory and does NOT affect validity/errors", () => {
    const aliasResult = RigSpecSchema.validate(base("fable"));
    const canonResult = RigSpecSchema.validate(base("claude-fable-5"));

    // advisory present for the alias, absent for the canonical pin
    expect(aliasResult.advisories?.some((a) => a.includes("claude-fable-5"))).toBe(true);
    expect(canonResult.advisories ?? []).toHaveLength(0);

    // FAIL-OPEN: the advisory changes neither `valid` nor `errors`.
    expect(aliasResult.valid).toBe(canonResult.valid);
    expect(aliasResult.errors).toEqual(canonResult.errors);
  });
});

// r2 HIGH-1: the auto-detected LEGACY path must ALSO surface alias-pin advisories, or legacy
// alias-pinned specs get a clean validate result and the operator receives no migration nudge.
describe("LegacyRigSpecSchema.validate — alias pins surface as advisories on the legacy path too", () => {
  const legacyBase = (model: string) => ({
    schema_version: 1,
    name: "legacy-rig",
    version: "1",
    nodes: [{ id: "n1", runtime: "claude-code", model }],
  });

  it("a legacy node's alias-form pin emits the named advisory (fail-open)", () => {
    const aliasResult = LegacyRigSpecSchema.validate(legacyBase("fable"));
    const canonResult = LegacyRigSpecSchema.validate(legacyBase("claude-fable-5"));

    expect(aliasResult.advisories?.some((a) => a.includes("claude-fable-5"))).toBe(true);
    expect(canonResult.advisories ?? []).toHaveLength(0);
    // FAIL-OPEN: identical valid/errors with vs without the alias.
    expect(aliasResult.valid).toBe(canonResult.valid);
    expect(aliasResult.errors).toEqual(canonResult.errors);
  });

  // r2 HIGH-1 round 2: the advisory is INDEPENDENT of id validity — a fable-pinned node that also
  // lacks an id (fails the id guard) must STILL emit the advisory, at the `?` fallback location.
  it("emits the advisory for an alias pin even when the node is missing its id", () => {
    const result = LegacyRigSpecSchema.validate({
      schema_version: 1,
      name: "legacy-rig",
      version: "1",
      nodes: [{ runtime: "claude-code", model: "fable" }], // no id -> invalid, but still alias-pinned
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("each node must have a string id");
    expect(result.advisories?.some((a) => a.includes("claude-fable-5"))).toBe(true);
    expect(result.advisories?.some((a) => a.includes("nodes.?"))).toBe(true); // fallback location
  });
});
