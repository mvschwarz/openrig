// OPR.0.4.4.23 originally pinned duplicate spec/plugin copies. The vendoring
// placement ruling now makes mission-slice-sop and openrig-user plugin-only:
// universal delivery comes from openrig-core, so recreating a spec copy would
// reintroduce the drift this guard was meant to prevent.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const PLUGIN_COPY = path.join(
  repoRoot,
  "packages/daemon/assets/plugins/openrig-core/skills/mission-slice-sop/SKILL.md",
);
describe("OPR.0.4.7 vendoring — universal skills have one plugin home", () => {
  for (const skill of ["mission-slice-sop", "openrig-user"] as const) {
    it(`${skill}: ships from the plugin and has no spec/canonical duplicate`, () => {
      const plugin = path.join(
        repoRoot,
        `packages/daemon/assets/plugins/openrig-core/skills/${skill}/SKILL.md`,
      );
      const spec = path.join(
        repoRoot,
        `packages/daemon/specs/agents/shared/skills/core/${skill}/SKILL.md`,
      );
      const canonical = path.join(
        repoRoot,
        `skills/_canonical/core/${skill}/SKILL.md`,
      );
      expect(fs.existsSync(plugin), `missing ${plugin}`).toBe(true);
      expect(fs.existsSync(spec), `redundant spec copy ${spec}`).toBe(false);
      expect(fs.existsSync(canonical), `redundant canonical copy ${canonical}`).toBe(false);
    });
  }
});

// aa922842 — the skill description is a RETRIEVAL surface: a runtime reads it to decide
// whether to load the skill, so it competes for a byte budget with every other skill's
// description. Keep the symptoms that make the skill discoverable; its body owns the SOP.
const DESCRIPTION_BUDGET_BYTES = 500;

const RETRIEVAL_SYMPTOMS = [
  "starting",
  "building",
  "handing off",
  "restoring",
  "closing",
  "mission",
  "slice",
];

/** Extract the frontmatter `description:` value, folding continuation lines. */
function readDescription(file: string): string {
  const text = fs.readFileSync(file, "utf-8");
  const match = /^description:\s*([\s\S]*?)(?=\n[A-Za-z_-]+:|\n---)/m.exec(text);
  expect(match, `no frontmatter description: found in ${file}`).not.toBeNull();
  return match![1].split(/\s+/).filter(Boolean).join(" ");
}

describe("aa922842 mission-slice-sop description budget + symptom retrieval", () => {
  it(`the shipped description fits the ${DESCRIPTION_BUDGET_BYTES}-byte retrieval budget`, () => {
    const description = readDescription(PLUGIN_COPY);
    const bytes = Buffer.byteLength(description, "utf-8");
    expect(
      bytes,
      `mission-slice-sop description is ${bytes} UTF-8 bytes (${description.length} chars), over the ${DESCRIPTION_BUDGET_BYTES}-byte budget.`,
    ).toBeLessThanOrEqual(DESCRIPTION_BUDGET_BYTES);
  });

  it("preserves the symptoms that retrieve the skill", () => {
    const description = readDescription(PLUGIN_COPY).toLowerCase();
    const missing = RETRIEVAL_SYMPTOMS.filter((symptom) => !description.includes(symptom));
    expect(
      missing,
      `mission-slice-sop description lost retrieval symptom(s): ${missing.join(", ")}.`,
    ).toEqual([]);
  });
});

describe("scope convention teaching-site sweep", () => {
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

  it("startup twins point to current work-node surfaces and remain byte-identical", () => {
    const spec = read("packages/daemon/specs/agents/shared/skills/core/agent-startup-and-context-ingestion/SKILL.md");
    const canonical = read("skills/_canonical/core/agent-startup-and-context-ingestion/SKILL.md");
    expect(spec).toBe(canonical);
    expect(spec).toContain("SPEC.md");
    expect(spec).toContain("NOTES.md");
    expect(spec).not.toContain("MISSION_BRIEF.md");
    expect(spec).not.toContain("MISSION_NOTES.md");
  });

  it("requirements writer emits a work-node SPEC with advisory sibling dependencies", () => {
    const skill = read("packages/daemon/specs/agents/shared/skills/pm/requirements-writer/SKILL.md");
    expect(skill).toContain("intent:");
    expect(skill).toMatch(/depends_on:[\s\S]*sibling[\s-]*build[\s-]*order/i);
    expect(skill).toContain("## Mini-requirements");
    expect(skill).toContain("## Proof contract");
  });

  it("continuity teachers no longer prescribe altitude-specific mission notes", () => {
    const retire = read("packages/daemon/assets/plugins/openrig-core/skills/retiring-and-inheriting-a-seat/SKILL.md");
    const advisor = read("packages/daemon/specs/rigs/launch/kernel/agents/advisor/lead/guidance/role.md");
    expect(retire).not.toContain("MISSION_NOTES");
    expect(advisor).not.toContain("MISSION_NOTES");
  });
});
