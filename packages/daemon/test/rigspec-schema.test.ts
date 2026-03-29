import { describe, it, expect } from "vitest";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";

const VALID_RIG = {
  version: "0.2",
  name: "dev-rig",
  summary: "Development rig",
  culture_file: "culture.md",
  pods: [
    {
      id: "dev",
      label: "Development",
      continuity_policy: {
        enabled: true,
        sync_triggers: ["pre_compaction", "manual"],
      },
      members: [
        { id: "impl", agent_ref: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: ".", model: "sonnet" },
        { id: "qa", agent_ref: "local:agents/qa", profile: "reviewer", runtime: "codex", cwd: "." },
      ],
      edges: [
        { kind: "can_observe", from: "qa", to: "impl" },
      ],
    },
    {
      id: "arch",
      label: "Architecture",
      members: [
        { id: "reviewer", agent_ref: "local:agents/reviewer", profile: "default", runtime: "claude-code", cwd: "." },
      ],
      edges: [],
    },
  ],
  edges: [
    { kind: "escalates_to", from: "dev.impl", to: "arch.reviewer" },
  ],
};

describe("RigSpec schema (pod-aware)", () => {
  // T1: valid rig with embedded pods passes validation
  it("valid rig with embedded pods passes validation", () => {
    const result = RigSpecSchema.validate(VALID_RIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T2: missing pod member agent_ref fails
  it("missing pod member agent_ref fails", () => {
    const rig = structuredClone(VALID_RIG);
    delete (rig.pods[0]!.members[0] as Record<string, unknown>)["agent_ref"];
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/agent_ref.*required/);
  });

  // T3: missing pod member profile fails
  it("missing pod member profile fails", () => {
    const rig = structuredClone(VALID_RIG);
    delete (rig.pods[0]!.members[0] as Record<string, unknown>)["profile"];
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/profile.*required/);
  });

  // T4: unknown edge kind fails
  it("unknown edge kind fails", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0]!.edges[0]!.kind = "unknown_kind";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/kind.*must be one of/);
  });

  // T5: cross-pod edge using unqualified id fails
  it("cross-pod edge using unqualified id fails", () => {
    const rig = structuredClone(VALID_RIG);
    rig.edges[0]!.from = "impl";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/fully-qualified.*pod\.member/);
  });

  // T6: pod-local edge using fully-qualified id fails
  it("pod-local edge using fully-qualified id fails", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0]!.edges[0]!.from = "dev.qa";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/pod-local.*unqualified/);
  });

  // T7: duplicate pod id fails
  it("duplicate pod id fails", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[1]!.id = "dev";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/duplicate pod id "dev"/);
  });

  // T8: duplicate member id inside one pod fails
  it("duplicate member id inside one pod fails", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0]!.members[1]!.id = "impl";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/duplicate member id "impl"/);
  });

  // T9: dot in pod id or member id fails
  it("dot in pod id or member id fails", () => {
    const rig1 = structuredClone(VALID_RIG);
    rig1.pods[0]!.id = "dev.team";
    expect(RigSpecSchema.validate(rig1).errors[0]).toMatch(/must not contain dots/);

    const rig2 = structuredClone(VALID_RIG);
    rig2.pods[0]!.members[0]!.id = "impl.main";
    expect(RigSpecSchema.validate(rig2).errors[0]).toMatch(/must not contain dots/);
  });

  // T10: culture_file round-trips through normalize
  it("culture_file round-trips through normalize", () => {
    const normalized = RigSpecSchema.normalize(VALID_RIG);
    expect(normalized.cultureFile).toBe("culture.md");
  });

  // T11: normalize preserves pod/member/edge ordering
  it("normalize preserves pod/member/edge ordering", () => {
    const normalized = RigSpecSchema.normalize(VALID_RIG);
    expect(normalized.pods[0]!.id).toBe("dev");
    expect(normalized.pods[1]!.id).toBe("arch");
    expect(normalized.pods[0]!.members[0]!.id).toBe("impl");
    expect(normalized.pods[0]!.members[1]!.id).toBe("qa");
    expect(normalized.pods[0]!.edges[0]!.from).toBe("qa");
    expect(normalized.edges[0]!.from).toBe("dev.impl");
  });

  // T12: serialize -> parse -> validate round-trips
  it("normalize produces correct typed shape", () => {
    const normalized = RigSpecSchema.normalize(VALID_RIG);
    expect(normalized.version).toBe("0.2");
    expect(normalized.name).toBe("dev-rig");
    expect(normalized.pods).toHaveLength(2);
    expect(normalized.pods[0]!.members[0]!.agentRef).toBe("local:agents/impl");
    expect(normalized.pods[0]!.continuityPolicy?.enabled).toBe(true);
    expect(normalized.edges).toHaveLength(1);
  });

  // T13a: malformed member startup is rejected
  it("malformed member startup block is rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = { files: "not-array" };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("files") && e.includes("array"))).toBe(true);
  });

  // T13b: malformed continuity_policy artifacts/restore_protocol rejected
  it("malformed continuity_policy nested fields are rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["artifacts"] = "bad";
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["restore_protocol"] = "bad";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("artifacts") && e.includes("object"))).toBe(true);
    expect(result.errors.some((e) => e.includes("restore_protocol") && e.includes("object"))).toBe(true);
  });

  // T13c: invalid startup action semantics in member startup are rejected
  it("invalid startup action type in member startup is rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "shell", value: "npm install", idempotent: true }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("shell") && e.includes("not supported"))).toBe(true);
  });

  // T13d: invalid startup action phase/applies_on in pod startup
  it("invalid startup action phase and applies_on rejected", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0] = { ...rig.pods[0]!, startup: {
      files: [],
      actions: [{ type: "slash_command", value: "/test", phase: "before_ready", applies_on: ["rehydrate"], idempotent: true }],
    }};
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("phase") && e.includes("must be one of"))).toBe(true);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("rehydrate"))).toBe(true);
  });

  // T13e: invalid file delivery_hint and applies_on in member startup
  it("invalid file delivery_hint and applies_on in startup rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [{ path: "test.md", delivery_hint: "bogus", applies_on: ["rehydrate"] }],
      actions: [],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("delivery_hint"))).toBe(true);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("rehydrate"))).toBe(true);
  });

  // T13f: non-boolean idempotent in startup action rejected
  it("non-boolean idempotent in startup action is rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/test", phase: "after_ready", idempotent: "yes" }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("idempotent") && e.includes("boolean"))).toBe(true);
  });

  // T13g: non-idempotent action on restore rejected
  it("non-idempotent action on restore in member startup is rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/setup", phase: "after_ready", idempotent: false, applies_on: ["fresh_start", "restore"] }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-idempotent") && e.includes("restore"))).toBe(true);
  });

  // T13h: scalar applies_on on action rejected
  it("scalar applies_on on startup action rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/test", phase: "after_ready", idempotent: true, applies_on: "fresh_start" }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("array"))).toBe(true);
  });

  // T13i: nested continuity-policy boolean typing validated
  it("non-boolean continuity_policy nested fields rejected", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["artifacts"] = { session_log: "yes" };
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["restore_protocol"] = { peer_driven: "yes" };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("session_log") && e.includes("boolean"))).toBe(true);
    expect(result.errors.some((e) => e.includes("peer_driven") && e.includes("boolean"))).toBe(true);
  });

  // T14: legacy flat-node schema still validates
  it("legacy flat-node schema still validates old specs", () => {
    const legacySpec = {
      schema_version: 1, name: "test", version: "1.0",
      nodes: [
        { id: "orchestrator", runtime: "claude-code", role: "orchestrator" },
        { id: "impl", runtime: "claude-code", role: "impl" },
      ],
      edges: [{ from: "orchestrator", to: "impl", kind: "delegates_to" }],
    };
    const result = LegacyRigSpecSchema.validate(legacySpec);
    expect(result.valid).toBe(true);
    const normalized = LegacyRigSpecSchema.normalize(legacySpec);
    expect(normalized.nodes).toHaveLength(2);
  });
});
