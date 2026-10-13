import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSkills, listBundledSkillSources, type SkillAuditEntry } from "../src/domain/skill-audit.js";
import type { SkillProvenanceEntry, SkillFrontmatter } from "../src/domain/skill-discovery.js";

function makeEntry(overrides: Partial<SkillProvenanceEntry> & { fmOverrides?: Record<string, unknown> }): SkillProvenanceEntry {
  const { fmOverrides, ...rest } = overrides;
  const baseFm: Record<string, unknown> = {
    name: rest.id ?? "test-skill",
    description: "A test skill",
    ...fmOverrides,
  };
  return {
    id: "test-skill",
    path: "/tmp/skills/test-skill",
    sourceRoot: "/tmp/skills",
    sourceKind: "rig_bundled",
    frontmatter: baseFm as SkillFrontmatter,
    body: "",
    shadowed: false,
    ...rest,
  };
}

describe("skill-audit", () => {
  // Freshness fixtures use a fixed observation date, not the day CI runs.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-20T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  // 4-FIXTURE VERIFIED MATRIX (PRD + guard discriminator)

  it("(a) CLEAN: date + real evidence source passes", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "practical-passed-2026-06-15 against runtime tests",
            owner: "openrig-delivery",
            source_ref: "v0.4.0",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("verified");
    expect(result!.findings.filter((f) => f.class.includes("verified"))).toHaveLength(0);
    expect(result!.state).toBe("active");
  });

  it("(b) DATE-ONLY: last_verified with no evidence source fails as bare_verified", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
    expect(result!.state).toBe("stale");
  });

  it("(b) pointing at own SKILL.md filepath does NOT make bare date pass", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
  });

  it("(b) source_evidence equal to own SKILL.md path fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "/tmp/skills/test-skill/SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
  });

  it("(b) source_evidence with .. normalization to own path fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "/tmp/skills/test-skill/../test-skill/SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence = skill directory with trailing slash fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "/tmp/skills/test-skill/",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) top-level verified against normalized self path fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        verified: "2026-06-15 against /tmp/skills/test-skill/../test-skill/SKILL.md",
        metadata: { openrig: { owner: "test", source_ref: "v1" } },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence ./test-skill/SKILL.md (relative to root) fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "./test-skill/SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence test-skill/ (relative dir to root) fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "test-skill/",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) top-level verified against ./test-skill/SKILL.md fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        verified: "2026-06-15 against ./test-skill/SKILL.md",
        metadata: { openrig: { owner: "test", source_ref: "v1" } },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence 'SKILL.md' (bare filename) fails as bare_verified", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(c) NO-DATE: no verified date fails as missing_verified", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("missing_verified");
    expect(result!.findings.some((f) => f.class === "missing_verified")).toBe(true);
  });

  it("(d) STALE: date + source but past freshness window fails as stale_verified", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2025-01-01",
            source_evidence: "practical-passed-2025-01-01",
            owner: "openrig-delivery",
            source_ref: "v0.1.0",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("stale_verified");
    expect(result!.findings.some((f) => f.class === "stale_verified")).toBe(true);
    expect(result!.state).toBe("stale");
  });

  // EXEMPT AXIS
  it("exempt skill (status: historical-reference) has no findings", () => {
    const entry = makeEntry({
      fmOverrides: {
        status: "historical-reference",
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.state).toBe("exempt");
    expect(result!.findings).toHaveLength(0);
  });

  // SHADOWED NOT FLAGGED
  it("shadowed skill has no findings (not active)", () => {
    const entry = makeEntry({
      shadowed: true,
      fmOverrides: {
        metadata: { openrig: { stage: "factory-approved" } },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.findings).toHaveLength(0);
  });

  // MISSING PROVENANCE
  it("missing owner and source_ref flagged as missing_provenance", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "verified against tests",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    const provFindings = result!.findings.filter((f) => f.class === "missing_provenance");
    expect(provFindings.length).toBeGreaterThanOrEqual(2);
  });

  // TOP-LEVEL VERIFIED FORMAT
  it("top-level verified: <date> against <source> parses correctly", () => {
    const entry = makeEntry({
      fmOverrides: {
        verified: "2026-06-10 against runtime integration tests",
        metadata: {
          openrig: {
            owner: "openrig-delivery",
            source_ref: "v0.4.0",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("verified");
    if (result!.verified.status === "verified") {
      expect(result!.verified.date).toBe("2026-06-10");
      expect(result!.verified.source).toBe("runtime integration tests");
    }
  });

  // READ-ONLY INVARIANT (structural -- audit never mutates)
  it("auditSkills returns entries without side effects", () => {
    const entries = [
      makeEntry({ id: "skill-a", fmOverrides: { metadata: { openrig: { stage: "factory-approved" } } } }),
      makeEntry({ id: "skill-b", fmOverrides: { metadata: { openrig: { stage: "factory-approved", last_verified: "2026-06-15", source_evidence: "test" } } } }),
    ];

    const { entries: results } = auditSkills(entries);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("skill-a");
    expect(results[1]!.id).toBe("skill-b");
  });

  // B1 REGRESSION: mirror drift findings emitted from checkMode result
  it("mirror drift findings emitted when mirrorDrift.stale is true", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: { openrig: { stage: "factory-approved", last_verified: "2026-06-15", source_evidence: "test", owner: "test", source_ref: "v1" } },
      },
    });

    const { mirrorDriftFindings } = auditSkills([entry], {
      mirrorDrift: { stale: true, changes: ["skills/_canonical/openrig-user/SKILL.md", "skills/_canonical/openrig-builder/SKILL.md"] },
    });

    expect(mirrorDriftFindings).toHaveLength(2);
    expect(mirrorDriftFindings[0]!.class).toBe("mirror_drift");
    expect(mirrorDriftFindings[0]!.file).toContain("openrig-user");
  });

  it("no mirror drift findings when mirrorDrift.stale is false", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: { openrig: { stage: "factory-approved", last_verified: "2026-06-15", source_evidence: "test", owner: "test", source_ref: "v1" } },
      },
    });

    const { mirrorDriftFindings } = auditSkills([entry], { mirrorDrift: { stale: false, changes: [] } });
    expect(mirrorDriftFindings).toHaveLength(0);
  });

  // B3 REGRESSION: legacy banner in body (not frontmatter) exempts the skill
  it("legacy banner in body exempts the skill", () => {
    const entry = makeEntry({
      fmOverrides: {},
    });
    (entry as { body: string }).body = "> **legacy** — this skill is historical.\n\nSome content.";

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.state).toBe("exempt");
    expect(result!.findings).toHaveLength(0);
  });

  // REV1 REGRESSION: invalid last_verified date with real source -> bare_verified, not verified
  it("invalid last_verified date (non-date string) fails as bare_verified", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "not-a-date",
            source_evidence: "runtime integration tests",
            owner: "test",
            source_ref: "v1",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
  });

  // REV1 REGRESSION: array-valued sourced_from with only self paths -> bare_verified
  it("array sourced_from with only self-referential paths fails as bare_verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            sourced_from: ["/tmp/skills/test-skill/SKILL.md", "./test-skill/SKILL.md"],
            owner: "test",
            source_ref: "v1",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  // REV1: array sourced_from with at least one real non-self source -> verified
  it("array sourced_from with one real source passes as verified", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            sourced_from: ["/tmp/skills/test-skill/SKILL.md", "runtime integration tests"],
            owner: "test",
            source_ref: "v1",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("verified");
  });
});

