import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { rigPreflight, type RigPreflightInput } from "../src/domain/rigspec-preflight.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";

const SPECS_ROOT = resolve(import.meta.dirname, "../specs");

const RIG_SPECS = [
  "rigs/launch/conveyor/rig.yaml",
  "rigs/launch/implementation-pair/rig.yaml",
  "rigs/focused/adversarial-review/rig.yaml",
  "rigs/focused/research-team/rig.yaml",
  "rigs/launch/demo/rig.yaml",
  "rigs/preview/product-team/rig.yaml",
  "rigs/launch/secrets-manager/rig.yaml",
];
const PROOF_RIG_SPECS: string[] = [];

const AGENT_SPECS = [
  "agents/conveyor/lead/agent.yaml",
  "agents/conveyor/planner/agent.yaml",
  "agents/conveyor/builder/agent.yaml",
  "agents/conveyor/reviewer/agent.yaml",
  "agents/design/product-designer/agent.yaml",
  "agents/development/implementer/agent.yaml",
  "agents/development/qa/agent.yaml",
  "agents/review/independent-reviewer/agent.yaml",
  "agents/orchestration/orchestrator/agent.yaml",
  "agents/research/analyst/agent.yaml",
  "agents/research/synthesizer/agent.yaml",
  "agents/apps/vault-specialist/agent.yaml",
];

const SHARED_AGENT_SPEC = "agents/shared/agent.yaml";

// V0.3.1 slice 05 kernel-rig-as-default + bug-fix slice
// deprecation-check-keys-widening: kernel agents are built-in product
// surface and pass through the same deprecation regression gates as
// starter agents. Hoisted from the prior inline declaration so the
// new key-path check (below) can walk both lists from a single source.
const KERNEL_AGENT_SPECS = [
  "rigs/launch/kernel/agents/advisor/lead/agent.yaml",
  "rigs/launch/kernel/agents/operator/agent/agent.yaml",
  "rigs/launch/kernel/agents/queue/worker/agent.yaml",
];

