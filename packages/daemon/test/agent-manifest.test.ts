import { describe, it, expect } from "vitest";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";

const VALID_SPEC = `
version: "0.2"
name: implementer
summary: Single-agent blueprint for code implementation work

imports:
  - ref: local:agents/acme-standards
    version: "1.0.0"

defaults:
  runtime: claude-code
  model: claude-sonnet-4.5
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: pod_continuity
    restore_policy: resume_if_possible

startup:
  files:
    - path: startup/base/operating-model.md
      delivery_hint: auto
    - path: startup/base/repo-contract.md
  actions:
    - type: slash_command
      value: /rename implementer
      phase: after_ready
      applies_on: [fresh_start]
      idempotent: true

resources:
  skills:
    - id: deep-pr-review
      path: skills/workflows/deep-pr-review
  guidance:
    - id: tdd-rules
      path: guidance/tdd-rules.md
      target: claude_md
      merge: managed_block
  subagents:
    - id: diff-auditor
      path: subagents/diff-auditor.yaml
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
  runtime_resources:
    - id: codex-review-toolbar
      path: extensions/codex-review-toolbar/
      runtime: codex
      type: plugin

profiles:
  tdd:
    summary: TDD loop
    preferences:
      model: claude-opus-4.1
    startup:
      files:
        - path: startup/profiles/tdd-loop.md
          delivery_hint: auto
      actions: []
    lifecycle:
      execution_mode: interactive_resident
      compaction_strategy: pod_continuity
      restore_policy: resume_if_possible
    uses:
      skills: [deep-pr-review, acme-standards:repo-rules]
      guidance: [tdd-rules]
      subagents: [diff-auditor]
      plugins: [openrig-core]
      runtime_resources: []
`;

