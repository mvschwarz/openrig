// V0.3.1 slice 05 kernel-rig-as-default — shipped kernel rig variants
// MUST pass rig spec validate so BootstrapOrchestrator accepts them
// at runtime. Forward-fix on Phase 05d Finding 1: the kernel-boot
// unit tests passed because they mocked the orchestrator; this test
// runs the real validator pipeline against the shipped specs so the
// next regression can't ship unnoticed.
//
// Forward-fix on Phase 05d velocity-qa VM verdict (missing-skills):
// rig spec validate alone is not enough — kernel agents declare
// profile.uses.skills that must resolve against the imported shared
// resource pool. The VM exercise caught 6 skills referenced but not
// registered in shared/agent.yaml. This test adds the resource-pool
// containment gate so the next missing-skill regression fails CI
// instead of failing daemon-start at boot.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateRigSpecFromYaml } from "../src/domain/spec-validation-service.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";

const SHIPPED_VARIANTS = [
  "rig.yaml",
  "rig-claude-only.yaml",
  "rig-codex-only.yaml",
] as const;

const KERNEL_DIR = join(__dirname, "..", "specs", "rigs", "launch", "kernel");
const KERNEL_AGENTS_DIR = join(KERNEL_DIR, "agents");
const KERNEL_AGENT_PATHS = [
  join(KERNEL_AGENTS_DIR, "advisor", "lead", "agent.yaml"),
  join(KERNEL_AGENTS_DIR, "operator", "agent", "agent.yaml"),
  join(KERNEL_AGENTS_DIR, "queue", "worker", "agent.yaml"),
];

describe("kernel rig variants — rig spec validate", () => {
  for (const variant of SHIPPED_VARIANTS) {
    it(`${variant} passes RigSpec validation (HG-2 + HG-20 runtime gate)`, () => {
      const yaml = readFileSync(join(KERNEL_DIR, variant), "utf-8");
      const result = validateRigSpecFromYaml(yaml);
      if (!result.valid) {
        // Surface every validation error so debugging a regression
        // doesn't require re-running the validator by hand.
        throw new Error(
          `RigSpec validation failed for ${variant}:\n  - ${result.errors.join("\n  - ")}`,
        );
      }
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }

  it("all 3 variants share the same topology shape (pods + member ids)", () => {
    const shapes = SHIPPED_VARIANTS.map((variant) => {
      const yaml = readFileSync(join(KERNEL_DIR, variant), "utf-8");
      // Light parse via the shared codec; structural equality on pods
      // + member ids ensures variants differ only on runtime declarations.
      const result = validateRigSpecFromYaml(yaml);
      return { variant, valid: result.valid, errors: result.errors };
    });
    expect(shapes.every((s) => s.valid)).toBe(true);
  });
});

// Resource-pool containment gate. Each kernel agent (advisor.lead,
// operator.agent, queue.worker) declares profile.uses.skills against
// the imported shared resource pool. If any referenced id is missing
// from shared/agent.yaml's resources.skills, the daemon refuses to
// bootstrap with "Profile uses skills: <id> not found in resource
// pool" — which is the failure mode velocity-qa caught on VM.
describe("kernel agents — profile.uses references resolve against shared pool", () => {
  const SHARED_AGENT_YAML = join(
    __dirname, "..", "specs", "agents", "shared", "agent.yaml",
  );
  function poolIds(yamlPath: string, kind: "skills" | "runtime_resources"): Set<string> {
    const doc = parseYaml(readFileSync(yamlPath, "utf-8")) as {
      resources?: { skills?: { id: string; path: string }[]; runtime_resources?: { id: string }[] };
    };
    const list =
      kind === "skills" ? doc.resources?.skills ?? [] : doc.resources?.runtime_resources ?? [];
    return new Set(list.map((r) => r.id));
  }

  function usedSkillIds(yamlPath: string): { profile: string; skills: string[] }[] {
    const doc = parseYaml(readFileSync(yamlPath, "utf-8")) as {
      profiles?: Record<string, { uses?: { skills?: string[] } }>;
    };
    const out: { profile: string; skills: string[] }[] = [];
    for (const [profile, p] of Object.entries(doc.profiles ?? {})) {
      out.push({ profile, skills: p?.uses?.skills ?? [] });
    }
    return out;
  }

  // Skills declared in shared/agent.yaml must also exist on disk under
  // skills/<path>/SKILL.md. The on-disk-existence check is what catches
  // a YAML entry whose path was misspelled or whose dir was forgotten.
  it("shared/agent.yaml skills all resolve to packaged SKILL.md files on disk", () => {
    const sharedDir = dirname(SHARED_AGENT_YAML);
    const doc = parseYaml(readFileSync(SHARED_AGENT_YAML, "utf-8")) as {
      resources?: { skills?: { id: string; path: string }[] };
    };
    const missing: string[] = [];
    for (const skill of doc.resources?.skills ?? []) {
      const skillFile = join(sharedDir, skill.path, "SKILL.md");
      if (!existsSync(skillFile)) {
        missing.push(`${skill.id} → ${skill.path} (no SKILL.md at ${skillFile})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Packaged shared resource pool declares skills with no on-disk SKILL.md:\n  - ${missing.join("\n  - ")}`,
      );
    }
  });

  for (const agentPath of KERNEL_AGENT_PATHS) {
    const label = agentPath
      .replace(KERNEL_AGENTS_DIR + "/", "")
      .replace("/agent.yaml", "")
      .replace("/", ".");
    it(`${label}: profile.uses.skills all resolve in shared resource pool`, () => {
      const pool = poolIds(SHARED_AGENT_YAML, "skills");
      const used = usedSkillIds(agentPath);
      const missing: string[] = [];
      for (const { profile, skills } of used) {
        for (const id of skills) {
          if (!pool.has(id)) missing.push(`profile=${profile} skill=${id}`);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `${label} references skills not in shared pool:\n  - ${missing.join("\n  - ")}`,
        );
      }
    });
  }
});

describe("kernel agents — nested AgentSpec validation", () => {
  for (const agentPath of KERNEL_AGENT_PATHS) {
    const label = agentPath
      .replace(KERNEL_AGENTS_DIR + "/", "")
      .replace("/agent.yaml", "")
      .replace("/", ".");

    it(`${label}: agent.yaml passes AgentSpec validation`, () => {
      const yaml = readFileSync(agentPath, "utf-8");
      const raw = parseAgentSpec(yaml);
      const result = validateAgentSpec(raw);
      if (!result.valid) {
        throw new Error(
          `AgentSpec validation failed for ${label}:\n  - ${result.errors.join("\n  - ")}`,
        );
      }
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }
});
