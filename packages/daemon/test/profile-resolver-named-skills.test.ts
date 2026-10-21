// #1653: a profile names the skills it uses, so resolving a member reads only those skills' SKILL.md, not every skill
// on the machine. A user skill folder holding tens of thousands of skills used to be read in full once per member,
// which froze the daemon's event loop for the whole plan or launch.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    reads.push(String(path));
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import type { AgentSpec, RigSpecPodMember, SkillResource } from "../src/domain/types.js";

function makeSpec(uses: string[], local: SkillResource[] = []): AgentSpec {
  return {
    version: "1.0.0",
    name: "test-agent",
    imports: [],
    startup: { files: [{ path: "startup/base.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    resources: { skills: local, guidance: [], subagents: [], plugins: [], runtimeResources: [] },
    profiles: { default: { uses: { skills: uses, guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
  };
}

function makeCtx(spec: AgentSpec, member: Partial<RigSpecPodMember>, homedir: string): ResolutionContext {
  const m = { id: "impl", agentRef: "local:agents/test", profile: "default", runtime: "claude-code", cwd: ".", ...member } as RigSpecPodMember;
  const pod = { id: "dev", label: "Dev", members: [m], edges: [] };
  return {
    baseSpec: { spec, sourcePath: "/agents/test", hash: "abc123" },
    importedSpecs: [],
    collisions: [],
    profileName: "default",
    member: m,
    pod,
    rig: { version: "0.2", name: "test-rig", pods: [pod], edges: [] },
    homedir,
  };
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody.\n`);
}

function withHome<T>(fn: (home: string, cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "named-skills-"));
  const home = join(root, "home");
  const cwd = join(root, "rig-cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  try { return fn(home, cwd); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("resolving a member reads only the skills its profile names", () => {
  beforeEach(() => { reads.length = 0; });

  it.each([
    ["claude-code", ".claude"],
    ["codex", ".agents"],
  ])("a %s member reads one SKILL.md from a user folder holding many skills", (runtime, dir) => {
    withHome((home, cwd) => {
      const userRoot = join(home, dir, "skills");
      for (let i = 0; i < 40; i++) writeSkill(join(userRoot, `skill-${String(i).padStart(2, "0")}`), `skill-${String(i).padStart(2, "0")}`);
      reads.length = 0;
      const result = resolveNodeConfig(makeCtx(makeSpec(["skill-07"]), { cwd, runtime }, home));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.selectedResources.skills.find((s) => s.effectiveId === "skill-07")?.sourcePath).toBe(join(userRoot, "skill-07"));
      }
      expect(reads.filter((p) => p.startsWith(userRoot))).toEqual([join(userRoot, "skill-07", "SKILL.md")]);
    });
  });

  it("reads no discovered SKILL.md when the spec itself declares every selected skill", () => {
    withHome((home, cwd) => {
      const userRoot = join(home, ".claude", "skills");
      for (let i = 0; i < 40; i++) writeSkill(join(userRoot, `skill-${i}`), `skill-${i}`);
      reads.length = 0;
      const result = resolveNodeConfig(makeCtx(makeSpec(["skill-a"], [{ id: "skill-a", path: "skills/a" }]), { cwd }, home));
      expect(result.ok).toBe(true);
      expect(reads.filter((p) => p.startsWith(userRoot))).toEqual([]);
    });
  });

  it("the most specific folder still wins: the rig's own skill outranks the user's same-named one", () => {
    withHome((home, cwd) => {
      writeSkill(join(cwd, ".claude", "skills", "shared"), "shared");
      writeSkill(join(home, ".claude", "skills", "shared"), "shared");
      const result = resolveNodeConfig(makeCtx(makeSpec(["shared"]), { cwd }, home));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.selectedResources.skills.find((s) => s.effectiveId === "shared")?.sourcePath).toBe(join(cwd, ".claude", "skills", "shared"));
      }
    });
  });

  it("a skill whose folder is named differently from the skill still resolves", () => {
    withHome((home, cwd) => {
      writeSkill(join(home, ".claude", "skills", "some-folder"), "renamed-skill");
      const result = resolveNodeConfig(makeCtx(makeSpec(["renamed-skill"]), { cwd }, home));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.selectedResources.skills.find((s) => s.effectiveId === "renamed-skill")?.sourcePath).toBe(join(home, ".claude", "skills", "some-folder"));
      }
    });
  });
});
