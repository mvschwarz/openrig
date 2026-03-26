import { describe, it, expect, vi } from "vitest";
import { SessionEnricher } from "../src/domain/session-enricher.js";

function mockFs(structure: Record<string, string[] | true>): { fsExists: (p: string) => boolean; fsReaddir: (p: string) => string[] } {
  return {
    fsExists: (p: string) => p in structure,
    fsReaddir: (p: string) => {
      const val = structure[p];
      if (Array.isArray(val)) return val;
      throw new Error(`not a directory: ${p}`);
    },
  };
}

describe("SessionEnricher", () => {
  // T1: .claude/skills/ -> lists skill directory names
  it("lists skill names from .claude/skills/", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/.claude/skills": ["helper", "reviewer"],
    }));

    const result = enricher.enrich("/projects");

    expect(result.claudeSkills).toEqual(["helper", "reviewer"]);
    expect(result.skills).toContain("helper");
    expect(result.skills).toContain("reviewer");
  });

  // T2: .agents/skills/ -> lists skill directory names
  it("lists skill names from .agents/skills/", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/.agents/skills": ["codex-tool"],
    }));

    const result = enricher.enrich("/projects");

    expect(result.agentsSkills).toEqual(["codex-tool"]);
    expect(result.skills).toContain("codex-tool");
  });

  // T3: CLAUDE.md -> hasClaudeMd=true
  it("detects CLAUDE.md presence", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/CLAUDE.md": true,
    }));

    const result = enricher.enrich("/projects");

    expect(result.hasClaudeMd).toBe(true);
    expect(result.hasAgentsMd).toBe(false);
  });

  // T4: no agent config -> all empty/false
  it("returns empty result when no agent config exists", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
    }));

    const result = enricher.enrich("/projects");

    expect(result.skills).toEqual([]);
    expect(result.hasClaudeMd).toBe(false);
    expect(result.hasAgentsMd).toBe(false);
    expect(result.hasPackageYaml).toBe(false);
  });

  // T5: null cwd -> graceful empty result
  it("null cwd returns empty result", () => {
    const enricher = new SessionEnricher(mockFs({}));

    const result = enricher.enrich(null);

    expect(result.skills).toEqual([]);
    expect(result.hasClaudeMd).toBe(false);
  });

  // T6: asset-rich fixture -> all fields including merged skills, AGENTS.md, package.yaml
  it("asset-rich cwd returns all fields correctly", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/.claude/skills": ["skill-a", "skill-b"],
      "/projects/.agents/skills": ["skill-c"],
      "/projects/CLAUDE.md": true,
      "/projects/AGENTS.md": true,
      "/projects/package.yaml": true,
    }));

    const result = enricher.enrich("/projects");

    expect(result.claudeSkills).toEqual(["skill-a", "skill-b"]);
    expect(result.agentsSkills).toEqual(["skill-c"]);
    expect(result.skills).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(result.hasClaudeMd).toBe(true);
    expect(result.hasAgentsMd).toBe(true);
    expect(result.hasPackageYaml).toBe(true);
    expect(result.raw).toEqual({
      hasClaudeMd: true,
      hasAgentsMd: true,
      hasPackageYaml: true,
      claudeSkills: ["skill-a", "skill-b"],
      agentsSkills: ["skill-c"],
      skills: ["skill-a", "skill-b", "skill-c"],
    });
  });

  // T7: nonexistent cwd path -> empty result
  it("nonexistent cwd returns empty result", () => {
    const enricher = new SessionEnricher(mockFs({}));

    const result = enricher.enrich("/nonexistent/path");

    expect(result.skills).toEqual([]);
    expect(result.hasClaudeMd).toBe(false);
  });

  // T8: fsReaddir throws -> graceful empty skills
  it("fsReaddir error returns empty skills without propagating", () => {
    const enricher = new SessionEnricher({
      fsExists: (p) => p === "/projects" || p === "/projects/.claude/skills",
      fsReaddir: vi.fn(() => { throw new Error("EACCES: permission denied"); }),
    });

    const result = enricher.enrich("/projects");

    expect(result.claudeSkills).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});
