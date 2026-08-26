// Test suite for plugin-primitive Phase 3a slice 3.2 — openrig-core plugin
// authoring + tree shape verification. Per IMPL-PRD §2 (HG-2.1, HG-2.2)
// + DESIGN.md §5.5.
//
// The vendored plugin tree at packages/daemon/assets/plugins/openrig-core/
// is the source of truth at v0 (auto-fetch from
// github.com/mvschwarz/openrig-plugins is a graceful overlay; vendored
// fallback is always available).
//
// This test suite asserts shape + contract — no copying or mutation. If
// these tests pass, the plugin is consumable by both Claude Code and Codex
// runtimes via their plugin loaders + by OpenRig's per-runtime
// applicability filter (plugin_type=auto detects both manifest dirs).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";

const PLUGIN_ROOT = nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core");

// Tier A is the universal skill spine projected into every shipped/default
// agent CWD. Role-specific skills stay on the spec-selected edge; host-only
// skills do not enter the product edges.
const EXPECTED_SKILLS = [
  // The Tier-A universal spine shipped in the product plugin. applying-a-permission-policy +
  // delegating-work joined in the 0.4.8 whole-set mirror (commit 864cea6b), which declares both
  // TIER-A explicitly ("applying-a-permission-policy (Tier-A: the agent-driven translation invoked
  // by the shipped rig setup --policy verb)" + "delegating-work (Tier-A: every-agent distribution)")
  // orienting-to-an-inherited-seat + retiring-and-inheriting-a-seat joined in the 2026-08-24
  // canon-drift regeneration (commit 4281729e3); every seat may be inherited or retired.
  // — so by the spine-only design's own rule they belong in the plugin. Kept in lockstep with the
  // shipped skills dir + the openrig-skills index + the README count.
  "applying-a-permission-policy",
  "claude-compaction-restore",
  "delegating-work",
  "forming-an-openrig-mental-model",
  "messaging-the-human",
  "mission-slice-sop",
  "openrig-operating-model",
  "openrig-skills",
  "openrig-user",
  "orienting-to-an-inherited-seat",
  "queue-handoff",
  "retiring-and-inheriting-a-seat",
  "seat-continuity-and-handover",
  "session-compaction-and-restore",
  "software-for-agents",
];

describe("openrig-core plugin — vendored tree shape (HG-2.1)", () => {
  it("exists at packages/daemon/assets/plugins/openrig-core/", () => {
    expect(fs.existsSync(PLUGIN_ROOT)).toBe(true);
    expect(fs.statSync(PLUGIN_ROOT).isDirectory()).toBe(true);
  });

  it("ships dual manifest (.claude-plugin/plugin.json + .codex-plugin/plugin.json) — Obra Superpowers shape", () => {
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"))).toBe(true);
  });

  it("LICENSE file present (Apache 2.0 per founder direction; public marketplace target)", () => {
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "LICENSE"))).toBe(true);
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "LICENSE"), "utf-8");
    expect(content).toMatch(/Apache License/i);
  });

  it("README.md present", () => {
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "README.md"))).toBe(true);
  });
});

describe("openrig-core plugin — manifest shape (HG-2.2)", () => {
  it(".claude-plugin/plugin.json validates as Claude plugin manifest", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8");
    const manifest = JSON.parse(content) as Record<string, unknown>;
    // Required fields per Claude plugin spec
    expect(manifest["name"]).toBe("openrig-core");
    expect(manifest["version"]).toBe("0.1.1");
    expect(typeof manifest["description"]).toBe("string");
    expect((manifest["description"] as string).length).toBeLessThanOrEqual(1024);
    // Hook + skills wiring
    expect(manifest["skills"]).toBe("./skills");
    expect(manifest["hooks"]).toBe("./hooks/claude.json");
    expect(manifest["repository"]).toMatch(/github:mvschwarz\/openrig-plugins/);
    expect(manifest["license"]).toBeDefined();
  });

  it(".codex-plugin/plugin.json validates as Codex plugin manifest (required: name, version, description)", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf-8");
    const manifest = JSON.parse(content) as Record<string, unknown>;
    // Codex requires name + version + description (per IMPL-PRD §2.3)
    expect(manifest["name"]).toBe("openrig-core");
    expect(manifest["version"]).toBe("0.1.1");
    expect(typeof manifest["description"]).toBe("string");
    expect(manifest["hooks"]).toBe("./hooks/codex.json");
    expect(manifest["skills"]).toBe("./skills");
  });

  it("both manifests reference the same skills/ subdir (cross-runtime portability)", () => {
    const claude = JSON.parse(fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    const codex = JSON.parse(fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(claude["skills"]).toEqual(codex["skills"]);
  });
});

