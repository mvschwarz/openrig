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

// Skills shipping in openrig-core v0. Slice 29 deleted 4 skills that were
// mis-imports or duplicates:
//   - claude-compact-in-place (was a SPEC, not a skill)
//   - session-compaction-and-restore (replaced by claude-compaction-restore)
//   - permission-posture (internal-only doctrine, not operator-facing)
//   - openrig-compaction-instructions (empty leftover from slice 27)
// Remaining: 8 operator-facing skills (was 11); slice 32 added mission-slice-sop.
const EXPECTED_SKILLS = [
  "agent-startup-and-context-ingestion",
  "claude-compaction-restore",
  "forming-an-openrig-mental-model",
  "mission-slice-sop",
  "openrig-architect",
  "openrig-cmux",
  "openrig-herdr",
  "openrig-operator",
  "openrig-user",
  "queue-handoff",
  "seat-continuity-and-handover",
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
    expect(manifest["version"]).toBe("0.1.0");
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
    expect(manifest["version"]).toBe("0.1.0");
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

  it("ships exactly the 11 expected skills (no drift; no missing skills; slice 29 deleted 4, slice 32 added mission-slice-sop, OPR.0.4.6.02 added openrig-herdr/openrig-cmux)", () => {
    const skillsDir = nodePath.join(PLUGIN_ROOT, "skills");
    const actual = fs.readdirSync(skillsDir).filter((f) =>
      fs.statSync(nodePath.join(skillsDir, f)).isDirectory()
      && fs.existsSync(nodePath.join(skillsDir, f, "SKILL.md")),
    );
    expect(actual.sort()).toEqual([...EXPECTED_SKILLS].sort());
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
