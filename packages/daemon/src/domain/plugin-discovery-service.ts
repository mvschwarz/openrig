// Phase 3a slice 3.3 — Plugin Discovery Service.
//
// SC-29 EXCEPTION #8 declared verbatim:
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 HTTP routes (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by)
// as backing API. No additional state, no SQL migration, no mutation routes.
// Read-only discovery surface aggregating filesystem-scan unions per
// DESIGN.md §5.4. Per IMPL-PRD §3.3 'Code touches' this allocation is explicit;
// documenting in compliance with banked SC-29 verbatim-declaration rule."
//
// What it does (DESIGN.md §5.4 — auto-discovery library = derived view):
//   - Scans 3 filesystem roots for plugin manifests:
//       * ~/.openrig/plugins/<id>/                         (vendored)
//       * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/   (claude cache)
//       * ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/    (codex cache)
//   - Returns aggregated list with provenance labels per source root.
//   - For getPlugin(id), reads .claude-plugin/plugin.json and/or .codex-plugin/plugin.json
//     and summarizes the tree (skills/, hooks, mcp_servers, etc.) so the UI
//     viewer can show what the plugin ships without re-reading files.
//   - For findUsedBy(id), parses agent.yaml files in the spec library and
//     walks resources.plugins[].id to collect references. Operates on parsed
//     YAML structure (NOT string-grep) so comments + adjacent text don't
//     produce false positives.
//
// Branch-merge-friendly: this service operates on filesystem reads + parsed
// YAML; doesn't depend on batch 1's PluginResource type from
// plugin-primitive-v0 branch. The agent YAML structure it reads
// (resources.plugins[].id + profile.uses.plugins[]) is exactly what batch 1
// produces, so post-merge the service continues to work unchanged.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

export type PluginRuntime = "claude" | "codex";
export type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache";

export interface PluginEntry {
  /** Stable id for routing (`openrig-core`, `<marketplace>:<plugin>:<version>`). */
  id: string;
  /** Plugin's declared name from manifest. */
  name: string;
  /** Plugin's declared version. */
  version: string;
  /** Optional description from manifest. */
  description: string | null;
  /** Source root where this plugin was discovered. */
  source: PluginSourceKind;
  /**
   * Human-readable provenance label per DESIGN.md §5.4 + IMPL-PRD §3.2:
   *   - `vendored:<plugin>`
   *   - `claude-cache:<marketplace>/<plugin>/<version>`
   *   - `codex-cache:<marketplace>/<plugin>/<version>`
   */
  sourceLabel: string;
  /** Which runtimes this plugin supports (presence of manifest dirs). */
  runtimes: PluginRuntime[];
  /** Filesystem path to the plugin root. */
  path: string;
  /**
   * mtime of the manifest file (used as a soft "last loaded" approximation
   * for the UI list view; exact "loaded by runtime" timestamp is out of
   * scope at v0).
   */
  lastSeenAt: string | null;
}

export interface PluginManifestSummary {
  /** Original manifest object from `<plugin>/.claude-plugin/plugin.json`. */
  raw: Record<string, unknown>;
  /** Convenience-extracted fields (best-effort; null if missing). */
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

export interface PluginSkillSummary {
  /** Skill folder name. */
  name: string;
  /** Path relative to plugin root. */
  relativePath: string;
}

export interface PluginHookSummary {
  /** Which runtime this hook config targets. */
  runtime: PluginRuntime;
  /** Path relative to plugin root. */
  relativePath: string;
  /** Hook event names declared (best-effort parse). */
  events: string[];
}

export interface PluginDetail {
  /** The list-view entry. */
  entry: PluginEntry;
  /** Parsed `.claude-plugin/plugin.json` if present. */
  claudeManifest: PluginManifestSummary | null;
  /** Parsed `.codex-plugin/plugin.json` if present. */
  codexManifest: PluginManifestSummary | null;
  /** Skill folders shipped under `<plugin>/skills/`. */
  skills: PluginSkillSummary[];
  /** Hook configs shipped under `<plugin>/hooks/`. */
  hooks: PluginHookSummary[];
}

export interface AgentReference {
  /** agent name (from agent.yaml `name` field). */
  agentName: string;
  /** absolute path to agent.yaml. */
  sourcePath: string;
  /** profile names that include this plugin in their uses.plugins[]. */
  profiles: string[];
}

export interface PluginDiscoveryServiceOpts {
  /** Root directory for vendored OpenRig plugins (typically ~/.openrig/plugins). */
  openrigPluginsDir: string;
  /** Root directory for Claude Code plugin cache (typically ~/.claude/plugins/cache). */
  claudeCacheDir: string;
  /** Root directory for Codex plugin cache (typically ~/.codex/plugins/cache). */
  codexCacheDir: string;
  /**
   * Spec library directory containing agent.yaml files (recursively scanned).
   * Typically the daemon's resolved spec library root. May be a single root
   * for v0; expand to multi-root in a later slice if the spec library hooks
   * its full root list through.
   */
  specLibraryDir: string;
}

export interface ListPluginsOpts {
  /** Filter to plugins supporting a specific runtime. */
  runtimeFilter?: PluginRuntime;
  /** Filter to plugins from a specific source root. */
  sourceFilter?: PluginSourceKind;
}

const CLAUDE_MANIFEST_REL = ".claude-plugin/plugin.json";
const CODEX_MANIFEST_REL = ".codex-plugin/plugin.json";

export class PluginDiscoveryService {
  private readonly opts: PluginDiscoveryServiceOpts;