describe("openrig-core plugin — skills (HG-2.1 skill content per agentskills.io spec)", () => {
  it("README reports the actual shipped skill count", () => {
    const readme = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "README.md"), "utf-8");
    expect(readme).toContain(`Skills (${EXPECTED_SKILLS.length})`);
  });

  it.each(EXPECTED_SKILLS)("skill '%s' has SKILL.md with required frontmatter (name + description)", (skillId) => {
    const skillPath = nodePath.join(PLUGIN_ROOT, "skills", skillId, "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, "utf-8");
    // Frontmatter: --- ... ---
    expect(content).toMatch(/^---\n/);
    // Required: name field
    expect(content).toMatch(/^name: \S+/m);
    // Required: description field (≤1024 chars per agentskills.io spec)
    const descMatch = content.match(/^description:\s*(?:>?-?\s*)?\n?([\s\S]*?)(?=\n\w+:|\n---)/m);
    expect(descMatch).toBeTruthy();
    const desc = descMatch?.[1]?.trim() ?? "";
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(1024);
  });

  it("ships exactly the Tier-A universal spine", () => {
    const skillsDir = nodePath.join(PLUGIN_ROOT, "skills");
    const actual = fs.readdirSync(skillsDir).filter((f) =>
      fs.statSync(nodePath.join(skillsDir, f)).isDirectory()
      && fs.existsSync(nodePath.join(skillsDir, f, "SKILL.md")),
    );
    expect(actual.sort()).toEqual([...EXPECTED_SKILLS].sort());
  });

  // The 0.5.0 whole-set mirror (commit cabd2b2f) REVERSED the routing: openrig-user is now a
  // self-contained as-built `rig` CLI guide, and the openrig-skills index is THE router — it names
  // every shipped skill and how to reach it (the CLAUDE.md bootstrap points a cold seat at the index).
  it("the openrig-skills index is the router — it names every shipped skill (0.5.0 mirror cabd2b2f)", () => {
    const index = fs.readFileSync(
      nodePath.join(PLUGIN_ROOT, "skills", "openrig-skills", "SKILL.md"),
      "utf-8",
    );
    // Membership invariant (the index's own closing note: the index and the shipped set are one scope).
    for (const skillId of EXPECTED_SKILLS) {
      expect(index, `openrig-skills index must name the shipped skill '${skillId}'`).toContain(skillId);
    }
    // openrig-user is listed as a spine skill (the index routes to it, not the reverse).
    expect(index).toContain("openrig-user");
  });

  it("the operating model teaches its core home and authored checklist marks without reversing the scaffold", () => {
    const skillRoot = nodePath.join(PLUGIN_ROOT, "skills", "openrig-operating-model");
    const skill = fs.readFileSync(nodePath.join(skillRoot, "SKILL.md"), "utf-8");
    const specTemplate = fs.readFileSync(nodePath.join(skillRoot, "templates", "SPEC.md"), "utf-8");

    expect(skill).toContain("ships in the mode-neutral `openrig-core` plugin");
    expect(skill).toContain("PROGRESS reconciliation (2026-08-26)");
    expect(skill).toContain("authored acceptance marks");
    expect(skill).not.toContain("mode plugin's operating-model skill");
    expect(specTemplate).toContain("PROGRESS.md is the authored acceptance checklist");
    expect(specTemplate).not.toContain("PROGRESS is DERIVED");
  });

  it("the index gives a reachable repo load-path form for spec-shipped skills (0.5.0 mirror cabd2b2f: repo paths, superseding the old ${OPENRIG_CLI_ROOT} path table)", () => {
    const index = fs.readFileSync(
      nodePath.join(PLUGIN_ROOT, "skills", "openrig-skills", "SKILL.md"),
      "utf-8",
    );
    // The rewritten index points profile-selected (spec-shipped) skills at their repo location; no row
    // is a dead end. The prior ${OPENRIG_CLI_ROOT}/~.openrig path table was superseded by this human map.
    expect(index).toContain("packages/daemon/specs/agents/shared/skills/core/");
    expect(index).not.toContain("OPENRIG_CLI_ROOT"); // the old env-var path form is gone by design
  });

  // P6(B) desk/PM ruling: 864cea6b's mirror made an over-broad content-drop of the `rig spec audit
  // rig.yaml` advisory-audit pointer from the openrig-architect SKILL.md (the command + the startup
  // guide's line still exist — same heal-the-stranding class as the (A) pods). That skill is
  // MIRROR-GENERATED from the external authored canon, so a pool-only restore would be silently
  // re-deleted at the next mirror pass. PM ruled RESTORE UPSTREAM (mirror-law: fix at source), owned by
  // dev-driver as 864cea6b remediation inside their (A) canon-restore increment (openrig-architect is
  // edges=[canonical,spec] — internal, no public-edge exposure). This assertion is TEMP-relaxed to the
  // STARTUP GUIDE only (agent-startup-guide.md — stable, hand-maintained, not mirror-generated).
  // TODO(P6-B ← dev-driver (A) canon-restore): re-add `expect(architectSkill).toContain("rig spec
  // audit rig.yaml")` (+ its readFileSync) once the upstream restore lands + mirrors — with the mirror
  // on our side instead of against us.
  it("routes rig authors through the advisory spec audit in the startup guide (TEMP: skill assertion re-adds on (A) canon-restore)", () => {
    const startupGuide = fs.readFileSync(
      nodePath.resolve(import.meta.dirname, "../../../docs/reference/agent-startup-guide.md"),
      "utf-8",
    );
    expect(startupGuide).toContain("rig spec audit rig.yaml");
  });
});

