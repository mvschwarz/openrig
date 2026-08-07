// P6(A) — the refs→membership→ship-categories→disk CHAIN CHECK (PM pin upgrade; the
// class-kill for the 0.4.8/864cea6b stranding). Every list is validated against ITS
// CONSUMER, end to end, so a stranding has no layer to hide in:
//
//   Leg 1  refs ⊆ membership              — everything agent.yaml references exists in the oracle
//   Leg 2  membership ⊆ SHIP_CATEGORIES   — every oracle product_public category is consumed by the
//                                            mirror's ship set (the accept-and-drop cousin at the
//                                            pipeline layer: 864cea6b's mirror carried a category the
//                                            script never consumed — restored_role_pm_selected — so
//                                            the PM's re-add was silently dropped and never shipped)
//   Leg 3  ship-set ⊆ disk                — every skill the oracle says ships exists on disk in the pool
//
// The three faces of one bug: 864cea6b deleted the pod/pm SKILL.md files (leg 3), the PM re-added
// them to a product_public category the mirror never read (leg 2), and agent.yaml kept referencing
// them (leg 1). This gate makes any recurrence fail LOUD in CI instead of at daemon boot.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SHIP_CATEGORIES, shipSetFromMembership } from "../../../scripts/mirror-skills.mjs";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const AGENT_YAML = join(__dirname, "..", "specs", "agents", "shared", "agent.yaml");
const MEMBERSHIP = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "product-public-skills.generated.json"), "utf8"));
const LAYOUT = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "skill-edge-layout.generated.json"), "utf8"));

// Skills the oracle ships that live ONLY in the external, founder-gated skill canon: authored there,
// already tracked in the generated edge digests, but not yet mirrored into this repo (their source
// isn't in git and the founder mirror inputs — OPENRIG_SKILL_CANON_ROOT + the authority YAMLs — are
// unset here, so they can't be restored from the repo). This is a repo↔external-canon SYNC GAP the
// next founder mirror closes, NOT the silent 864cea6b category-drop (leg 2 catches that). The guard
// test below keeps this set MINIMAL and self-policing: every entry MUST be ship-set + digest-tracked
// + absent from repo disk — so a genuinely-forgotten stranding can never hide behind it.
const EXTERNAL_CANON_PENDING = new Set(["oversight-team", "retiring-and-inheriting-a-seat"]);

type Membership = Record<string, unknown>;
type AgentSkill = { id: string; path: string };

// The FULL oracle vocabulary: every skill named in any membership category. A skill agent.yaml
// references must appear SOMEWHERE here or the mirror has no basis to ship (or intentionally hold) it.
function fullMembershipSkills(m: Membership): Set<string> {
  const out = new Set<string>();
  const eat = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && out.add(x));
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(eat);
  };
  eat(m.product_public);
  eat(m.vendored_ship_with_provenance);
  eat(m.not_public);
  eat(m.pending_author_public);
  return out;
}

function agentSkills(yamlPath: string): AgentSkill[] {
  const doc = parseYaml(readFileSync(yamlPath, "utf8")) as {
    resources?: { skills?: AgentSkill[] };
  };
  return doc.resources?.skills ?? [];
}

// Leg 1 — refs ⊆ membership. Only `skills/`-path entries are oracle-governed; `runtime/` fragments
// (claude-settings, mcp, codex-config, activity-hooks) are packaged config, not skills.
function refsNotInMembership(skills: AgentSkill[], m: Membership): string[] {
  const known = fullMembershipSkills(m);
  return skills
    .filter((s) => typeof s.path === "string" && s.path.startsWith("skills/"))
    .map((s) => s.id)
    .filter((id) => !known.has(id));
}

// Leg 2 — membership ⊆ SHIP_CATEGORIES. Every product_public category the oracle declares MUST be
// consumed by the mirror's ship set, or a whole category of skills is accepted-and-dropped.
function categoriesNotConsumed(m: Membership, shipCategories: readonly string[]): string[] {
  const declared = Object.keys((m.product_public as Record<string, unknown>) ?? {});
  const consumed = new Set(shipCategories);
  return declared.filter((c) => !consumed.has(c));
}

