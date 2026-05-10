import { describe, it, expect } from "vitest";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import type { AgentSpec, RigSpec, RigSpecPod, RigSpecPodMember, StartupBlock } from "../src/domain/types.js";
import type { ResolvedAgentSpec, ResourceCollision } from "../src/domain/agent-resolver.js";

function makeSpec(overrides?: Partial<AgentSpec>): AgentSpec {
  return {
    version: "1.0.0",
    name: "test-agent",
    imports: [],
    startup: { files: [{ path: "startup/base.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    resources: {
      skills: [{ id: "skill-a", path: "skills/a" }],
      guidance: [],
      subagents: [],
      hooks: [],
      runtimeResources: [],
    },
    profiles: {
      default: {
        uses: { skills: ["skill-a"], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
      },
    },
    ...overrides,
  };
}

function makeResolved(spec: AgentSpec, path = "/agents/test"): ResolvedAgentSpec {
  return { spec, sourcePath: path, hash: "abc123" };
}

function makeMember(overrides?: Partial<RigSpecPodMember>): RigSpecPodMember {
  return { id: "impl", agentRef: "local:agents/test", profile: "default", runtime: "claude-code", cwd: ".", ...overrides };
}

function makePod(overrides?: Partial<RigSpecPod>): RigSpecPod {
  return { id: "dev", label: "Dev", members: [makeMember()], edges: [], ...overrides };
}

function makeRig(overrides?: Partial<RigSpec>): RigSpec {
  return { version: "0.2", name: "test-rig", pods: [makePod()], edges: [], ...overrides };
}

function makeCtx(overrides?: Partial<ResolutionContext>): ResolutionContext {
  const spec = makeSpec();
  return {
    baseSpec: makeResolved(spec),
    importedSpecs: [],
    collisions: [],
    profileName: "default",
    member: makeMember(),
    pod: makePod(),
    rig: makeRig(),
    ...overrides,
  };
}

describe("Profile resolver + precedence engine", () => {
  // T1: profile selects from combined base+import pool
  it("profile selects from combined base+import pool with effectiveId and sourcePath", () => {
    const importSpec = makeSpec({
      name: "lib",
      resources: { skills: [{ id: "lib-skill", path: "skills/lib" }], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        profiles: {
          default: { uses: { skills: ["skill-a", "lib:lib-skill"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      })),
      importedSpecs: [makeResolved(importSpec, "/agents/lib")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.selectedResources.skills).toHaveLength(2);
      const base = result.config.selectedResources.skills.find((r) => r.effectiveId === "skill-a");
      expect(base).toBeDefined();
      expect(base!.sourcePath).toBe("/agents/test");
      const imported = result.config.selectedResources.skills.find((r) => r.effectiveId === "lib:lib-skill");
      expect(imported).toBeDefined();
      expect(imported!.sourcePath).toBe("/agents/lib");
    }
  });

  // T2: unqualified ambiguous resource reference fails (import/import collision)
  it("unqualified ambiguous resource reference from two imports fails", () => {
    const importA = makeSpec({
      name: "lib-a",
      resources: { skills: [{ id: "shared", path: "skills/shared" }], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
      profiles: {},
    });
    const importB = makeSpec({
      name: "lib-b",
      resources: { skills: [{ id: "shared", path: "skills/shared" }], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: { default: { uses: { skills: ["shared"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } } },
      })),
      importedSpecs: [makeResolved(importA, "/agents/lib-a"), makeResolved(importB, "/agents/lib-b")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/ambiguous/);
    }
  });

  // T2b: base/import collision — base keeps unqualified id
  it("base/import collision: base keeps unqualified id, no ambiguity", () => {
    const importSpec = makeSpec({
      name: "lib",
      resources: { skills: [{ id: "skill-a", path: "skills/a-lib" }], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      importedSpecs: [makeResolved(importSpec, "/agents/lib")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Base spec's skill-a is selected (not ambiguous)
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("skill-a");
      expect(result.config.selectedResources.skills[0]!.sourceSpec).toBe("test-agent");
    }
  });

  // T3: qualified colliding reference succeeds
  it("qualified colliding reference succeeds with sourcePath", () => {
    const importSpec = makeSpec({
      name: "lib",
      resources: { skills: [{ id: "skill-a", path: "skills/a-lib" }], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        profiles: {
          default: { uses: { skills: ["lib:skill-a"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      })),
      importedSpecs: [makeResolved(importSpec, "/agents/lib")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("lib:skill-a");
      expect(result.config.selectedResources.skills[0]!.sourcePath).toBe("/agents/lib");
    }
  });

  it("single imported unqualified skill keeps the unqualified effectiveId", () => {
    const importSpec = makeSpec({
      name: "shared",
      resources: { skills: [{ id: "openrig-user", path: "skills/openrig-user" }], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["openrig-user"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      })),
      importedSpecs: [makeResolved(importSpec, "/agents/shared")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("openrig-user");
      expect(result.config.selectedResources.skills[0]!.sourcePath).toBe("/agents/shared");
      expect(result.config.selectedResources.skills[0]!.sourceSpec).toBe("shared");
    }
  });

  // T4: rig member runtime overrides profile preference
  it("rig member runtime overrides profile preference", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { runtime: "codex" },
        profiles: { default: { preferences: { runtime: "codex" }, uses: { skills: ["skill-a"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } } },
      })),
      member: makeMember({ runtime: "claude-code" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.runtime).toBe("claude-code");
  });

  // T5: rig member model overrides profile preference
  it("rig member model overrides profile preference", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { model: "sonnet" },
        profiles: { default: { preferences: { model: "haiku" }, uses: { skills: ["skill-a"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } } },
      })),
      member: makeMember({ model: "opus" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.model).toBe("opus");
  });

  // T6: rig member cwd is authoritative
  it("rig member cwd is authoritative", () => {
    const ctx = makeCtx({
      specRoot: "/workspace/spec-root",
      member: makeMember({ cwd: "/custom/workdir" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.cwd).toBe("/custom/workdir");
  });

  it("resolves relative member cwd against specRoot", () => {
    const ctx = makeCtx({
      specRoot: "/workspace/spec-root",
      member: makeMember({ cwd: "." }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.cwd).toBe("/workspace/spec-root");
  });

  it("explicit cwdOverride overrides even authored absolute cwd", () => {
    const ctx = makeCtx({
      specRoot: "/workspace/spec-root",
      cwdOverride: "/override/project",
      member: makeMember({ cwd: "/authored/absolute" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.cwd).toBe("/override/project");
  });

  // T7: resume_if_possible -> relaunch_fresh narrowing allowed
  it("restore policy narrowing from resume_if_possible to relaunch_fresh allowed", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { lifecycle: { executionMode: "interactive_resident", compactionStrategy: "harness_native", restorePolicy: "resume_if_possible" } },
        profiles: { default: { uses: { skills: ["skill-a"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } } },
      })),
      member: makeMember({ restorePolicy: "relaunch_fresh" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.restorePolicy).toBe("relaunch_fresh");
  });

  // T8: checkpoint_only -> resume_if_possible broadening rejected
  it("restore policy broadening from checkpoint_only to resume_if_possible rejected", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { lifecycle: { executionMode: "interactive_resident", compactionStrategy: "harness_native", restorePolicy: "checkpoint_only" } },
        profiles: { default: { uses: { skills: ["skill-a"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } } },
      })),
      member: makeMember({ restorePolicy: "resume_if_possible" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/broadens/);
  });

  // T11: rig cannot inject resources (selectedResources from agent pool only)
  it("rig cannot inject resources — selection comes from agent pool only", () => {
    // The resolver only takes resources from AgentSpec + imports.
    // There is no mechanism for the rig to inject resources.
    const ctx = makeCtx();
    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only skill-a from the base spec should be selected
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("skill-a");
    }
  });

  // T12: startup is additive only — no subtraction API exists
  it("startup is additive only — no removal mechanism", () => {
    // The resolver only appends. There is no subtract/remove/delete on StartupBlock.
    // This test verifies the output shape has no removal concept.
    const ctx = makeCtx();
    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The startup block only has files and actions — no "removals" field
      const keys = Object.keys(result.config.startup);
      expect(keys.sort()).toEqual(["actions", "files"]);
    }
  });
});

describe("V0.3.0 daemon-skill-discovery — filesystem-discovered skills join the resource pool", () => {
  // Helper to set up a tmp homedir + cwd with skill folders for the
  // resolver-integration tests. These use real fs because the resolver
  // calls into discoverSkillsForRuntime synchronously, and a stub layer
  // would only test the wiring trivially. mkdtemp / rmSync keep each
  // case isolated.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  let tmpRoot: string;
  let homedir: string;
  let cwd: string;

  function writeSkill(dir: string, name: string, description: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, "utf-8");
  }

  function withFsFixture<T>(fn: () => T): T {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "profile-resolver-disc-"));
    homedir = path.join(tmpRoot, "home");
    cwd = path.join(tmpRoot, "rig-cwd");
    fs.mkdirSync(homedir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    try { return fn(); } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  }

  it("accepts a profile.uses.skills entry that resolves only via the discovered ~/.claude/skills/ path", () => {
    withFsFixture(() => {
      writeSkill(path.join(homedir, ".claude/skills/openrig-architect"), "openrig-architect", "Architect rigs");
      const baseSpec = makeSpec({
        // Note: NO `openrig-architect` in resources.skills; the only way
        // for the profile to resolve it is via filesystem discovery.
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["openrig-architect"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const found = result.config.selectedResources.skills.find((s) => s.effectiveId === "openrig-architect");
        expect(found).toBeDefined();
        expect(found!.sourcePath).toBe(path.join(homedir, ".claude/skills/openrig-architect"));
      }
    });
  });

  it("accepts a profile.uses.skills entry resolving via a rig-bundled <cwd>/.claude/skills/<name>/", () => {
    withFsFixture(() => {
      writeSkill(path.join(cwd, ".claude/skills/web-design-guidelines"), "web-design-guidelines", "Web design checks");
      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["web-design-guidelines"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
    });
  });

  it("rig-local resources.skills wins over a same-id discovered skill (most-specific-wins precedence)", () => {
    withFsFixture(() => {
      writeSkill(path.join(homedir, ".claude/skills/skill-a"), "skill-a", "Discovered version");
      // makeSpec already declares { id: 'skill-a', path: 'skills/a' } in
      // resources.skills; the rig-local version should win.
      const ctx = makeCtx({
        baseSpec: makeResolved(makeSpec()),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const skillA = result.config.selectedResources.skills.find((s) => s.effectiveId === "skill-a");
        expect(skillA).toBeDefined();
        // rig-local sourcePath (the agent spec's sourcePath), NOT the
        // homedir-discovered SKILL.md directory.
        expect(skillA!.sourcePath).toBe("/agents/test");
      }
    });
  });

  it("scans the codex .agents/skills/ tree when the runtime is codex", () => {
    withFsFixture(() => {
      writeSkill(path.join(homedir, ".agents/skills/openrig-architect"), "openrig-architect", "Architect rigs");
      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["openrig-architect"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd, runtime: "codex" }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
    });
  });

  it("preserves the existing 'skill not found' error when a profile references a skill that exists at neither the rig-local nor the discovered paths", () => {
    withFsFixture(() => {
      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["nope-not-anywhere"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("nope-not-anywhere"))).toBe(true);
      }
    });
  });

  it("surfaces the structural rejection reason when a profile references a skill whose dirname matches a rejected SKILL.md", () => {
    withFsFixture(() => {
      // Operator dropped a SKILL.md with no frontmatter at the
      // ~/.claude/skills/broken-skill/ path. The profile references
      // "broken-skill" — instead of the bare "not found in resource
      // pool" error, the operator should see "rejected because
      // <reason> at <path>" so they know exactly what to fix.
      const dir = path.join(homedir, ".claude/skills/broken-skill");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "no frontmatter here\n", "utf-8");

      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["broken-skill"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const msg = result.errors.find((e) => e.includes("broken-skill"));
        expect(msg).toBeDefined();
        expect(msg).toMatch(/rejected/i);
        expect(msg).toMatch(/frontmatter/i);
        expect(msg).toContain(dir);
      }
    });
  });

  it("does not falsely tie an unrelated rejected SKILL.md to a missing-skill error (basename match only)", () => {
    withFsFixture(() => {
      // Operator has a broken skill at ~/.claude/skills/foo/ (rejected)
      // and a profile that references "bar" (which exists nowhere).
      // The "bar" error should NOT be conflated with foo's rejection.
      const dir = path.join(homedir, ".claude/skills/foo");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "no frontmatter\n", "utf-8");

      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["bar"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const msg = result.errors.find((e) => e.includes("bar"));
        expect(msg).toBeDefined();
        // Plain "not found in resource pool" — not "rejected".
        expect(msg).toMatch(/not found/);
        expect(msg).not.toMatch(/rejected/);
      }
    });
  });
});
