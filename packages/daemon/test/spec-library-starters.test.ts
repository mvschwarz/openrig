import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { rigPreflight, type RigPreflightInput } from "../src/domain/rigspec-preflight.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";

const SPECS_ROOT = resolve(import.meta.dirname, "../specs");

const RIG_SPECS = [
  "implementation-pair.yaml",
  "adversarial-review.yaml",
  "research-team.yaml",
  "product-team.yaml",
];

const AGENT_SPECS = [
  "agents/design/agent.yaml",
  "agents/impl/agent.yaml",
  "agents/qa/agent.yaml",
  "agents/reviewer/agent.yaml",
  "agents/lead/agent.yaml",
  "agents/analyst/agent.yaml",
  "agents/synthesizer/agent.yaml",
];

describe("Starter specs", () => {
  const specReviewService = new SpecReviewService();

  it("all rig specs pass SpecReviewService validation", () => {
    for (const file of RIG_SPECS) {
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const review = specReviewService.reviewRigSpec(yaml, "library_item");
      expect(review.kind).toBe("rig");
      expect(review.format).toBe("pod_aware");
      expect(review.name).toBeTruthy();
    }
  });

  it("all agent specs pass validation", () => {
    for (const file of AGENT_SPECS) {
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const raw = parseAgentSpec(yaml);
      const result = validateAgentSpec(raw);
      expect(result.valid).toBe(true);
    }
  });

  it("built-in library scan discovers all bundled rig specs", () => {
    const lib = new SpecLibraryService({
      roots: [{ path: SPECS_ROOT, sourceType: "builtin" }],
      specReviewService,
    });
    lib.scan();

    const rigs = lib.list({ kind: "rig" });
    expect(rigs.length).toBeGreaterThanOrEqual(4);
    const names = rigs.map((e) => e.name);
    expect(names).toContain("implementation-pair");
    expect(names).toContain("adversarial-review");
    expect(names).toContain("research-team");
    expect(names).toContain("product-team");
  });

  it("all rig specs pass canonical rigPreflight with explicit cwdOverride", () => {
    const fsOps = {
      readFile: (p: string) => readFileSync(p, "utf-8"),
      exists: (p: string) => existsSync(p),
    };

    for (const file of RIG_SPECS) {
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const input: RigPreflightInput = {
        rigSpecYaml: yaml,
        rigRoot: SPECS_ROOT,
        cwdOverride: "/workspace/project",
        fsOps,
      };

      const result = rigPreflight(input);
      // Should be ready with no blocking errors (warnings are acceptable)
      expect(result.ready).toBe(true);
      if (result.errors.length > 0) {
        throw new Error(`Preflight failed for ${file}: ${result.errors.join("; ")}`);
      }
    }
  });

  it("every agent spec references guidance/role.md that exists on disk", () => {
    for (const file of AGENT_SPECS) {
      const agentDir = join(SPECS_ROOT, file.replace("/agent.yaml", ""));
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const raw = parseAgentSpec(yaml) as Record<string, unknown>;

      // Check resources.guidance has a role entry
      const resources = (raw["resources"] ?? {}) as Record<string, unknown>;
      const guidance = resources["guidance"] as Array<{ path: string }> | undefined;
      expect(guidance).toBeDefined();
      expect(guidance!.length).toBeGreaterThan(0);

      const roleEntry = guidance!.find((g) => g.path.includes("role.md"));
      expect(roleEntry).toBeDefined();

      // Check the file exists on disk
      const rolePath = join(agentDir, roleEntry!.path);
      expect(existsSync(rolePath)).toBe(true);

      // Check guidance/role.md is also wired through startup.files as required
      const startup = (raw["startup"] ?? {}) as Record<string, unknown>;
      const startupFiles = (startup["files"] as Array<{ path: string; required?: boolean }>) ?? [];
      const startupRoleEntry = startupFiles.find((f) => f.path.includes("role.md"));
      expect(startupRoleEntry).toBeDefined();
      expect(startupRoleEntry!.required).toBe(true);
    }
  });

  it("every guidance/role.md contains substantive role content", () => {
    for (const file of AGENT_SPECS) {
      const agentDir = join(SPECS_ROOT, file.replace("/agent.yaml", ""));
      const rolePath = join(agentDir, "guidance/role.md");
      const content = readFileSync(rolePath, "utf-8");

      // Must have a heading
      expect(content).toContain("# Role:");
      // Must have substantive content (at least 200 chars)
      expect(content.length).toBeGreaterThan(200);
      // Must mention responsibilities
      expect(content.toLowerCase()).toContain("responsibilities");
      // Must mention principles
      expect(content.toLowerCase()).toContain("principles");
    }
  });
});
