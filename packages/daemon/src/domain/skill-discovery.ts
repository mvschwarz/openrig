// V0.3.0 daemon-skill-discovery — filesystem skill scan + structural
// validation. Closes the gap where profile-resolver only saw skills
// declared in `agent.yaml`'s `resources.skills` + imports, not skills
// dropped at user-library or rig-bundled paths.
//
// The validator's question is now "would Claude Code or Codex actually
// load this when it sees the directory?" — i.e., is there a SKILL.md
// with a name + description + body. The daemon's hardcoded shared
// bundle is no longer the gate.
//
// SC-29 EXCEPTION #7 declared in slice ACK §5.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillResource } from "./types.js";

export type SkillRuntime = "claude-code" | "codex";

export interface SkillDiscoveryPaths {
  runtime: SkillRuntime;
  /** Operator home dir (resolved by the daemon at startup, NOT read
   *  here via os.homedir() so tests can inject a fixture root). */
  homedir: string;
  /** The agent's resolved working directory — rig-bundled skills live
   *  under <cwd>/.claude/skills/ or <cwd>/.agents/skills/. */
  cwd: string;
  /** The rig-spec install dir — bundled domain skills live under
   *  <specInstallDir>/skills/<name>/. Optional: undefined means the
   *  rig was installed in-place and no separate install-dir applies. */
  specInstallDir?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Any other fields the runtime may consume (allowed-tools, model,
   *  etc.) pass through unchecked — they are not load-bearing for
   *  daemon resource validation. */
  [key: string]: unknown;
}

export type ParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; reason: string };

export interface SkillRejection {
  path: string;
  reason: string;
}

export interface SkillDiscoveryResult {
  skills: SkillResource[];
  rejected: SkillRejection[];
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** Parse a SKILL.md document into frontmatter + body, validating the
 *  shape Claude Code and Codex both require: a YAML frontmatter block
 *  delimited by `---` lines, with at minimum `name` + `description`
 *  fields, plus a non-empty body. */
export function parseSkillFrontmatter(content: string): ParseResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { ok: false, reason: "no YAML frontmatter delimited by --- lines" };
  }
  const [, fmText, body] = match;

  let parsed: unknown;
  try {
    parsed = parseYaml(fmText!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `frontmatter YAML parse error: ${msg}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "frontmatter is not a YAML mapping" };
  }
  const fm = parsed as Record<string, unknown>;

  if (typeof fm.name !== "string" || fm.name.trim().length === 0) {
    return { ok: false, reason: "frontmatter missing required `name` field" };
  }
  if (typeof fm.description !== "string" || fm.description.trim().length === 0) {
    return { ok: false, reason: "frontmatter missing required `description` field" };
  }

  if (!body || body.trim().length === 0) {
    return { ok: false, reason: "SKILL.md body is empty (the runtime would have nothing to load)" };
  }

  return {
    ok: true,
    frontmatter: { ...fm, name: fm.name as string, description: fm.description as string } as SkillFrontmatter,
    body,
  };
}

/** Discover skills for a runtime by scanning the canonical filesystem
 *  paths and structurally validating each candidate. Returns the
 *  accepted skills as SkillResource records (id from frontmatter; path
 *  pointing at the skill directory) plus a list of rejections so the
 *  caller can surface clear errors when validation fails. */
export function discoverSkillsForRuntime(paths: SkillDiscoveryPaths): SkillDiscoveryResult {
  const scanRoots = listScanRoots(paths);
  const skills: SkillResource[] = [];
  const rejected: SkillRejection[] = [];
  const seenIds = new Set<string>();

  for (const root of scanRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // Permission / IO error — silent skip; this is best-effort.
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(root, entry);
      let stat;
      try { stat = statSync(skillDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) {
        // Not a skill — silently skip (a directory without SKILL.md is
        // either unrelated content or a partially-set-up skill the
        // operator hasn't finished).
        continue;
      }

      let content: string;
      try {
        content = readFileSync(skillFile, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rejected.push({ path: skillDir, reason: `SKILL.md read error: ${msg}` });
        continue;
      }

      const parsed = parseSkillFrontmatter(content);
      if (!parsed.ok) {
        rejected.push({ path: skillDir, reason: parsed.reason });
        continue;
      }

      const id = parsed.frontmatter.name;
      if (seenIds.has(id)) {
        // Earlier root in the precedence list already provided this
        // id; later occurrences are shadowed by the most-specific-wins
        // rule encoded in listScanRoots ordering.
        continue;
      }
      seenIds.add(id);
      skills.push({ id, path: skillDir });
    }
  }

  return { skills, rejected };
}

/** Build the precedence-ordered list of scan roots for a runtime.
 *  Earlier entries win on collision (most-specific-wins): rig-bundled
 *  at cwd > spec-install-dir > user libraries. Within user libraries,
 *  the runtime-specific dir is preferred over the shared
 *  ~/.openrig/skills/ pool so an operator who explicitly installed a
 *  Claude-only or Codex-only version takes precedence over the
 *  cross-runtime one. */
function listScanRoots(paths: SkillDiscoveryPaths): string[] {
  const { runtime, homedir, cwd, specInstallDir } = paths;
  const runtimeDir = runtime === "claude-code" ? ".claude" : ".agents";
  const roots: string[] = [];

  // 1. Rig-bundled at cwd (most-specific; ships with the rig source).
  roots.push(join(cwd, runtimeDir, "skills"));

  // 2. Spec-install-dir bundled (bundled-with-rig but installed at a
  // separate path; e.g., from `rig up <bundle>` extraction).
  if (specInstallDir) roots.push(join(specInstallDir, "skills"));

  // 3. Runtime-specific user library (Claude-only or Codex-only
  // operator install).
  roots.push(join(homedir, runtimeDir, "skills"));

  // 4. Shared user-spec library (cross-runtime operator install via
  // `rig specs add`).
  roots.push(join(homedir, ".openrig", "skills"));

  return roots;
}
