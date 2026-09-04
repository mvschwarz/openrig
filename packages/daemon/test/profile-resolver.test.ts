import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import { parseAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";
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
      plugins: [],
      runtimeResources: [],
    },
    profiles: {
      default: {
        uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
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
      resources: { skills: [{ id: "lib-skill", path: "skills/lib" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        profiles: {
          default: { uses: { skills: ["skill-a", "lib:lib-skill"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
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
      resources: { skills: [{ id: "shared", path: "skills/shared" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const importB = makeSpec({
      name: "lib-b",
      resources: { skills: [{ id: "shared", path: "skills/shared" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: { default: { uses: { skills: ["shared"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
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
      resources: { skills: [{ id: "skill-a", path: "skills/a-lib" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
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
      resources: { skills: [{ id: "skill-a", path: "skills/a-lib" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        profiles: {
          default: { uses: { skills: ["lib:skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
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
      resources: { skills: [{ id: "openrig-user", path: "skills/openrig-user" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["openrig-user"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
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
        profiles: { default: { preferences: { runtime: "codex" }, uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
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
        profiles: { default: { preferences: { model: "haiku" }, uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
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
        profiles: { default: { uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
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
        profiles: { default: { uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
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

  // Slice 15 HG-7 — per-seat silence-window-seconds passes through
  // ResolvedNodeConfig.activity for the rigspec-instantiator to plumb
  // into NodeLauncher.launchNode. Verifies the carry-through; the
  // launch-call site is exercised by node-launcher tests.
  describe("slice 15 — profile.activity carries into ResolvedNodeConfig", () => {
    it("ResolvedNodeConfig.activity.silenceWindowSeconds reflects profile.activity when set", () => {
      const ctx = makeCtx({
        baseSpec: makeResolved(makeSpec({
          profiles: {
            default: {
              activity: { silenceWindowSeconds: 9 },
              uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
            },
          },
        })),
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.activity?.silenceWindowSeconds).toBe(9);
      }
    });

    it("ResolvedNodeConfig.activity is undefined when the profile does not declare one", () => {
      const result = resolveNodeConfig(makeCtx());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.activity).toBeUndefined();
      }
    });
  });
});

// ─── OPR.0.5.6.20 P3 — compactionStrategy resolution, most-specific-WINS ────────
// RED-FIRST at base: no compactionStrategy resolution exists; ResolvedNodeConfig
// carries no such field. Layering is override-wins (spec default < profile <
// member) — deliberately NOT restore_policy's narrowing lattice: the four modes
// are unordered (desk-concurred planner call, disclosed on baton bd7eef84).

describe("compactionStrategy resolution — most-specific-wins (OPR.0.5.6.20)", () => {
  const specLifecycle = (compactionStrategy: string) => makeSpec({
    defaults: {
      runtime: "claude-code",
      lifecycle: { executionMode: "interactive_resident", compactionStrategy, restorePolicy: "resume_if_possible" },
    },
  } as Partial<AgentSpec>);

  it("member overrides profile overrides spec default (two-level fixture; RED: field absent from config)", () => {
    const spec = specLifecycle("default-compaction");
    spec.profiles["default"].lifecycle = { compactionStrategy: "managed-compaction" } as never;
    const bare = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.config.compactionStrategy).toBe("managed-compaction");
    const overridden = resolveNodeConfig(makeCtx({
      baseSpec: makeResolved(spec),
      member: makeMember({ compactionStrategy: "apprentice-handover" } as never),
    }));
    expect(overridden.ok).toBe(true);
    if (overridden.ok) expect(overridden.config.compactionStrategy).toBe("apprentice-handover");
  });

  it("absent everywhere resolves to default-compaction (RED: field absent)", () => {
    const result = resolveNodeConfig(makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("default-compaction");
  });

  it("an invalid value at any level errors naming the level (restore-policy error style; RED: silently ignored)", () => {
    const result = resolveNodeConfig(makeCtx({
      member: makeMember({ compactionStrategy: "bogus" } as never),
    }));
    expect(result.ok).toBe(false);
  });

  it("a deprecated alias at the member level resolves to its canonical value (harness_native → default-compaction; RED: unrecognized)", () => {
    const result = resolveNodeConfig(makeCtx({
      member: makeMember({ compactionStrategy: "harness_native" } as never),
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("default-compaction");
  });
});

// ─── OPR.0.5.6.20 B-3 — a non-specifying level must not participate ────────────
// RED-FIRST over fad5e26c0 (R1 HOLD finding, real-ingress mixed fixture): the
// normalization hop materializes default-compaction into a profile lifecycle
// block that omits compaction_strategy, and the resolver's truthy check then
// lets that non-specifying profile defeat an explicit spec-level strategy —
// the flagship advisor shape silently loses its continuity policy.
describe("compactionStrategy precedence — non-specifying level does not participate (OPR.0.5.6.20 B-3)", () => {
  it("spec-level strategy survives a profile lifecycle block that omits compaction_strategy (real ingress: yaml -> normalize -> resolve)", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: b3-fixture
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
profiles:
  default:
    lifecycle:
      execution_mode: interactive_resident
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("apprentice-handover");
  });

  it("F-6 floor unchanged: absent at every level still resolves to default-compaction through the same real ingress (green at base, floor pin)", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: b3-floor-fixture
defaults:
  runtime: claude-code
profiles:
  default:
    lifecycle:
      execution_mode: interactive_resident
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("default-compaction");
  });
});

// ─── OPR.0.5.6.20 B-4 — omitted restore_policy must not participate either ─────
// RED-FIRST over f35214f55 (R2 HOLD finding, same class as B-3 on the sibling
// field): normalizeLifecycle materializes restorePolicy resume_if_possible into a
// profile lifecycle block that omits restore_policy, and the narrowing resolver
// rejects the synthesized value as an invented broadening — a user cannot select
// the profile-level continuity mode without redundantly repeating an unrelated
// restore policy. Pre-dates S20 but lies on the candidate's central product path.
describe("restorePolicy precedence — non-specifying level does not participate (OPR.0.5.6.20 B-4)", () => {
  it("profile specifying only compaction_strategy neither breaks nor broadens the spec restore policy (real ingress; both outputs proven together)", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: b4-fixture
defaults:
  runtime: claude-code
  lifecycle:
    restore_policy: checkpoint_only
profiles:
  default:
    lifecycle:
      compaction_strategy: apprentice-handover
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.compactionStrategy).toBe("apprentice-handover");
      expect(result.config.restorePolicy).toBe("checkpoint_only");
    }
  });
});

describe("continuity mechanic precedence — shipped three-level path (S20 A8)", () => {
  it("resolves spec-default < profile < member through real AgentSpec ingress", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: mechanic-precedence
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
    mechanic: default-mechanic@default-rig
profiles:
  default:
    lifecycle:
      mechanic: profile-mechanic@profile-rig
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({
      baseSpec: makeResolved(spec),
      member: makeMember({ mechanic: "member-mechanic@member-rig" } as never),
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.config as unknown as { mechanic?: string }).mechanic).toBe(
        "member-mechanic@member-rig",
      );
      expect(result.config.compactionStrategy).toBe("apprentice-handover");
    }
  });

  it("preserves absence instead of inventing a default mechanic", () => {
    const result = resolveNodeConfig(makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.config as unknown as { mechanic?: string }).mechanic).toBeUndefined();
    }
  });
});

describe("managed catalog selection composition", () => {
  it("adds system and project skills around a topology-only profile without rebuilding the topology", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-profile-skill-catalog-"));
    try {
      const catalog = join(root, "skills");
      const project = join(root, "project");
      mkdirSync(catalog, { recursive: true });
      mkdirSync(project, { recursive: true });
      execFileSync("git", ["-C", root, "init", "-q"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
      writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: [system-skill]\n");
      for (const id of ["system-skill", "topology-skill", "project-skill"]) {
        mkdirSync(join(catalog, id));
        writeFileSync(join(catalog, id, "SKILL.md"), `---\nname: ${id}\ndescription: Use when testing ${id}.\n---\n\n# ${id}\n`);
      }
      writeFileSync(join(project, "project.yaml"), "install:\n  skills: [project-skill]\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);

      const spec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["topology-skill"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
        },
      });
      const result = resolveNodeConfig(makeCtx({
        baseSpec: makeResolved(spec, root),
        member: makeMember({ cwd: project, runtime: "codex" }),
        skillsRoot: catalog,
        systemSkills: ["system-skill"],
        homedir: join(root, "home"),
      }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.selectedResources.skills.map((skill) => skill.effectiveId)).toEqual([
        "project-skill",
        "system-skill",
        "topology-skill",
      ]);
      expect(result.config.skillLoadout?.entries.map((skill) => [skill.id, skill.selectedBy])).toEqual([
        ["project-skill", ["project"]],
        ["system-skill", ["system"]],
        ["topology-skill", ["topology"]],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a topology source whose identity matches the catalog but whose bytes do not", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-profile-skill-conflict-"));
    try {
      const catalog = join(root, "skills");
      const local = join(root, "local-skill");
      mkdirSync(join(catalog, "shared"), { recursive: true });
      mkdirSync(local, { recursive: true });
      execFileSync("git", ["-C", root, "init", "-q"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
      writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      writeFileSync(join(catalog, "shared", "SKILL.md"), "---\nname: shared\ndescription: Use when catalog content is needed.\n---\n\n# catalog\n");
      writeFileSync(join(local, "SKILL.md"), "---\nname: shared\ndescription: Use when local content is needed.\n---\n\n# local\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);

      const spec = makeSpec({
        resources: { skills: [{ id: "shared", path: local }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["shared"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
        },
      });
      const result = resolveNodeConfig(makeCtx({
        baseSpec: makeResolved(spec, root),
        skillsRoot: catalog,
        homedir: join(root, "home"),
      }));

      expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("skill_identity_conflict")] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
