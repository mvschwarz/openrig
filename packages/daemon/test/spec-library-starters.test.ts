import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { rigPreflight, type RigPreflightInput } from "../src/domain/rigspec-preflight.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";

const SPECS_ROOT = resolve(import.meta.dirname, "../specs");

const RIG_SPECS = [
  "rigs/launch/implementation-pair/rig.yaml",
  "rigs/focused/adversarial-review/rig.yaml",
  "rigs/focused/research-team/rig.yaml",
  "rigs/launch/demo/rig.yaml",
  "rigs/preview/product-team/rig.yaml",
];
const PROOF_RIG_SPECS = [
  "secrets-manager.yaml",
];

const AGENT_SPECS = [
  "agents/design/product-designer/agent.yaml",
  "agents/development/implementer/agent.yaml",
  "agents/development/qa/agent.yaml",
  "agents/review/independent-reviewer/agent.yaml",
  "agents/orchestration/orchestrator/agent.yaml",
  "agents/research/analyst/agent.yaml",
  "agents/research/synthesizer/agent.yaml",
];

const SHARED_AGENT_SPEC = "agents/shared/agent.yaml";
const STARTER_AGENT_SPECS = [
  "agents/design/product-designer/agent.yaml",
  "agents/development/implementer/agent.yaml",
  "agents/development/qa/agent.yaml",
  "agents/review/independent-reviewer/agent.yaml",
  "agents/orchestration/orchestrator/agent.yaml",
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
    for (const file of [...AGENT_SPECS, SHARED_AGENT_SPEC]) {
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
    expect(rigs.length).toBeGreaterThanOrEqual(5);
    const names = rigs.map((e) => e.name);
    expect(names).toContain("implementation-pair");
    expect(names).toContain("adversarial-review");
    expect(names).toContain("research-team");
    expect(names).toContain("demo");
    expect(names).toContain("product-team");
  });

  it("starter summaries position implementation-pair as the first success, demo as the launch-grade starter, and product-team as the advanced preview", () => {
    const lib = new SpecLibraryService({
      roots: [{ path: SPECS_ROOT, sourceType: "builtin" }],
      specReviewService,
    });
    lib.scan();

    const rigs = lib.list({ kind: "rig" });
    const implementationPair = rigs.find((entry) => entry.name === "implementation-pair");
    const demo = rigs.find((entry) => entry.name === "demo");
    const productTeam = rigs.find((entry) => entry.name === "product-team");

    expect(implementationPair?.summary?.toLowerCase()).toContain("first success");
    expect(demo?.summary?.toLowerCase()).toContain("launch-grade");
    expect(demo?.summary?.toLowerCase()).not.toContain("advanced preview");
    expect(productTeam?.summary?.toLowerCase()).toContain("advanced preview");
    expect(productTeam?.summary?.toLowerCase()).not.toContain("happy-path starter");
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
        rigRoot: dirname(join(SPECS_ROOT, file)),
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

  it("service-backed proof rigs pass canonical rigPreflight with explicit cwdOverride", () => {
    const fsOps = {
      readFile: (p: string) => readFileSync(p, "utf-8"),
      exists: (p: string) => existsSync(p),
    };

    for (const file of PROOF_RIG_SPECS) {
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const input: RigPreflightInput = {
        rigSpecYaml: yaml,
        rigRoot: dirname(join(SPECS_ROOT, file)),
        cwdOverride: "/workspace/project",
        fsOps,
      };

      const result = rigPreflight(input);
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
      const startupFiles = (startup["files"] as Array<{ path: string; required?: boolean; delivery_hint?: string }>) ?? [];
      const startupRoleEntry = startupFiles.find((f) => f.path.includes("role.md"));
      expect(startupRoleEntry).toBeDefined();
      expect(startupRoleEntry!.required).toBe(true);
      expect(startupRoleEntry!.delivery_hint).toBe("send_text");
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

  it("shared packaged starter skills exist and builtin agents opt into the right ones", () => {
    const sharedYaml = readFileSync(join(SPECS_ROOT, SHARED_AGENT_SPEC), "utf-8");
    const sharedRaw = parseAgentSpec(sharedYaml) as Record<string, unknown>;
    const sharedResources = (sharedRaw["resources"] ?? {}) as Record<string, unknown>;
    const sharedSkills = (sharedResources["skills"] as Array<{ id: string; path: string }>) ?? [];
    const expectedSharedSkills = [
      "agent-browser",
      "brainstorming",
      "containerized-e2e",
      "dogfood",
      "executing-plans",
      "frontend-design",
      "openrig-user",
      "orchestration-team",
      "development-team",
      "review-team",
      "systematic-debugging",
      "test-driven-development",
      "using-superpowers",
      "verification-before-completion",
      "writing-plans",
    ];

    for (const skillId of expectedSharedSkills) {
      const skill = sharedSkills.find((entry) => entry.id === skillId);
      expect(skill).toBeDefined();
      expect(existsSync(join(SPECS_ROOT, "agents/shared", skill!.path, "SKILL.md"))).toBe(true);
    }

    const expectedAgentSkills = new Map<string, string[]>([
      [
        "agents/design/product-designer/agent.yaml",
        ["using-superpowers", "openrig-user", "development-team", "frontend-design", "brainstorming", "writing-plans", "verification-before-completion"],
      ],
      [
        "agents/development/implementer/agent.yaml",
        ["using-superpowers", "openrig-user", "development-team", "test-driven-development", "systematic-debugging", "writing-plans", "executing-plans", "verification-before-completion"],
      ],
      [
        "agents/development/qa/agent.yaml",
        ["using-superpowers", "openrig-user", "development-team", "systematic-debugging", "agent-browser", "dogfood", "writing-plans", "executing-plans", "verification-before-completion"],
      ],
      [
        "agents/review/independent-reviewer/agent.yaml",
        ["using-superpowers", "openrig-user", "review-team", "systematic-debugging", "brainstorming", "writing-plans", "verification-before-completion"],
      ],
      [
        "agents/orchestration/orchestrator/agent.yaml",
        ["using-superpowers", "openrig-user", "orchestration-team", "systematic-debugging", "brainstorming", "writing-plans", "executing-plans", "verification-before-completion"],
      ],
    ]);

    for (const file of AGENT_SPECS) {
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const raw = parseAgentSpec(yaml) as Record<string, unknown>;
      const imports = (raw["imports"] as Array<{ ref: string }> | undefined) ?? [];
      expect(imports.some((imp) => imp.ref === "local:../../shared")).toBe(true);

      const profiles = (raw["profiles"] as Record<string, Record<string, unknown>> | undefined) ?? {};
      const defaultProfile = profiles["default"] ?? {};
      const uses = (defaultProfile["uses"] as Record<string, unknown> | undefined) ?? {};
      const skills = (uses["skills"] as string[] | undefined) ?? [];
      for (const skillId of expectedAgentSkills.get(file) ?? ["openrig-user"]) {
        expect(skills).toContain(skillId);
      }
    }
  });

  it("starter role guidance explicitly names every packaged default skill it expects agents to load", () => {
    for (const file of STARTER_AGENT_SPECS) {
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const raw = parseAgentSpec(yaml) as Record<string, unknown>;
      const profiles = (raw["profiles"] as Record<string, Record<string, unknown>> | undefined) ?? {};
      const defaultProfile = profiles["default"] ?? {};
      const uses = (defaultProfile["uses"] as Record<string, unknown> | undefined) ?? {};
      const skills = (uses["skills"] as string[] | undefined) ?? [];
      const rolePath = join(SPECS_ROOT, file.replace("/agent.yaml", ""), "guidance/role.md");
      const content = readFileSync(rolePath, "utf-8");

      for (const skillId of skills) {
        expect(content).toContain(`\`${skillId}\``);
      }
    }
  });

  it("demo culture and orchestration skill require full topology settlement before dispatch", () => {
    const demoCulture = readFileSync(join(SPECS_ROOT, "rigs/launch/demo/CULTURE.md"), "utf-8");
    const orchestrationSkill = readFileSync(
      join(SPECS_ROOT, "agents/shared/skills/pods/orchestration-team/SKILL.md"),
      "utf-8",
    );

    expect(demoCulture).toContain("full expected demo topology");
    expect(demoCulture).toContain("dev1.qa");
    expect(demoCulture).toContain("rev1.r1");
    expect(demoCulture).toContain("rev1.r2");
    expect(orchestrationSkill).toContain("wait for the expected topology to settle");
    expect(orchestrationSkill).toContain("Do not silently shrink the team model");
    expect(orchestrationSkill).toContain("orch1.lead");
    expect(orchestrationSkill).toContain("dev1.qa");
    expect(orchestrationSkill).toContain("rev1.r1");
    expect(orchestrationSkill).toContain("rev1.r2");
  });
});