// #802 (a): a projected copy of a skill an installed plugin ships has known provenance (the plugin and its
// version, verified by that release) while its bytes match the plugin's. An edited copy is audited as before.
describe("skill-audit — bundled plugin skills", () => {
  const SKILL = "---\nname: openrig-skills\ndescription: index\nmetadata:\n  openrig:\n    stage: shipped\n---\n\n# index\n";
  let root: string;
  let pluginsDir: string;
  let projected: string;

  function writePlugin(files: Record<string, string>, version = "0.1.4"): void {
    const plugin = join(pluginsDir, "openrig-core");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "openrig-core", version }));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(plugin, "skills/openrig-skills", rel, ".."), { recursive: true });
      writeFileSync(join(plugin, "skills/openrig-skills", rel), content);
    }
  }

  function writeProjected(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(projected, rel, ".."), { recursive: true });
      writeFileSync(join(projected, rel), content);
    }
  }

  function projectedEntry(): SkillProvenanceEntry {
    return makeEntry({
      id: "openrig-skills",
      path: projected,
      sourceRoot: join(root, "home/.claude/skills"),
      sourceKind: "runtime_user",
      fmOverrides: { metadata: { openrig: { stage: "shipped" } } },
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-audit-bundled-"));
    pluginsDir = join(root, "openrig-home/plugins");
    projected = join(root, "home/.claude/skills/openrig-skills");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

  it("a byte-identical projected copy has the plugin's provenance and no findings", () => {
    writePlugin({ "SKILL.md": SKILL });
    // The projection adds its own version marker beside the plugin's files.
    writeProjected({ "SKILL.md": SKILL, ".openrig-vendor-version": "0.1.4\n" });

    const { entries: [result] } = auditSkills([projectedEntry()], { bundledSources: listBundledSkillSources(pluginsDir) });
    expect(result!.findings).toEqual([]);
    expect(result!.bundledFrom).toEqual({ plugin: "openrig-core", version: "0.1.4" });
    expect(result!.owner).toBe("openrig-core");
    expect(result!.sourceRef).toBe("openrig-core@0.1.4");
    expect(result!.verified).toEqual({ status: "bundled", plugin: "openrig-core", version: "0.1.4" });
    expect(result!.state).toBe("active");
  });

  it("does not expire: the same copy is still clean years later", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    writePlugin({ "SKILL.md": SKILL });
    writeProjected({ "SKILL.md": SKILL });

    const { entries: [result] } = auditSkills([projectedEntry()], { bundledSources: listBundledSkillSources(pluginsDir) });
    expect(result!.findings).toEqual([]);
  });

  it("an edited copy is audited like any other skill", () => {
    writePlugin({ "SKILL.md": SKILL });
    writeProjected({ "SKILL.md": SKILL + "\nLocal note.\n" });

    const { entries: [result] } = auditSkills([projectedEntry()], { bundledSources: listBundledSkillSources(pluginsDir) });
    expect(result!.bundledFrom).toBeNull();
    expect(result!.findings.map((f) => f.class).sort()).toEqual(["missing_provenance", "missing_provenance", "missing_verified"]);
  });

  it("a copy missing a file the plugin ships is audited like any other skill", () => {
    writePlugin({ "SKILL.md": SKILL, "scripts/helper.mjs": "export {};\n" });
    writeProjected({ "SKILL.md": SKILL });

    const { entries: [result] } = auditSkills([projectedEntry()], { bundledSources: listBundledSkillSources(pluginsDir) });
    expect(result!.bundledFrom).toBeNull();
    expect(result!.findings).toHaveLength(3);
  });

  it("a copy with a file added locally is audited like any other skill", () => {
    writePlugin({ "SKILL.md": SKILL });
    writeProjected({ "SKILL.md": SKILL, ".openrig-vendor-version": "0.1.4\n", "references/local.md": "# local\n" });

    const { entries: [result] } = auditSkills([projectedEntry()], { bundledSources: listBundledSkillSources(pluginsDir) });
    expect(result!.bundledFrom).toBeNull();
    expect(result!.findings).toHaveLength(3);
  });

  it("a copy holding self-referencing directory symlinks completes and is audited like any other skill", () => {
    writePlugin({ "SKILL.md": SKILL });
    writeProjected({ "SKILL.md": SKILL, ".openrig-vendor-version": "0.1.4\n" });
    symlinkSync(".", join(projected, "a"));
    symlinkSync(".", join(projected, "b"));

    const { entries: [result] } = auditSkills([projectedEntry()], { bundledSources: listBundledSkillSources(pluginsDir) });
    expect(result!.bundledFrom).toBeNull();
    expect(result!.findings).toHaveLength(3);
  });

  it("a copy that is itself a symlink to the plugin's skill directory still counts as bundled", () => {
    writePlugin({ "SKILL.md": SKILL });
    mkdirSync(join(projected, ".."), { recursive: true });
    symlinkSync(join(pluginsDir, "openrig-core/skills/openrig-skills"), projected);

    const { entries: [result] } = auditSkills([projectedEntry()], { bundledSources: listBundledSkillSources(pluginsDir) });
    expect(result!.bundledFrom).toEqual({ plugin: "openrig-core", version: "0.1.4" });
    expect(result!.findings).toEqual([]);
  });

  it("without bundled sources the projected copy is audited as before", () => {
    writePlugin({ "SKILL.md": SKILL });
    writeProjected({ "SKILL.md": SKILL });

    const { entries: [result] } = auditSkills([projectedEntry()]);
    expect(result!.bundledFrom).toBeNull();
    expect(result!.findings).toHaveLength(3);
  });

  it("listBundledSkillSources reads each plugin's manifest version and skips plugins it can't version", () => {
    writePlugin({ "SKILL.md": SKILL }, "0.1.5");
    mkdirSync(join(pluginsDir, "no-manifest/skills"), { recursive: true });
    mkdirSync(join(pluginsDir, "no-skills/.claude-plugin"), { recursive: true });
    writeFileSync(join(pluginsDir, "no-skills/.claude-plugin/plugin.json"), JSON.stringify({ version: "1.0.0" }));

    expect(listBundledSkillSources(pluginsDir)).toEqual([
      { plugin: "openrig-core", version: "0.1.5", skillsDir: join(pluginsDir, "openrig-core/skills") },
    ]);
    expect(listBundledSkillSources(join(root, "missing"))).toEqual([]);
  });
});