describe("AgentSpec manifest parser + validator", () => {
  // T1: valid agent.yaml parses and normalizes with correct defaults
  it("valid spec parses, validates, and normalizes", () => {
    const raw = parseAgentSpec(VALID_SPEC);
    const validation = validateAgentSpec(raw);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    const spec = normalizeAgentSpec(raw);
    expect(spec.name).toBe("implementer");
    expect(spec.version).toBe("0.2");
    expect(spec.imports).toHaveLength(1);
    expect(spec.imports[0]!.ref).toBe("local:agents/acme-standards");
    expect(spec.startup.files).toHaveLength(2);
    // Defaults applied
    expect(spec.startup.files[0]!.deliveryHint).toBe("auto");
    expect(spec.startup.files[1]!.deliveryHint).toBe("auto"); // defaulted
    expect(spec.startup.files[0]!.required).toBe(true);
    expect(spec.startup.files[0]!.appliesOn).toEqual(["fresh_start", "restore"]); // defaulted
    expect(spec.resources.skills).toHaveLength(1);
    expect(spec.resources.runtimeResources).toHaveLength(1);
    expect(spec.profiles["tdd"]).toBeDefined();
    expect(spec.profiles["tdd"]!.uses.skills).toContain("deep-pr-review");
    expect(spec.profiles["tdd"]!.uses.skills).toContain("acme-standards:repo-rules");
    expect(spec.defaults?.lifecycle?.executionMode).toBe("interactive_resident");
  });

  // T2: missing name or version fails with both errors
  it("missing name or version fails with both errors reported", () => {
    const raw = parseAgentSpec("summary: no name or version");
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  // T3a: remote import source rejected
  it("remote import source (github:) is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: github:foo/bar
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must start with "local:" or "path:"/);
  });

  // T3b: local:/abs/path rejected
  it("local: with absolute path is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: "local:/abs/path"
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/local:.*relative path/);
  });

  // T3c: path:relative/file rejected
  it("path: with relative path is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: "path:relative/file"
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/path:.*absolute path/);
  });

  // T4: version range rejected
  it("version range string is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: local:agents/foo
    version: "^1.0.0"
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/version ranges are not supported/);
  });

  // T5: shell startup action rejected
  it("shell startup action is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: shell
      value: "npm install"
      idempotent: true
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/shell.*not supported/);
  });

  // T5b: missing idempotent field rejected
  it("missing idempotent field on startup action is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: slash_command
      value: /test
      phase: after_ready
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("idempotent") && e.includes("required"))).toBe(true);
  });

  // T5c: restore + idempotent=false rejected
  it("non-idempotent action with restore in applies_on is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: slash_command
      value: /setup
      phase: after_ready
      idempotent: false
      applies_on: [fresh_start, restore]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/non-idempotent.*must not apply on restore/);
  });

  // T5d: non-idempotent action with fresh_start only accepted
  it("non-idempotent action with fresh_start only is accepted", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: slash_command
      value: /setup
      phase: after_ready
      idempotent: false
      applies_on: [fresh_start]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
  });

  // T6: wake_on_demand rejected
  it("wake_on_demand execution mode is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
defaults:
  lifecycle:
    execution_mode: wake_on_demand
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/wake_on_demand.*not supported/);
  });

  // T7a: invalid compaction strategy rejected
  it("invalid compaction strategy is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
defaults:
  lifecycle:
    compaction_strategy: bogus
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/compaction_strategy/);
  });

  // T7b: custom_prompt compaction strategy rejected
  it("custom_prompt compaction strategy is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
defaults:
  lifecycle:
    compaction_strategy: custom_prompt
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/custom_prompt.*not supported/);
  });

  // T8: path traversal in resource path rejected (forward + backslash)
  it("path traversal in resource path is rejected", () => {
    // Forward slash traversal
    const raw1 = parseAgentSpec("name: test\nversion: '1.0'\nresources:\n  skills:\n    - id: evil\n      path: '../escape/evil.md'");
    expect(validateAgentSpec(raw1).valid).toBe(false);
    expect(validateAgentSpec(raw1).errors[0]).toMatch(/path traversal/);

    // Backslash traversal — inject directly into parsed object to avoid YAML escape issues
    const raw2 = { name: "test", version: "1.0", resources: { skills: [{ id: "evil", path: "..\\escape\\evil.md" }] } };
    expect(validateAgentSpec(raw2).valid).toBe(false);
    expect(validateAgentSpec(raw2).errors[0]).toMatch(/path traversal/);
  });

  // T8b: absolute resource path rejected (Unix + Windows)
  it("absolute resource path is rejected", () => {
    // Unix absolute
    const raw1 = parseAgentSpec("name: test\nversion: '1.0'\nresources:\n  skills:\n    - id: evil\n      path: /tmp/evil.md");
    expect(validateAgentSpec(raw1).valid).toBe(false);
    expect(validateAgentSpec(raw1).errors[0]).toMatch(/absolute paths are not allowed/);

    // Windows drive letter — inject directly
    const raw2 = { name: "test", version: "1.0", resources: { skills: [{ id: "evil", path: "C:\\evil.md" }] } };
    expect(validateAgentSpec(raw2).valid).toBe(false);
    expect(validateAgentSpec(raw2).errors[0]).toMatch(/absolute paths are not allowed/);
  });

  // T9: path traversal in startup file path rejected
  it("path traversal in startup file path is rejected", () => {
    // Forward slash
    const raw1 = parseAgentSpec("name: test\nversion: '1.0'\nstartup:\n  files:\n    - path: '../evil.md'");
    expect(validateAgentSpec(raw1).valid).toBe(false);
    expect(validateAgentSpec(raw1).errors[0]).toMatch(/path traversal/);

    // Backslash — inject directly
    const raw2 = { name: "test", version: "1.0", startup: { files: [{ path: "..\\evil.md" }] } };
    expect(validateAgentSpec(raw2).valid).toBe(false);
    expect(validateAgentSpec(raw2).errors[0]).toMatch(/path traversal/);
  });

  // T9b: absolute startup file path rejected
  it("absolute startup file path is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  files:
    - path: /etc/passwd
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/absolute paths are not allowed/);
  });

  // T10: duplicate resource ids in one category fail
  it("duplicate resource ids in one category fail", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  skills:
    - id: foo
      path: skills/foo
    - id: foo
      path: skills/foo2
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/duplicate id "foo"/);
  });

  // T11: profile uses — unqualified missing fails, qualified accepted
  it("profile uses: unqualified missing ref fails, qualified ref accepted", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  skills:
    - id: local-skill
      path: skills/local
profiles:
  main:
    uses:
      skills: [missing-skill, imported-ns:remote-skill]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    // Unqualified "missing-skill" should fail
    expect(result.errors.some((e) => e.includes('"missing-skill" not found'))).toBe(true);
    // Qualified "imported-ns:remote-skill" should NOT produce an error
    expect(result.errors.some((e) => e.includes("imported-ns:remote-skill"))).toBe(false);
  });

  it("profile uses: imported unqualified skill is allowed when imports are declared", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [openrig-user]
      guidance: []
      subagents: []
      plugins: []
      runtime_resources: []
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T12: runtime_resources without runtime field fail
  it("runtime_resources without runtime field fail", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  runtime_resources:
    - id: foo
      path: extensions/foo
      type: plugin
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/runtime.*required/);
  });

  it("runtime_resources without type field fail", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  runtime_resources:
    - id: foo
      path: extensions/foo
      runtime: claude-code
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/type.*required/);
  });

  // T13: multiple errors reported together (including invalid enums)
  it("multiple validation errors reported together", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  files:
    - path: startup/test.md
      delivery_hint: bogus
  actions:
    - type: slash_command
      value: /test
      phase: before_ready
      idempotent: true
      applies_on: [rehydrate]
defaults:
  lifecycle:
    execution_mode: wake_on_demand
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(result.errors.some((e) => e.includes("delivery_hint"))).toBe(true);
    expect(result.errors.some((e) => e.includes("phase"))).toBe(true);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("rehydrate"))).toBe(true);
    expect(result.errors.some((e) => e.includes("wake_on_demand"))).toBe(true);
  });

  // T14a: startup.files as object (not array) is rejected
  it("startup.files as object instead of array is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  files:
    path: startup/test.md
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("files") && e.includes("array"))).toBe(true);
  });

  // T14b: profiles as array is rejected
  it("profiles as array instead of map is rejected", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
profiles:
  - name: tdd
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("profiles") && e.includes("map"))).toBe(true);
  });

  // T14: parse -> validate -> normalize is deterministic
  it("parse -> validate -> normalize is deterministic", () => {
    const raw1 = parseAgentSpec(VALID_SPEC);
    const raw2 = parseAgentSpec(VALID_SPEC);
    const v1 = validateAgentSpec(raw1);
    const v2 = validateAgentSpec(raw2);
    expect(v1).toEqual(v2);
    const n1 = normalizeAgentSpec(raw1);
    const n2 = normalizeAgentSpec(raw2);
    expect(n1).toEqual(n2);
  });
});