describe("openrig-core plugin — hooks (HG-2.6 + HG-2.7)", () => {
  it("hooks/claude.json declares Claude activity + compaction bridge events", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "claude.json"), "utf-8");
    const config = JSON.parse(content) as { hooks: Record<string, unknown> };
    expect(config.hooks).toBeDefined();
    expect(Object.keys(config.hooks).sort()).toEqual([
      // OPR.0.4.1.09: PreCompact added so the PRODUCT plugin owns the marker WRITER
      // (precompact-hook.mjs generates the restore packet + writes restore-pending/<seat>.json
      // on PreCompact), instead of depending on the drift-prone host skill copy.
      "Notification", "PostCompact", "PreCompact", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
  });

  it("PreCompact wires the product-plugin precompact-hook.mjs writer (OPR.0.4.1.09 — product owns the writer)", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "claude.json"), "utf-8");
    const config = JSON.parse(content) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const preCompact = config.hooks["PreCompact"];
    expect(preCompact).toBeDefined();
    const commands = preCompact!.flatMap((entry) => entry.hooks.map((h) => h.command));
    // The PreCompact command must run the product-plugin writer that GENERATES the packet
    // (restore-from-jsonl) — never a hard-coded outputDir. Path is under skills/, via the
    // ${CLAUDE_PLUGIN_ROOT} substitution so the PRODUCT copy runs (drift-immune).
    expect(commands.some((c) => /CLAUDE_PLUGIN_ROOT.*claude-compaction-restore\/scripts\/precompact-hook\.mjs/.test(c))).toBe(true);
    // The writer ships in the product tree.
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs"))).toBe(true);
  });

  it("hooks/codex.json declares 4 events incl. PermissionRequest (Codex hook-primary approval guard, OPR.0.4.1.10)", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "codex.json"), "utf-8");
    const config = JSON.parse(content) as { hooks: Record<string, unknown> };
    expect(config.hooks).toBeDefined();
    // PermissionRequest (openai/codex PR #17563) is wired so a Codex approval prompt produces a
    // needs_input runtime hook = the hook-primary rig-send guard for Codex (no Claude-style Notification).
    expect(Object.keys(config.hooks).sort()).toEqual([
      "PermissionRequest", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
  });

  it("hooks/scripts/activity-relay.cjs exists (the canonical relay script that POSTs to /api/activity/hooks)", () => {
    const relayPath = nodePath.join(PLUGIN_ROOT, "hooks", "scripts", "activity-relay.cjs");
    expect(fs.existsSync(relayPath)).toBe(true);
    const content = fs.readFileSync(relayPath, "utf-8");
    // The script is what plugin-shipped hooks invoke; it should POST to the
    // activity-hooks endpoint that the daemon (post-rip) preserved per
    // IMPL-PRD §1.2 endpoint discipline.
    expect(content).toMatch(/activity\/hooks|activity-hooks/i);
  });

  it("hooks/scripts/compaction-restore-bridge.cjs exists (Claude post-compact restore bridge)", () => {
    const bridgePath = nodePath.join(PLUGIN_ROOT, "hooks", "scripts", "compaction-restore-bridge.cjs");
    expect(fs.existsSync(bridgePath)).toBe(true);
    const content = fs.readFileSync(bridgePath, "utf-8");
    expect(content).toMatch(/compaction restore packet is available/i);
    expect(content).toMatch(/additionalContext/);
  });

  it("Claude hook commands reference ${CLAUDE_PLUGIN_ROOT} (Claude path substitution convention)", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "claude.json"), "utf-8");
    expect(content).toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}/);
    // Should point at the relay script via substitution
    expect(content).toMatch(/CLAUDE_PLUGIN_ROOT.*activity-relay\.cjs/);
    expect(content).toMatch(/CLAUDE_PLUGIN_ROOT.*compaction-restore-bridge\.cjs/);
  });

  it("Codex hook commands reference ${PLUGIN_ROOT} (the var Codex actually substitutes — OPR.0.4.1.10)", () => {
    // rev1-r2 catch (B1): Codex 0.139 substitutes ${PLUGIN_ROOT}/${CLAUDE_PLUGIN_ROOT} for
    // plugin-discovered hooks (verified: the var is present in the codex binary; ${CODEX_PLUGIN_ROOT}
    // is NOT, and nothing in OpenRig sets it). openrig-core projects to <cwd>/.codex/plugins/<id>/, so
    // ${PLUGIN_ROOT} resolves to the plugin dir and the activity-relay hook actually fires.
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "codex.json"), "utf-8");
    expect(content).toMatch(/\$\{PLUGIN_ROOT\}/);
    expect(content).toMatch(/PLUGIN_ROOT.*activity-relay\.cjs/);
    // Guard against regressing to the unsupported variable.
    expect(content).not.toMatch(/CODEX_PLUGIN_ROOT/);
  });
});

describe("openrig-core plugin — projection-applicability (works with batch-1 pluginAppliesToX filters)", () => {
  it("dual-manifest plugin classifies as applicable to BOTH adapters under auto-detection", () => {
    // Per batch-1 pluginAppliesToClaude/pluginAppliesToCodex helpers:
    //   auto + .claude-plugin/plugin.json present → applies to Claude
    //   auto + .codex-plugin/plugin.json present → applies to Codex
    // openrig-core has BOTH manifest dirs, so auto-detect projects to both.
    const claudeManifest = nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
    const codexManifest = nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
    expect(fs.existsSync(claudeManifest)).toBe(true);
    expect(fs.existsSync(codexManifest)).toBe(true);
  });
});