// bug-fix slice deprecation-check-keys-widening — IMPL-PRD §1.2 + §3.
// Allowlist of removed/deprecated KEY paths the spec library MUST NOT
// carry. Each entry uses dot-path notation with `*` as a profile-name
// wildcard. New deprecations append; commit message references this
// slice's IMPL-PRD as the authoritative taxonomy.
//
// v0 seed: the two keys the strict validator (agent-manifest.ts
// validateAgentSpec lines 191 + 240) already rejects with explicit
// plugin-primitive Phase 3a migration errors. The widening here is
// the regression gate — the validator's rejection is the runtime fix;
// this allowlist guarantees a static fail if a future contributor
// reintroduces the placeholder pattern that the e3bfc08 hotfix had
// to scrub from kernel agent.yaml files.
const DEPRECATED_KEY_PATHS: string[] = [
  "resources.hooks",
  "profiles.*.uses.hooks",
];
const STARTER_AGENT_SPECS = [
  "agents/conveyor/lead/agent.yaml",
  "agents/conveyor/planner/agent.yaml",
  "agents/conveyor/builder/agent.yaml",
  "agents/conveyor/reviewer/agent.yaml",
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
    expect(rigs.length).toBeGreaterThanOrEqual(7);
    const names = rigs.map((e) => e.name);
    expect(names).toContain("conveyor");
    expect(names).toContain("implementation-pair");
    expect(names).toContain("adversarial-review");
    expect(names).toContain("research-team");
    expect(names).toContain("demo");
    expect(names).toContain("product-team");
    expect(names).toContain("secrets-manager");
  });

  it("service-backed rigs expose hasServices, non-service rigs do not", () => {
    const lib = new SpecLibraryService({
      roots: [{ path: SPECS_ROOT, sourceType: "builtin" }],
      specReviewService,
    });
    lib.scan();

    const rigs = lib.list({ kind: "rig" });
    const secretsManager = rigs.find((entry) => entry.name === "secrets-manager");
    const demo = rigs.find((entry) => entry.name === "demo");

    expect(secretsManager).toBeDefined();
    expect(secretsManager!.hasServices).toBe(true);
    expect(demo).toBeDefined();
    expect(demo!.hasServices).toBeFalsy();
  });

  it("secrets-manager rig uses canonical vault.specialist topology", () => {
    const yaml = readFileSync(join(SPECS_ROOT, "rigs/launch/secrets-manager/rig.yaml"), "utf-8");
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    const pods = parsed["pods"] as Array<Record<string, unknown>>;
    expect(pods).toHaveLength(1);

    const pod = pods[0]!;
    expect(pod["id"]).toBe("vault");
    expect(pod["label"]).toBeDefined();

    const members = pod["members"] as Array<Record<string, unknown>>;
    expect(members).toHaveLength(1);
    expect(members[0]!["id"]).toBe("specialist");
    expect(members[0]!["agent_ref"]).toContain("vault-specialist");

    // Summary must explicitly mention the specialist
    const summary = (parsed["summary"] as string).toLowerCase();
    expect(summary).toContain("specialist");
  });

  it("starter summaries position conveyor as the generic starter and product-team as the advanced product lane", () => {
    const lib = new SpecLibraryService({
      roots: [{ path: SPECS_ROOT, sourceType: "builtin" }],
      specReviewService,
    });
    lib.scan();

    const rigs = lib.list({ kind: "rig" });
    const conveyor = rigs.find((entry) => entry.name === "conveyor");
    const implementationPair = rigs.find((entry) => entry.name === "implementation-pair");
    const demo = rigs.find((entry) => entry.name === "demo");
    const productTeam = rigs.find((entry) => entry.name === "product-team");

    expect(conveyor?.summary?.toLowerCase()).toContain("station pipeline");
    expect(conveyor?.summary?.toLowerCase()).toContain("starter");
    expect(implementationPair?.summary?.toLowerCase()).toContain("first success");
    expect(demo?.summary?.toLowerCase()).toContain("launch-grade");
    expect(demo?.summary?.toLowerCase()).not.toContain("advanced preview");
    expect(productTeam?.summary?.toLowerCase()).toContain("advanced product-development starter");
    expect(productTeam?.summary?.toLowerCase()).not.toContain("demo");
    expect(productTeam?.summary?.toLowerCase()).not.toContain("advanced preview");
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

  it("vault-specialist startup context grounds identity before topology claims", () => {
    const context = readFileSync(join(SPECS_ROOT, "agents/apps/vault-specialist/startup/context.md"), "utf-8").toLowerCase();

    expect(context).toContain("rig whoami --json");
    expect(context).toContain("before making topology or registration claims");
  });

  it("openrig-user documents agent-managed apps and current cwd/env operation", () => {
    const content = readFileSync(join(SPECS_ROOT, "agents/shared/skills/core/openrig-user/SKILL.md"), "utf-8");

    expect(content).toContain("agent-managed app");
    expect(content).toContain("rig up secrets-manager");
    expect(content).toContain("vault.specialist");
    expect(content).toContain("rig send vault-specialist@secrets-manager");
    expect(content).toContain("rig env status secrets-manager");
    expect(content).toContain("rig env logs secrets-manager");
    expect(content).toContain("`rig up --cwd`");
    expect(content).not.toContain("there is no shipped `rig up --cwd` override yet");
  });

  it("shared packaged starter skills exist and builtin agents opt into the right ones", () => {
    const sharedYaml = readFileSync(join(SPECS_ROOT, SHARED_AGENT_SPEC), "utf-8");
    const sharedRaw = parseAgentSpec(sharedYaml) as Record<string, unknown>;
    const sharedResources = (sharedRaw["resources"] ?? {}) as Record<string, unknown>;
    const sharedSkills = (sharedResources["skills"] as Array<{ id: string; path: string }>) ?? [];
    const expectedSharedSkills = [
      // Slice 29 deletions removed: claude-compact-in-place,
      // containerized-e2e, control-plane-queue, intake-routing,
      // local-sysadmin (mis-imports or internal-only doctrine).
      "agent-browser",
      "brainstorming",
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
    const deprecatedHaSkill = ["mental", "model", "ha"].join("-");
    expect(sharedSkills.map((entry) => entry.id)).not.toContain(deprecatedHaSkill);

    const sharedRuntimeResources = (sharedResources["runtime_resources"] as Array<{ id: string; path: string; type: string }>) ?? [];
    for (const resourceId of ["claude-default-settings", "claude-default-mcp", "codex-default-config"]) {
      const resource = sharedRuntimeResources.find((entry) => entry.id === resourceId);
      expect(resource).toBeDefined();
      expect(existsSync(join(SPECS_ROOT, "agents/shared", resource!.path))).toBe(true);
    }
    const claudeSettingsResource = sharedRuntimeResources.find((entry) => entry.id === "claude-default-settings");
    const claudeSettings = JSON.parse(readFileSync(join(SPECS_ROOT, "agents/shared", claudeSettingsResource!.path), "utf-8"));
    expect(claudeSettings.permissions.allow).toEqual(["Bash(rig:*)"]);
    expect(claudeSettings.permissions.ask).toEqual(["Bash(rig up:*)", "Bash(rig down:*)"]);
    expect(claudeSettings.permissions.deny).toBeUndefined();

    // Slice 29: claude-compact-in-place skill DELETED (was mis-imported as a
    // skill; its content remains in skill-spec docs not under skills/).

    const expectedAgentSkills = new Map<string, string[]>([
      [
        "agents/conveyor/lead/agent.yaml",
        ["openrig-user", "orchestration-team", "backlog-capture", "writing-plans", "executing-plans", "verification-before-completion", "brainstorming"],
      ],
      [
        "agents/conveyor/planner/agent.yaml",
        ["openrig-user", "requirements-writer", "context-builder", "writing-plans", "verification-before-completion"],
      ],
      [
        "agents/conveyor/builder/agent.yaml",
        ["openrig-user", "development-team", "test-driven-development", "systematic-debugging", "executing-plans", "verification-before-completion"],
      ],
      [
        "agents/conveyor/reviewer/agent.yaml",
        ["openrig-user", "review-team", "plan-review", "systematic-debugging", "verification-before-completion"],
      ],
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

  it("public builtin agent profiles do not reference deprecated HA skill", () => {
    const deprecatedHaSkill = ["mental", "model", "ha"].join("-");
    // V0.3.1 slice 05 kernel-rig-as-default: kernel agents are now
    // built-in product surface and must respect the same deprecation
    // curation as starter agents. Caught at Phase 05d forward-fix #2
    // when advisor.lead reintroduced the deprecated skill reference.
    for (const file of [...AGENT_SPECS, ...KERNEL_AGENT_SPECS]) {
      const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
      const raw = parseAgentSpec(yaml) as Record<string, unknown>;
      const profiles = (raw["profiles"] as Record<string, Record<string, unknown>> | undefined) ?? {};
      const defaultProfile = profiles["default"] ?? {};
      const uses = (defaultProfile["uses"] as Record<string, unknown> | undefined) ?? {};
      const skills = (uses["skills"] as string[] | undefined) ?? [];
      expect(skills).not.toContain(deprecatedHaSkill);
    }
  });

  // bug-fix slice deprecation-check-keys-widening — IMPL-PRD §4 +
  // §5. The deprecation-check pattern previously only enforced
  // against deprecated SKILL refs in profile.uses.skills. After the
  // 2026-05-10 hotfix at e3bfc08 (which had to scrub `hooks: []`
  // placeholders from kernel agent.yaml because the strict validator
  // rejected them), the regression class is open — a future
  // contributor can reintroduce that placeholder pattern or add a
  // newly-deprecated KEY path and the test won't catch it. The block
  // below widens to two new check categories: KEY-path allowlist +
  // strict-validator inline invocation.
  describe("deprecated KEY path + strict-validator gate", () => {
    function hasDeprecatedKeyPath(obj: Record<string, unknown>, path: string): boolean {
      // path uses dot-notation with `*` as a profile-name wildcard.
      // Walk the object honoring the wildcard at the matching segment.
      const segments = path.split(".");
      function walk(node: unknown, idx: number): boolean {
        if (idx >= segments.length) return node !== undefined;
        if (!node || typeof node !== "object" || Array.isArray(node)) return false;
        const seg = segments[idx]!;
        const map = node as Record<string, unknown>;
        if (seg === "*") {
          for (const v of Object.values(map)) {
            if (walk(v, idx + 1)) return true;
          }
          return false;
        }
        if (!(seg in map)) return false;
        return walk(map[seg], idx + 1);
      }
      return walk(obj, 0);
    }

    it("DEPRECATED_KEY_PATHS is non-empty + references the IMPL-PRD", () => {
      // T1: documentation gate — the allowlist must be discoverable
      // (greppable) and must point at this slice's IMPL-PRD so future
      // contributors know where to append.
      expect(DEPRECATED_KEY_PATHS.length).toBeGreaterThan(0);
      const fileText = readFileSync(__filename, "utf-8");
      expect(fileText).toContain("deprecation-check-keys-widening");
    });

    it("AGENT_SPECS + kernel agent.yaml carry no deprecated KEY paths", () => {
      // T2 + T3: every shipped agent spec is scanned against the
      // DEPRECATED_KEY_PATHS allowlist. A hit fails the test with the
      // file + path so the operator can locate and remove it.
      const offenders: string[] = [];
      for (const file of [...AGENT_SPECS, ...KERNEL_AGENT_SPECS]) {
        const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
        const raw = parseAgentSpec(yaml) as Record<string, unknown>;
        for (const path of DEPRECATED_KEY_PATHS) {
          if (hasDeprecatedKeyPath(raw, path)) {
            offenders.push(`${file}: ${path}`);
          }
        }
      }
      if (offenders.length > 0) {
        throw new Error(
          `Deprecated KEY paths found in shipped agent specs:\n  - ${offenders.join("\n  - ")}\n` +
            `These keys are listed in DEPRECATED_KEY_PATHS at the top of this test file. Remove them from the spec or — if the key is no longer deprecated — drop the entry from the allowlist.`,
        );
      }
    });

    it("AGENT_SPECS + kernel agent.yaml pass validateAgentSpec strict validator", () => {
      // T4: the strict validator is the authoritative runtime gate.
      // Running it inline at test time catches empty-array
      // placeholders (e.g., resources.hooks: [] / profiles.*.uses.hooks: [])
      // the moment they appear in a shipped spec — without waiting
      // for kernel auto-boot to surface them via daemon start failure
      // (which is exactly how e3bfc08 was discovered).
      const offenders: string[] = [];
      for (const file of [...AGENT_SPECS, ...KERNEL_AGENT_SPECS]) {
        const yaml = readFileSync(join(SPECS_ROOT, file), "utf-8");
        const raw = parseAgentSpec(yaml);
        const result = validateAgentSpec(raw);
        if (!result.valid) {
          offenders.push(`${file}:\n    - ${result.errors.join("\n    - ")}`);
        }
      }
      if (offenders.length > 0) {
        throw new Error(`validateAgentSpec rejected shipped specs:\n  - ${offenders.join("\n  - ")}`);
      }
    });

    const FIXTURE_DIR = join(__dirname, "fixtures", "deprecation-check");

    it("regression fixture with empty-hooks placeholder is rejected by strict validator (T5: e3bfc08 coverage)", () => {
      // T5: discriminator for the empty-array-placeholder failure
      // class. If this fixture starts passing the validator (e.g.,
      // someone loosens the strict check), the regression coverage
      // for the hotfix scenario is gone — the test will flag it.
      const yaml = readFileSync(join(FIXTURE_DIR, "agent-with-empty-hooks.yaml"), "utf-8");
      const result = validateAgentSpec(parseAgentSpec(yaml));
      expect(result.valid).toBe(false);
      // Specifically the profiles.<name>.uses.hooks error message
      // from agent-manifest.ts line 240 — anchors the discrimination
      // to the same code path that the runtime invokes.
      expect(result.errors.some((e) => /uses\.hooks/.test(e))).toBe(true);
    });

    it("regression fixture with deprecated KEY path is flagged by the allowlist (T6)", () => {
      // T6: discriminator for the KEY-path allowlist. The fixture
      // carries resources.hooks (a removed key per plugin-primitive
      // Phase 3a). The allowlist walker must report this entry as
      // an offender even if validateAgentSpec is not invoked.
      const yaml = readFileSync(join(FIXTURE_DIR, "agent-with-removed-key.yaml"), "utf-8");
      const raw = parseAgentSpec(yaml) as Record<string, unknown>;
      const hits = DEPRECATED_KEY_PATHS.filter((p) => hasDeprecatedKeyPath(raw, p));
      expect(hits).toContain("resources.hooks");
    });

    it("clean fixture passes both checks (T7: no false positives)", () => {
      // T7: baseline. A minimal valid agent.yaml must clear both the
      // allowlist scan and the strict validator. Guards against the
      // allowlist or the validator drifting too aggressive.
      const yaml = readFileSync(join(FIXTURE_DIR, "agent-clean.yaml"), "utf-8");
      const raw = parseAgentSpec(yaml) as Record<string, unknown>;
      const hits = DEPRECATED_KEY_PATHS.filter((p) => hasDeprecatedKeyPath(raw, p));
      expect(hits).toEqual([]);
      const result = validateAgentSpec(raw);
      if (!result.valid) {
        throw new Error(`clean fixture failed strict validator:\n  - ${result.errors.join("\n  - ")}`);
      }
    });
  });

  it("built-in library scan discovers vault-specialist agent", () => {
    const lib = new SpecLibraryService({
      roots: [{ path: SPECS_ROOT, sourceType: "builtin" }],
      specReviewService,
    });
    lib.scan();

    const agents = lib.list({ kind: "agent" });
    const names = agents.map((e) => e.name);
    expect(names).toContain("vault-specialist");
  });

  it("vault-specialist agent has correct profile, startup, guidance, and skill files", () => {
    const specPath = "agents/apps/vault-specialist/agent.yaml";
    const agentDir = join(SPECS_ROOT, "agents/apps/vault-specialist");
    const yaml = readFileSync(join(SPECS_ROOT, specPath), "utf-8");
    const raw = parseAgentSpec(yaml) as Record<string, unknown>;
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);

    // Default profile includes vault-user skill
    const profiles = (raw["profiles"] as Record<string, Record<string, unknown>>) ?? {};
    const defaultProfile = profiles["default"] ?? {};
    const uses = (defaultProfile["uses"] as Record<string, unknown>) ?? {};
    const skills = (uses["skills"] as string[]) ?? [];
    expect(skills).toContain("vault-user");

    // Startup includes guidance/role.md and startup/context.md
    const startup = (raw["startup"] ?? {}) as Record<string, unknown>;
    const startupFiles = (startup["files"] as Array<{ path: string; required?: boolean; delivery_hint?: string }>) ?? [];
    const roleStartup = startupFiles.find((f) => f.path.includes("role.md"));
    expect(roleStartup).toBeDefined();
    expect(roleStartup!.required).toBe(true);
    expect(roleStartup!.delivery_hint).toBe("send_text");
    const contextStartup = startupFiles.find((f) => f.path.includes("context.md"));
    expect(contextStartup).toBeDefined();
    expect(contextStartup!.required).toBe(true);
    expect(contextStartup!.delivery_hint).toBe("send_text");

    // Guidance references role.md
    const resources = (raw["resources"] ?? {}) as Record<string, unknown>;
    const guidance = resources["guidance"] as Array<{ path: string }> | undefined;
    expect(guidance).toBeDefined();
    const roleGuidance = guidance!.find((g) => g.path.includes("role.md"));
    expect(roleGuidance).toBeDefined();

    // Files exist on disk
    expect(existsSync(join(agentDir, "guidance/role.md"))).toBe(true);
    expect(existsSync(join(agentDir, "startup/context.md"))).toBe(true);
    expect(existsSync(join(agentDir, "skills/vault-user/SKILL.md"))).toBe(true);

    // Role guidance is substantive
    const roleContent = readFileSync(join(agentDir, "guidance/role.md"), "utf-8");
    expect(roleContent).toContain("# Role:");
    expect(roleContent.length).toBeGreaterThan(200);
    expect(roleContent.toLowerCase()).toContain("responsibilities");
    expect(roleContent.toLowerCase()).toContain("principles");
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
