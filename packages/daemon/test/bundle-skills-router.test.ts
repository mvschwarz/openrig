import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { routeSkills, type SkillsRouterFsOps, type RouteSkillsInput } from "../src/domain/bundle-skills-router.js";

// Item 6 / slice-05 Checkpoint 7.2: bundle-skills-router pure-function tests.

function mockFs(initialFiles: Record<string, string> = {}): SkillsRouterFsOps & { _written: Map<string, string>; _mkdirpCalls: string[] } {
  const written = new Map<string, string>(Object.entries(initialFiles));
  const mkdirpCalls: string[] = [];
  return {
    _written: written,
    _mkdirpCalls: mkdirpCalls,
    exists: (p: string) => written.has(p),
    readFile: (p: string) => {
      const v = written.get(p);
      if (v === undefined) throw new Error(`File not found in mock: ${p}`);
      return v;
    },
    writeFile: (p: string, c: string) => { written.set(p, c); },
    mkdirp: (p: string) => { mkdirpCalls.push(p); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/skills";

function makeInput(overrides?: Partial<RouteSkillsInput>): RouteSkillsInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredSkills: [],
    targetSkillsDir: TARGET,
    ...overrides,
  };
}

describe("routeSkills", () => {
  // R1: empty skills list → empty records + target dir mkdirp'd
  it("empty declaredSkills produces empty records but still mkdirp's target", () => {
    const fs = mockFs();
    const result = routeSkills(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // R2: routes one skill end-to-end
  it("routes one skill: source file copied to target with installedAt populated", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/skills/foo/SKILL.md`]: "# foo skill body",
    });
    const result = routeSkills(makeInput({ declaredSkills: ["skills/foo/SKILL.md"] }), fs);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/foo/SKILL.md`);
    expect(fs._written.get(`${TARGET}/foo/SKILL.md`)).toBe("# foo skill body");
  });

  // R3: routes multiple skills; preserves directory layout
  it("routes multiple skills preserving the per-skill directory layout under target", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/skills/foo/SKILL.md`]: "foo",
      [`${BUNDLE_ROOT}/skills/bar/SKILL.md`]: "bar",
      [`${BUNDLE_ROOT}/skills/bar/helper.md`]: "bar-helper",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/foo/SKILL.md", "skills/bar/SKILL.md", "skills/bar/helper.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(3);
    expect(fs._written.get(`${TARGET}/foo/SKILL.md`)).toBe("foo");
    expect(fs._written.get(`${TARGET}/bar/SKILL.md`)).toBe("bar");
    expect(fs._written.get(`${TARGET}/bar/helper.md`)).toBe("bar-helper");
  });

  // R4: missing source file produces "missing" record (skipped, not error)
  it("missing source file is skipped with status=missing (honest-scoping)", () => {
    const fs = mockFs(); // empty — no skill files
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/absent/SKILL.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("not present");
  });

  // R5: unsafe path escaping bundle workspace is rejected
  it("unsafe declared path (../traversal) escapes bundle workspace and is rejected", () => {
    const fs = mockFs();
    const result = routeSkills(
      makeInput({ declaredSkills: ["../escape/SKILL.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes bundle workspace");
  });

  // R6: mixed list — routed + missing + unsafe in one call
  it("mixed declared list aggregates correctly across routed/missing/unsafe", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/skills/ok/SKILL.md`]: "ok",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/ok/SKILL.md", "skills/absent/SKILL.md", "../escape/SKILL.md"] }),
      fs,
    );
    expect(result.records).toHaveLength(3);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(2);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
  });

  // R7-B1: target-side path containment (B1 repair on
  // qitem-20260518215234-f84fff45). Declared path "skills/../outside/SKILL.md"
  // passes SOURCE containment (resolves under bundleRoot since the leading
  // "skills/" segment is consumed before ../) but after the leading "skills/"
  // strip becomes "../outside/SKILL.md" which would escape targetSkillsDir.
  // Must be rejected.
  it("declared path that would escape target skills dir after prefix strip is rejected", () => {
    // Source file exists under bundleRoot (passes source containment) but the
    // resolved target after strip escapes target dir.
    const fs = mockFs({
      // Source is reachable from bundleRoot via "skills/../outside/SKILL.md"
      // which resolves to "<bundleRoot>/outside/SKILL.md".
      [`${BUNDLE_ROOT}/outside/SKILL.md`]: "would-escape-target",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["skills/../outside/SKILL.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes target skills library");
    // Crucially: no write happened outside target.
    expect(fs._written.has(`${TARGET}/../outside/SKILL.md`)).toBe(false);
    expect(fs._written.has(nodePath.resolve(`${TARGET}/../outside/SKILL.md`))).toBe(false);
  });

  // R8: non-"skills/" prefixed declared path is honored as-is (no leading strip)
  it("declared path without leading skills/ prefix routes verbatim", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/custom/path/X.md`]: "x",
    });
    const result = routeSkills(
      makeInput({ declaredSkills: ["custom/path/X.md"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/custom/path/X.md`);
  });
});