  constructor(opts: PluginDiscoveryServiceOpts) {
    this.opts = opts;
  }

  listPlugins(filterOpts: ListPluginsOpts = {}): PluginEntry[] {
    const out: PluginEntry[] = [];

    // 1. Vendored OpenRig plugins.
    if (existsSync(this.opts.openrigPluginsDir)) {
      for (const entry of safeReaddir(this.opts.openrigPluginsDir)) {
        const pluginPath = join(this.opts.openrigPluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const detected = this.detectPlugin(pluginPath, "vendored", entry);
        if (detected) out.push(detected);
      }
    }

    // 2. Claude Code cache: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
    if (existsSync(this.opts.claudeCacheDir)) {
      for (const marketplace of safeReaddir(this.opts.claudeCacheDir)) {
        const marketplacePath = join(this.opts.claudeCacheDir, marketplace);
        if (!isDir(marketplacePath)) continue;
        for (const plugin of safeReaddir(marketplacePath)) {
          const pluginRoot = join(marketplacePath, plugin);
          if (!isDir(pluginRoot)) continue;
          for (const version of safeReaddir(pluginRoot)) {
            const versionPath = join(pluginRoot, version);
            if (!isDir(versionPath)) continue;
            const id = `claude-cache:${marketplace}/${plugin}/${version}`;
            const sourceLabel = `claude-cache:${marketplace}/${plugin}/${version}`;
            const detected = this.detectPlugin(versionPath, "claude-cache", id, sourceLabel);
            if (detected) out.push(detected);
          }
        }
      }
    }

    // 3. Codex cache: ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/
    if (existsSync(this.opts.codexCacheDir)) {
      for (const marketplace of safeReaddir(this.opts.codexCacheDir)) {
        const marketplacePath = join(this.opts.codexCacheDir, marketplace);
        if (!isDir(marketplacePath)) continue;
        for (const plugin of safeReaddir(marketplacePath)) {
          const pluginRoot = join(marketplacePath, plugin);
          if (!isDir(pluginRoot)) continue;
          for (const version of safeReaddir(pluginRoot)) {
            const versionPath = join(pluginRoot, version);
            if (!isDir(versionPath)) continue;
            const id = `codex-cache:${marketplace}/${plugin}/${version}`;
            const sourceLabel = `codex-cache:${marketplace}/${plugin}/${version}`;
            const detected = this.detectPlugin(versionPath, "codex-cache", id, sourceLabel);
            if (detected) out.push(detected);
          }
        }
      }
    }

    let filtered = out;
    if (filterOpts.runtimeFilter) {
      filtered = filtered.filter((p) => p.runtimes.includes(filterOpts.runtimeFilter!));
    }
    if (filterOpts.sourceFilter) {
      filtered = filtered.filter((p) => p.source === filterOpts.sourceFilter);
    }
    return filtered;
  }

  getPlugin(id: string): PluginDetail | null {
    const entry = this.listPlugins().find((p) => p.id === id);
    if (!entry) return null;

    const claudeManifestPath = join(entry.path, CLAUDE_MANIFEST_REL);
    const codexManifestPath = join(entry.path, CODEX_MANIFEST_REL);

    const claudeManifest = readManifest(claudeManifestPath);
    const codexManifest = readManifest(codexManifestPath);

    const skills: PluginSkillSummary[] = [];
    const skillsDir = join(entry.path, "skills");
    if (existsSync(skillsDir)) {
      for (const skillName of safeReaddir(skillsDir)) {
        const skillPath = join(skillsDir, skillName);
        if (isDir(skillPath)) {
          skills.push({ name: skillName, relativePath: `skills/${skillName}` });
        }
      }
    }

    const hooks: PluginHookSummary[] = [];
    const hooksDir = join(entry.path, "hooks");
    if (existsSync(hooksDir)) {
      const claudeHooks = join(hooksDir, "claude.json");
      if (existsSync(claudeHooks)) {
        hooks.push({
          runtime: "claude",
          relativePath: "hooks/claude.json",
          events: extractHookEvents(claudeHooks),
        });
      }
      const codexHooks = join(hooksDir, "codex.json");
      if (existsSync(codexHooks)) {
        hooks.push({
          runtime: "codex",
          relativePath: "hooks/codex.json",
          events: extractHookEvents(codexHooks),
        });
      }
    }

    return { entry, claudeManifest, codexManifest, skills, hooks };
  }

  findUsedBy(pluginId: string): AgentReference[] {
    const refs: AgentReference[] = [];
    if (!existsSync(this.opts.specLibraryDir)) return refs;

    for (const candidate of walkAgentYamls(this.opts.specLibraryDir)) {
      const parsed = safeParseYaml(candidate.content);
      if (!parsed || typeof parsed !== "object") continue;

      const resourcesPlugins = readResourcesPlugins(parsed);
      const declaresThisPlugin = resourcesPlugins.some((p) => p === pluginId);
      if (!declaresThisPlugin) continue;

      const profiles = readProfilesUsingPlugin(parsed, pluginId);
      const agentName = readField(parsed, "name");
      if (!agentName) continue;
      refs.push({ agentName, sourcePath: candidate.path, profiles });
    }
    return refs;
  }

  // -- helpers --

  private detectPlugin(
    pluginPath: string,
    source: PluginSourceKind,
    explicitId: string,
    explicitSourceLabel?: string,
  ): PluginEntry | null {
    const claudeManifestPath = join(pluginPath, CLAUDE_MANIFEST_REL);
    const codexManifestPath = join(pluginPath, CODEX_MANIFEST_REL);

    const hasClaude = existsSync(claudeManifestPath);
    const hasCodex = existsSync(codexManifestPath);
    if (!hasClaude && !hasCodex) return null;

    const runtimes: PluginRuntime[] = [];
    if (hasClaude) runtimes.push("claude");
    if (hasCodex) runtimes.push("codex");

    // Read the first available manifest for name/version/description.
    const primaryManifestPath = hasClaude ? claudeManifestPath : codexManifestPath;
    const manifest = readManifest(primaryManifestPath);
    if (!manifest) return null;

    const name = manifest.name ?? basename(pluginPath);
    const version = manifest.version ?? "unknown";
    const description = manifest.description;

    const sourceLabel = explicitSourceLabel ?? `vendored:${name}`;
    let lastSeenAt: string | null = null;
    try {
      const stat = statSync(primaryManifestPath);
      lastSeenAt = stat.mtime.toISOString();
    } catch {
      lastSeenAt = null;
    }

    return {
      id: explicitId,
      name,
      version,
      description,
      source,
      sourceLabel,
      runtimes,
      path: pluginPath,
      lastSeenAt,
    };
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readManifest(manifestPath: string): PluginManifestSummary | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    return {
      raw,
      name: typeof raw.name === "string" ? raw.name : null,
      version: typeof raw.version === "string" ? raw.version : null,
      description: typeof raw.description === "string" ? raw.description : null,
      homepage: typeof raw.homepage === "string" ? raw.homepage : null,
      repository: typeof raw.repository === "string" ? raw.repository : null,
      license: typeof raw.license === "string" ? raw.license : null,
    };
  } catch {
    return null;
  }
}

function extractHookEvents(hooksJsonPath: string): string[] {
  try {
    const data = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as { hooks?: Record<string, unknown> };
    if (data.hooks && typeof data.hooks === "object") {
      return Object.keys(data.hooks);
    }
  } catch {
    // best-effort
  }
  return [];
}

interface AgentYamlCandidate {
  path: string;
  content: string;
}

function walkAgentYamls(rootDir: string): AgentYamlCandidate[] {
  const out: AgentYamlCandidate[] = [];
  walk(rootDir);
  return out;

  function walk(dir: string): void {
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry);
      if (isDir(p)) {
        walk(p);
        continue;
      }
      if (entry === "agent.yaml" || entry === "agent.yml") {
        try {
          const content = readFileSync(p, "utf8");
          out.push({ path: p, content });
        } catch {
          // best-effort; skip unreadable files
        }
      }
    }
  }
}

