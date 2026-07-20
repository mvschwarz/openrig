// OPR.0.4.4.23 (arch S2) — the bundled openrig-core plugin's copy of
// mission-slice-sop must be MECHANICALLY pinned to the canonical product
// skill source: hand-sync without a guard is banned. This is the
// scope-audit-copies pattern (byte-parity CI test) applied to the skill —
// the mirror-skills script covers specs → skills/_canonical, and this test
// covers specs → the bundled plugin. Any edit to one copy fails here until
// the other copy is refreshed (cp, byte-for-byte).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const CANONICAL_SOURCE = path.join(
  repoRoot,
  "packages/daemon/specs/agents/shared/skills/core/mission-slice-sop/SKILL.md",
);
const PLUGIN_COPY = path.join(
  repoRoot,
  "packages/daemon/assets/plugins/openrig-core/skills/mission-slice-sop/SKILL.md",
);

// aa922842 — openrig-user is the SECOND skill whose canonical and bundled-plugin copies both
// carry the conventions pointer, so the dual-context rewrite edits both. Unlike
// mission-slice-sop it had NO byte-parity guard: mirror-skills covers specs → _canonical, and
// the S2 test above covered specs → plugin for exactly one skill. Verified by negative search
// over packages/*/test (openrig-core-plugin.test.ts asserts tree existence, not byte parity;
// skill-audit.test.ts has no equality assertion). Editing an unguarded pair is how the repo
// ends up correct while the shipped plugin ships stale — pin it before touching it.
const PARITY_PINNED_SKILLS = ["mission-slice-sop", "openrig-user"] as const;

function canonicalPath(skill: string): string {
  return path.join(repoRoot, `packages/daemon/specs/agents/shared/skills/core/${skill}/SKILL.md`);
}
function pluginPath(skill: string): string {
  return path.join(repoRoot, `packages/daemon/assets/plugins/openrig-core/skills/${skill}/SKILL.md`);
}

describe("OPR.0.4.4.23 mission-slice-sop plugin byte-parity (S2 drift guard)", () => {
  it("both copies exist", () => {
    expect(fs.existsSync(CANONICAL_SOURCE), `missing ${CANONICAL_SOURCE}`).toBe(true);
    expect(fs.existsSync(PLUGIN_COPY), `missing ${PLUGIN_COPY}`).toBe(true);
  });

  it("the bundled plugin copy is byte-identical to the canonical skill source", () => {
    const source = fs.readFileSync(CANONICAL_SOURCE);
    const plugin = fs.readFileSync(PLUGIN_COPY);
    expect(
      source.equals(plugin),
      "mission-slice-sop drifted between the canonical skill source and the bundled plugin — refresh the plugin copy byte-for-byte (cp source → plugin); hand-edited divergence is banned (OPR.0.4.4.23 S2)",
    ).toBe(true);
  });
});

describe("aa922842 canonical→plugin byte-parity, extended to every conventions-carrying skill", () => {
  for (const skill of PARITY_PINNED_SKILLS) {
    it(`${skill}: canonical and bundled plugin copies both exist`, () => {
      expect(fs.existsSync(canonicalPath(skill)), `missing ${canonicalPath(skill)}`).toBe(true);
      expect(fs.existsSync(pluginPath(skill)), `missing ${pluginPath(skill)}`).toBe(true);
    });

    it(`${skill}: bundled plugin copy is byte-identical to canonical`, () => {
      const source = fs.readFileSync(canonicalPath(skill));
      const plugin = fs.readFileSync(pluginPath(skill));
      expect(
        source.equals(plugin),
        `${skill} drifted between the canonical skill source and the bundled plugin — refresh the plugin copy byte-for-byte (cp source → plugin). mirror-skills does NOT cover this pair; hand-edited divergence is banned.`,
      ).toBe(true);
    });
  }
});

// aa922842 — the skill description is a RETRIEVAL surface: a runtime reads it to decide
// whether to load the skill, so it competes for a byte budget with every other skill's
// description. At 701 UTF-8 bytes this one was the outlier. Trimming it is only safe if the
// terms that make it findable survive — a shorter description that drops "proof-lock" is a
// skill that silently stops being retrieved for proof-lock work. Budget and trigger set are
// pinned together for that reason: neither is safe alone.
const DESCRIPTION_BUDGET_BYTES = 500;

// Guard-named trigger set (aa922842 ruling). Extend deliberately, never trim to make a
// draft fit — a term removed here is retrieval coverage removed from the product.
const REQUIRED_TRIGGERS = [
  "mission",
  "slice",
  "proof contract",
  "plan-lock",
  "proof-lock",
  "rig proof",
  "PROGRESS.md",
  "PROOF.md",
  "MISSION_NOTES.md",
  "handoff",
  "compaction",
];

/** Extract the frontmatter `description:` value, folding continuation lines. */
function readDescription(file: string): string {
  const text = fs.readFileSync(file, "utf-8");
  const match = /^description:\s*([\s\S]*?)(?=\n[A-Za-z_-]+:|\n---)/m.exec(text);
  expect(match, `no frontmatter description: found in ${file}`).not.toBeNull();
  return match![1].split(/\s+/).filter(Boolean).join(" ");
}

describe("aa922842 mission-slice-sop description budget + trigger preservation", () => {
  it(`the canonical description fits the ${DESCRIPTION_BUDGET_BYTES}-byte retrieval budget`, () => {
    const description = readDescription(CANONICAL_SOURCE);
    const bytes = Buffer.byteLength(description, "utf-8");
    expect(
      bytes,
      `mission-slice-sop description is ${bytes} UTF-8 bytes (${description.length} chars), over the ${DESCRIPTION_BUDGET_BYTES}-byte budget. Trim prose, never a trigger term from REQUIRED_TRIGGERS.`,
    ).toBeLessThanOrEqual(DESCRIPTION_BUDGET_BYTES);
  });

  it("every named trigger term survives the trim", () => {
    const description = readDescription(CANONICAL_SOURCE).toLowerCase();
    const missing = REQUIRED_TRIGGERS.filter((t) => !description.includes(t.toLowerCase()));
    expect(
      missing,
      `mission-slice-sop description lost trigger term(s): ${missing.join(", ")}. The skill will stop being retrieved for that work; restore the term and trim prose instead.`,
    ).toEqual([]);
  });

  it("the bundled plugin copy carries the same description (budget survives the byte-copy)", () => {
    // Byte-parity above already implies this, but asserting it directly means a future
    // refactor that relaxes parity cannot silently ship an over-budget installed skill.
    expect(readDescription(PLUGIN_COPY)).toBe(readDescription(CANONICAL_SOURCE));
  });
});
