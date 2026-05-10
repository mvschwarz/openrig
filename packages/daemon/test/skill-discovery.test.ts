// V0.3.0 daemon-skill-discovery — TDD-first contract for the skill
// discovery module that gives the profile resolver a runtime-truth
// view of skills present at user-library / rig-bundled paths.
//
// Skill discovery scans 5 path classes per the effective spec
// (status.md 2026-05-10):
//   1. ~/.openrig/skills/                                     (per-runtime user-spec library)
//   2. ~/.claude/skills/                                      (Claude-runtime user library)
//   3. ~/.agents/skills/                                      (Codex-runtime user library)
//   4. <cwd>/.claude/skills/<name>/ + <cwd>/.agents/skills/<name>/   (rig-bundled at cwd)
//   5. <spec-install-dir>/skills/<name>/                      (rig-spec install dir)
//
// Per-runtime filtering: claude-code targets Claude paths;
// codex targets Codex paths; ~/.openrig/skills/ is shared.
//
// Per-skill structural validation: parse SKILL.md frontmatter; require
// `name` + `description` fields; reject the rest as "not actually a
// skill that Claude Code or Codex will load."

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverSkillsForRuntime,
  parseSkillFrontmatter,
  type SkillDiscoveryPaths,
} from "../src/domain/skill-discovery.js";

let tmpRoot: string;
let homedir: string;
let cwd: string;
let specInstallDir: string;

function writeSkill(dir: string, frontmatter: Record<string, string>, body: string = "Body content."): void {
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fm}\n---\n\n${body}\n`;
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "skill-discovery-"));
  homedir = join(tmpRoot, "home");
  cwd = join(tmpRoot, "rig-cwd");
  specInstallDir = join(tmpRoot, "spec-install");
  mkdirSync(homedir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(specInstallDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function pathsFor(runtime: "claude-code" | "codex"): SkillDiscoveryPaths {
  return { runtime, homedir, cwd, specInstallDir };
}

describe("parseSkillFrontmatter — structural validation", () => {
  it("accepts a SKILL.md with name + description + body and returns the parsed frontmatter", () => {
    const content = "---\nname: my-skill\ndescription: Does a thing.\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter.name).toBe("my-skill");
      expect(result.frontmatter.description).toBe("Does a thing.");
    }
  });

  it("rejects a file with no frontmatter as structurally invalid", () => {
    const content = "Just a regular markdown file.\n\nNo frontmatter at all.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
  });

  it("rejects a SKILL.md missing the `name` field", () => {
    const content = "---\ndescription: Does a thing.\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/name/);
  });

  it("rejects a SKILL.md missing the `description` field", () => {
    const content = "---\nname: my-skill\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/description/);
  });

  it("rejects a SKILL.md with empty body (the runtime would have nothing to load)", () => {
    const content = "---\nname: my-skill\ndescription: Does a thing.\n---\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/body/i);
  });

  it("rejects a malformed YAML frontmatter block as structurally invalid", () => {
    const content = "---\nname: [broken\ndescription: Does a thing.\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
  });
});

describe("discoverSkillsForRuntime — Claude-runtime path scanning", () => {
  it("discovers a skill from ~/.claude/skills/<name>/", () => {
    writeSkill(join(homedir, ".claude/skills/openrig-architect"), {
      name: "openrig-architect",
      description: "Architect rigs",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("openrig-architect");
  });

  it("discovers a skill from ~/.openrig/skills/<name>/ (shared user-spec library)", () => {
    writeSkill(join(homedir, ".openrig/skills/alignment-trace"), {
      name: "alignment-trace",
      description: "Trace alignment",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("alignment-trace");
  });

  it("discovers a skill from rig-bundled <cwd>/.claude/skills/<name>/", () => {
    writeSkill(join(cwd, ".claude/skills/web-design-guidelines"), {
      name: "web-design-guidelines",
      description: "Web design checks",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("web-design-guidelines");
  });

  it("discovers a skill from <spec-install-dir>/skills/<name>/", () => {
    writeSkill(join(specInstallDir, "skills/remotion-best-practices"), {
      name: "remotion-best-practices",
      description: "Remotion patterns",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("remotion-best-practices");
  });

  it("does NOT scan ~/.agents/skills/ for the claude-code runtime", () => {
    writeSkill(join(homedir, ".agents/skills/codex-only"), {
      name: "codex-only",
      description: "Codex thing",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("codex-only");
  });
});

describe("discoverSkillsForRuntime — Codex-runtime path scanning", () => {
  it("discovers a skill from ~/.agents/skills/<name>/", () => {
    writeSkill(join(homedir, ".agents/skills/openrig-architect"), {
      name: "openrig-architect",
      description: "Architect rigs",
    });
    const result = discoverSkillsForRuntime(pathsFor("codex"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("openrig-architect");
  });

  it("discovers a skill from rig-bundled <cwd>/.agents/skills/<name>/", () => {
    writeSkill(join(cwd, ".agents/skills/alignment-trace"), {
      name: "alignment-trace",
      description: "Trace alignment",
    });
    const result = discoverSkillsForRuntime(pathsFor("codex"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("alignment-trace");
  });

  it("does NOT scan ~/.claude/skills/ for the codex runtime", () => {
    writeSkill(join(homedir, ".claude/skills/claude-only"), {
      name: "claude-only",
      description: "Claude thing",
    });
    const result = discoverSkillsForRuntime(pathsFor("codex"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("claude-only");
  });
});

describe("discoverSkillsForRuntime — structural rejection at scan time", () => {
  it("skips a directory with no SKILL.md (not a skill)", () => {
    mkdirSync(join(homedir, ".claude/skills/junk-dir"), { recursive: true });
    writeFileSync(join(homedir, ".claude/skills/junk-dir/README.md"), "Not a skill.", "utf-8");
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("junk-dir");
  });

  it("skips a SKILL.md that fails frontmatter validation and surfaces a structured rejection", () => {
    const dir = join(homedir, ".claude/skills/broken-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter\n", "utf-8");
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("broken-skill");
    expect(result.rejected.some((r) => r.path.includes("broken-skill"))).toBe(true);
  });
});

describe("discoverSkillsForRuntime — SkillResource shape", () => {
  it("returns each discovered skill as { id, path } with id from frontmatter and path pointing at the skill directory", () => {
    writeSkill(join(homedir, ".claude/skills/openrig-architect"), {
      name: "openrig-architect",
      description: "Architect rigs",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const found = result.skills.find((s) => s.id === "openrig-architect");
    expect(found).toBeDefined();
    expect(found!.path).toBe(join(homedir, ".claude/skills/openrig-architect"));
  });

  it("is robust to missing top-level scan directories (returns an empty list, not a throw)", () => {
    // homedir + cwd + specInstallDir all exist but the .claude/skills /
    // .agents/skills / .openrig/skills / skills subdirs don't.
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    expect(result.skills).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});