function safeParseYaml(content: string): unknown {
  try {
    return parseYaml(content);
  } catch {
    return null;
  }
}

function readField(obj: unknown, field: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function readResourcesPlugins(spec: unknown): string[] {
  if (!spec || typeof spec !== "object") return [];
  const resources = (spec as Record<string, unknown>)["resources"];
  if (!resources || typeof resources !== "object") return [];
  const plugins = (resources as Record<string, unknown>)["plugins"];
  if (!Array.isArray(plugins)) return [];
  const ids: string[] = [];
  for (const p of plugins) {
    if (p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string") {
      ids.push((p as Record<string, unknown>).id as string);
    } else if (typeof p === "string") {
      // tolerate shorthand string form for forward-compat
      ids.push(p);
    }
  }
  return ids;
}

function readProfilesUsingPlugin(spec: unknown, pluginId: string): string[] {
  if (!spec || typeof spec !== "object") return [];
  const profiles = (spec as Record<string, unknown>)["profiles"];
  if (!profiles || typeof profiles !== "object") return [];
  const matched: string[] = [];
  for (const [profileName, profileVal] of Object.entries(profiles as Record<string, unknown>)) {
    if (!profileVal || typeof profileVal !== "object") continue;
    const uses = (profileVal as Record<string, unknown>)["uses"];
    if (!uses || typeof uses !== "object") continue;
    const usesPlugins = (uses as Record<string, unknown>)["plugins"];
    if (!Array.isArray(usesPlugins)) continue;
    if (usesPlugins.some((p) => p === pluginId)) {
      matched.push(profileName);
    }
  }
  return matched;
}
