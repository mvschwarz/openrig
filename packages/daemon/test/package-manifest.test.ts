import { describe, it, expect } from "vitest";
import {
  parseManifest,
  validateManifest,
  normalizeManifest,
  serializeManifest,
} from "../src/domain/package-manifest.js";

const VALID_YAML = `
schema_version: 1
name: com.example.review-stack
version: 0.1.0
summary: Multi-agent review package
compatibility:
  runtimes:
    - claude-code
    - codex
exports:
  skills:
    - source: skills/deep-pr-review
      name: deep-pr-review
      supported_scopes: [project_shared]
      default_scope: project_shared
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      supported_scopes: [project_shared]
      default_scope: project_shared
      merge_strategy: managed_block
`;

function validRaw() {
  return parseManifest(VALID_YAML);
}

describe("PackageManifest", () => {
  it("accepts a deferred role hook absent from exports without a warning", () => {
    const raw = validRaw() as Record<string, unknown>;
    const exports = raw.exports as Record<string, unknown>;
    exports.hooks = [{ source: "hooks/checkpoint.yaml", supported_runtimes: ["claude-code"] }];
    raw.roles = [{ name: "reviewer", hooks: ["hooks/missing.yaml"] }];
    const result = validateManifest(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result).not.toHaveProperty("warnings");
    raw.roles = [{ name: "reviewer", hooks: ["hooks/checkpoint.yaml"] }];
    expect(validateManifest(raw).valid).toBe(true);
    expect(validateManifest(raw)).not.toHaveProperty("warnings");
  });

  // Test 1: Valid manifest passes validation
  it("valid manifest passes validation", () => {
    const result = validateManifest(validRaw());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // Test 2: Missing name -> error
  it("missing name -> error", () => {
    const raw = parseManifest(VALID_YAML.replace("name: com.example.review-stack", ""));
    const result = validateManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  // Test 3: Missing version -> error
  it("missing version -> error", () => {
    const raw = parseManifest(VALID_YAML.replace("version: 0.1.0", ""));
    const result = validateManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  // Test 4: Unknown runtime -> error
  it("unknown runtime -> error", () => {
    const yaml = VALID_YAML.replace("- claude-code", "- unknown-runtime");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown-runtime"))).toBe(true);
  });

  // Test 5: Unknown guidance kind -> error
  it("unknown guidance kind -> error", () => {
    const yaml = VALID_YAML.replace("kind: agents_md", "kind: invalid_kind");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("invalid_kind"))).toBe(true);
  });

  // Test 6: Unknown merge strategy -> error
  it("unknown merge strategy -> error", () => {
    const yaml = VALID_YAML.replace("merge_strategy: managed_block", "merge_strategy: yolo");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("yolo"))).toBe(true);
  });

  // Test 7: Path traversal -> error
  it("export source with path traversal -> error", () => {
    const yaml = VALID_YAML.replace("source: skills/deep-pr-review", "source: ../../../etc/passwd");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("path traversal"))).toBe(true);
  });

  // Test 8: Role references nonexistent skill -> error
  it("role references nonexistent skill -> error", () => {
    const yaml = VALID_YAML + `
roles:
  - name: reviewer
    skills:
      - nonexistent-skill
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent-skill"))).toBe(true);
  });

  // Test 9: Multiple errors reported (not short-circuit)
  it("multiple errors reported, not short-circuit", () => {
    const yaml = `
schema_version: 1
compatibility:
  runtimes: []
exports:
  skills: []
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    // Should have errors for: name, version, summary, runtimes empty
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  // Test 10: normalize applies defaults (schemaVersion + defaultScope + supportedScopes)
  it("normalize applies defaults for schemaVersion, defaultScope, supportedScopes", () => {
    const yaml = `
name: test
version: 1.0.0
summary: Test package
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: managed_block
`;
    const manifest = normalizeManifest(parseManifest(yaml));

    // schemaVersion defaults to 1
    expect(manifest.schemaVersion).toBe(1);

    // skill defaultScope defaults to project_shared
    expect(manifest.exports.skills![0]!.defaultScope).toBe("project_shared");
    // skill supportedScopes defaults to ['project_shared']
    expect(manifest.exports.skills![0]!.supportedScopes).toEqual(["project_shared"]);

    // guidance defaults
    expect(manifest.exports.guidance![0]!.defaultScope).toBe("project_shared");
    expect(manifest.exports.guidance![0]!.supportedScopes).toEqual(["project_shared"]);
  });

  // Test 11: Hooks and MCP parsed correctly (not rejected)
  it("hooks and MCP parsed correctly, not rejected", () => {
    const yaml = VALID_YAML + `
  hooks:
    - source: hooks/checkpoint.yaml
      supported_runtimes: [claude-code]
  mcp:
    - source: mcp/context7.yaml
      supported_runtimes: [claude-code, codex]
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(true);

    const manifest = normalizeManifest(parseManifest(yaml));
    expect(manifest.exports.hooks).toHaveLength(1);
    expect(manifest.exports.hooks![0]!.source).toBe("hooks/checkpoint.yaml");
    expect(manifest.exports.mcp).toHaveLength(1);
    expect(manifest.exports.mcp![0]!.source).toBe("mcp/context7.yaml");
  });

  // Test 12: Round-trip with comprehensive fixture
  it("round-trip: parse -> validate -> normalize -> serialize -> re-parse (all sections)", () => {
    const comprehensiveYaml = `
schema_version: 1
name: com.example.full
version: 2.0.0
summary: Comprehensive test
compatibility:
  runtimes: [claude-code, codex]
exports:
  skills:
    - source: skills/foo
      name: foo
      supported_scopes: [project_shared]
      default_scope: project_shared
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      supported_scopes: [project_shared]
      default_scope: project_shared
      merge_strategy: managed_block
  hooks:
    - source: hooks/check.yaml
      supported_runtimes: [claude-code]
  mcp:
    - source: mcp/ctx.yaml
      supported_runtimes: [codex]
requirements:
  cli_tools:
    - name: agent-browser
      required_for: [qa-browser]
      install_hints:
        macos: brew install agent-browser
  system_packages:
    - name: ripgrep
install_policy:
  require_review_for_external_installs: true
  allow_user_global_writes: false
verification:
  checks:
    - type: skill_present
      name: foo
    - type: cli_exists
      command: agent-browser --help
roles:
  - name: reviewer
    skills: [foo]
    guidance: [AGENTS.md]
`;

    const raw = parseManifest(comprehensiveYaml);
    const result = validateManifest(raw);
    expect(result.valid).toBe(true);

    const manifest = normalizeManifest(raw);
    const yaml = serializeManifest(manifest);
    const reManifest = normalizeManifest(parseManifest(yaml));

    // Core fields
    expect(reManifest.name).toBe("com.example.full");
    expect(reManifest.version).toBe("2.0.0");
    expect(reManifest.exports.skills).toHaveLength(1);
    expect(reManifest.exports.guidance).toHaveLength(1);
    expect(reManifest.exports.hooks).toHaveLength(1);
    expect(reManifest.exports.mcp).toHaveLength(1);

    // Requirements survived
    expect(reManifest.requirements?.cliTools).toHaveLength(1);
    expect(reManifest.requirements!.cliTools![0]!.name).toBe("agent-browser");
    expect(reManifest.requirements!.cliTools![0]!.requiredFor).toEqual(["qa-browser"]);
    expect(reManifest.requirements?.systemPackages).toHaveLength(1);

    // InstallPolicy survived
    expect(reManifest.installPolicy?.requireReviewForExternalInstalls).toBe(true);
    expect(reManifest.installPolicy?.allowUserGlobalWrites).toBe(false);

    // Verification survived
    expect(reManifest.verification?.checks).toHaveLength(2);
    expect(reManifest.verification!.checks[0]!.type).toBe("skill_present");
    expect(reManifest.verification!.checks[0]!.name).toBe("foo");
    expect(reManifest.verification!.checks[1]!.command).toBe("agent-browser --help");

    // Roles survived
    expect(reManifest.roles).toHaveLength(1);
    expect(reManifest.roles![0]!.skills).toEqual(["foo"]);
  });

  // Test 13: Invalid version format -> error
  it("invalid version format -> error", () => {
    const yaml = VALID_YAML.replace("version: 0.1.0", "version: not-a-version");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("semver"))).toBe(true);
  });

  // Test 14: Missing summary -> error
  it("missing summary -> error", () => {
    const yaml = VALID_YAML.replace("summary: Multi-agent review package", "");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("summary"))).toBe(true);
  });

  // Test 15: Missing exports -> error
  it("missing exports -> error", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exports"))).toBe(true);
  });

  // Test 16: Role references nonexistent guidance -> error
  it("role references nonexistent guidance -> error", () => {
    const yaml = VALID_YAML + `
roles:
  - name: reviewer
    guidance:
      - nonexistent-guidance.md
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent-guidance.md"))).toBe(true);
  });

  // Test 17: Duplicate guidance names -> error
  it("duplicate guidance names -> error", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: managed_block
    - source: other/AGENTS.md
      kind: agents_md
      merge_strategy: append
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate guidance name"))).toBe(true);
  });

  // Test 19: Invalid scope value -> error
  it("invalid supported_scopes value -> error", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
      supported_scopes: [totally_invalid_scope]
      default_scope: totally_invalid_scope
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("totally_invalid_scope"))).toBe(true);
  });

  // Test 20: Bare '..' path traversal rejected for skills
  it("bare '..' path traversal rejected for skills", () => {
    const yaml = VALID_YAML.replace("source: skills/deep-pr-review", "source: ..");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("path traversal"))).toBe(true);
  });

  // Test 21: Hook with path traversal rejected
  it("hook with path traversal rejected", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
  hooks:
    - source: ../../../etc/shadow
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Hook export source must not contain path traversal"))).toBe(true);
  });

  // Test 22: MCP with path traversal rejected
  it("MCP with path traversal rejected", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
  mcp:
    - source: ../../../etc/shadow
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("MCP export source must not contain path traversal"))).toBe(true);
  });

  // Test 23: Duplicate agent names rejected
  it("duplicate agent names rejected", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  agents:
    - source: agents/review.md
      name: review
    - source: agents/other.md
      name: review
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate agent name"))).toBe(true);
  });

  // Test 24: Package name with invalid characters rejected
  it("package name with invalid characters rejected", () => {
    const yaml = VALID_YAML.replace("name: com.example.review-stack", "name: bad-->name");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name must match"))).toBe(true);
  });

  // Test 25: Package name with valid characters passes
  it("package name with valid characters passes", () => {
    const yaml = VALID_YAML.replace("name: com.example.review-stack", "name: my-package.v2");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(true);
  });

  // Test 18: Duplicate skill names -> error
  it("duplicate skill names -> error", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: my-skill
    - source: skills/bar
      name: my-skill
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate skill name"))).toBe(true);
  });
});