// Leg 3 — ship-set ⊆ disk. Every skill the oracle says ships resolves to an on-disk SKILL.md in
// EACH edge its layout declares (edge-aware: a flat edge like `plugin` places skills at its root; a
// categorized edge like `spec`/`canonical` places them under their category). Reported as skill@edge.
type Layout = {
  edges: Record<string, { path: string; layout: string }>;
  skills?: Record<string, { edges?: string[]; category?: string | null }>;
};
function shipSetNotOnDisk(m: Membership, layout: Layout, repoRoot: string): string[] {
  const missing: string[] = [];
  for (const skill of shipSetFromMembership(m)) {
    const sl = layout.skills?.[skill];
    if (!sl?.edges?.length) {
      missing.push(`${skill} (no layout edges)`);
      continue;
    }
    for (const edge of sl.edges) {
      const ec = layout.edges[edge];
      const edgeRoot = join(repoRoot, ec.path);
      const category = ec.layout === "flat" ? null : sl.category ?? null;
      const dir = category ? join(edgeRoot, category, skill) : join(edgeRoot, skill);
      if (!existsSync(join(dir, "SKILL.md"))) missing.push(`${skill}@${edge}`);
    }
  }
  return missing;
}

describe("P6(A) skill refs→membership→ship-categories→disk chain (0.4.8 stranding class-kill)", () => {
  it("LEG 1 — every skills/-path agent.yaml reference exists in the oracle membership", () => {
    const stranded = refsNotInMembership(agentSkills(AGENT_YAML), MEMBERSHIP);
    expect(stranded, `agent.yaml references NOT in the oracle: ${stranded.join(", ")}`).toEqual([]);
  });

  it("LEG 2 — every oracle product_public category is consumed by the mirror SHIP_CATEGORIES", () => {
    const dropped = categoriesNotConsumed(MEMBERSHIP, SHIP_CATEGORIES);
    expect(dropped, `oracle categories the mirror silently drops: ${dropped.join(", ")}`).toEqual([]);
  });

  it("LEG 3 — every oracle ship-set skill exists on disk in each declared edge", () => {
    const missing = shipSetNotOnDisk(MEMBERSHIP, LAYOUT, REPO_ROOT).filter(
      (v) => !EXTERNAL_CANON_PENDING.has(v.split("@")[0]),
    );
    expect(missing, `ship-set skills with no on-disk SKILL.md: ${missing.join(", ")}`).toEqual([]);
  });

  // The external-canon-pending allowlist must stay MINIMAL: each entry MUST be (a) in the ship set,
  // (b) LAYOUT-tracked — the founder layout still demands it, so the control-plane staleness check stays
  // LOUD about its absence (layout-missing) and only the named allowlist tolerates it — and (c) genuinely
  // absent from repo disk. An entry off the ship set, off the layout, or actually on disk is stale and
  // fails here, so a real stranding can never be silently parked in the allowlist.
  // NOTE: the property is LAYOUT-tracked, not digest-tracked — the disk-truth digest regen correctly
  // omits a digest for a file that isn't on disk (a hash of a ghost is meaningless); "loud" comes from
  // the layout demanding it (layout = authority, disk = reality).
  it("external-canon-pending allowlist is minimal + self-policing (no real stranding hides here)", () => {
    const shipSet = new Set(shipSetFromMembership(MEMBERSHIP));
    const layoutTracked = new Set(
      Object.entries((LAYOUT.skills ?? {}) as Record<string, { edges?: string[] }>)
        .filter(([, entry]) => (entry.edges?.length ?? 0) > 0)
        .map(([skill]) => skill),
    );
    const stillMissing = new Set(shipSetNotOnDisk(MEMBERSHIP, LAYOUT, REPO_ROOT).map((v) => v.split("@")[0]));
    for (const skill of EXTERNAL_CANON_PENDING) {
      expect(shipSet.has(skill), `${skill} must be in the oracle ship set`).toBe(true);
      expect(layoutTracked.has(skill), `${skill} must be layout-tracked (loud via layout-missing, not silent)`).toBe(true);
      expect(stillMissing.has(skill), `${skill} must be genuinely absent from repo disk`).toBe(true);
    }
  });

  // Each leg must actually CATCH its stranding face — synthetic fixtures reproducing 864cea6b.
  it("catches the 864cea6b stranding on every leg (fixture REDs)", () => {
    // Leg 1: a referenced skill absent from the oracle.
    expect(
      refsNotInMembership([{ id: "orphan-skill", path: "skills/pods/orphan-skill" }], { product_public: {} }),
    ).toEqual(["orphan-skill"]);
    // Leg 2: an oracle category the mirror never consumes (the exact 864cea6b face).
    expect(
      categoriesNotConsumed({ product_public: { restored_role_pm_selected: ["x"] } }, ["clean"]),
    ).toEqual(["restored_role_pm_selected"]);
    // Leg 3: a ship-set skill declared for the spec edge but with no file on disk.
    expect(
      shipSetNotOnDisk(
        { product_public: { clean: ["ghost-skill"] } },
        {
          edges: { spec: { path: "packages/daemon/specs/agents/shared/skills", layout: "categorized" } },
          skills: { "ghost-skill": { edges: ["spec"], category: "pods" } },
        },
        REPO_ROOT,
      ),
    ).toEqual(["ghost-skill@spec"]);
  });
});
