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
// Slice 3.3 fix-C — `rig-cwd` source per DESIGN §5.4 union (4th category):
// rig-bundled `<cwd>/.claude/plugins/*` + `<cwd>/.codex/plugins/*` (the
// projection target from IMPL-PRD §1.2). velocity-qa VM verify failure #3.
export type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache" | "rig-cwd";

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
  /**
   * Slice 28 — number of skill folders shipped under `<plugin>/skills/`.
   * Surfaced in the list response so the PluginsIndexPage can render a
   * skill-count column without an N+1 detail fetch per plugin row.
   * Counted at detectPlugin time (one readdir of skills/).
   *
   * SC-29 EXCEPTION #11 (slice 28 library-explorer-finishing):
   * adds skillCount field to PluginEntry — additive shape change to
   * the plugin discovery API contract. Per banked inline-ledger
   * discipline; declared verbatim in routes/plugins.ts header.
   */
  skillCount: number;
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

// Slice 3.3 fix-A — MCP server discovery (DESIGN §5.7 + IMPL-PRD §3.2).
// MCP servers shipped via plugins are handled by the runtime's plugin
// loader; OpenRig only surfaces what the manifest declares so the UI
// viewer can list "this plugin ships these MCP servers." Implementation:
// read manifest.mcpServers (Claude/Codex spec key) and emit one summary
// per declared server. Best-effort: when the field is missing or shaped
// differently, we return [] rather than throwing.
export interface PluginMcpServerSummary {
  /** Which runtime manifest declared this MCP server. */
  runtime: PluginRuntime;
  /** Server name (object key in the manifest's mcpServers map). */
  name: string;
  /** Declared command if the entry is a stdio-style spec. */
  command: string | null;
  /** Declared transport (stdio/http/etc) if the entry exposes it. */
  transport: string | null;
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
  /**
   * MCP server declarations from claude/codex manifest's `mcpServers`
   * field. Slice 3.3 fix-A — velocity-qa VM verify failure #1.
   */
  mcpServers: PluginMcpServerSummary[];
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
  /**
   * Slice 3.3 fix-C — optional rig cwd roots whose `.claude/plugins/*` +
   * `.codex/plugins/*` subdirectories get scanned for rig-bundled
   * plugins (the projection target from IMPL-PRD §1.2). Default empty.
   * Population at v0 is per-call via listPlugins({ cwdScanRoots }) from
   * the API layer (?cwd=<path>); future slices may add automatic
   * enumeration from running-rig state.
   */
  cwdScanRoots?: string[];
}

export interface ListPluginsOpts {
  /** Filter to plugins supporting a specific runtime. */
  runtimeFilter?: PluginRuntime;
  /** Filter to plugins from a specific source root. */
  sourceFilter?: PluginSourceKind;
  /**
   * Slice 3.3 fix-C — per-call rig cwd roots; overrides constructor option.
   * Each cwd contributes `<cwd>/.claude/plugins/*` + `<cwd>/.codex/plugins/*`
   * discoveries labeled `rig-cwd:<plugin>`. The API layer passes a single
   * `?cwd=<path>` query param down here.
   */
  cwdScanRoots?: string[];
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

    // 4. Slice 3.3 fix-C — rig-bundled cwd plugin roots.
    // Per-call opts override constructor opts; effective cwd set is the
    // union when both are present (per-call wins by replacement, NOT
    // append-to-constructor, because the API layer's ?cwd=<path> intent
    // is "ALL plugins this specific rig sees" — predictable + cacheable).
    const effectiveCwds = filterOpts.cwdScanRoots ?? this.opts.cwdScanRoots ?? [];
    for (const cwd of effectiveCwds) {
      this.scanCwdBundledPlugins(cwd, out);
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

  // Slice 3.3 fix-C — scan a single rig cwd for `.claude/plugins/*` +
  // `.codex/plugins/*` bundles. Emits one PluginEntry per discovered
  // plugin manifest (matches the same detection rule as the other
  // source roots: presence of `.claude-plugin/plugin.json` and/or
  // `.codex-plugin/plugin.json` inside the plugin folder).
  private scanCwdBundledPlugins(cwd: string, out: PluginEntry[]): void {
    if (!existsSync(cwd)) return;
    const claudePluginsDir = join(cwd, ".claude", "plugins");
    if (existsSync(claudePluginsDir)) {
      for (const entry of safeReaddir(claudePluginsDir)) {
        const pluginPath = join(claudePluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const id = `rig-cwd:${cwd}/.claude/plugins/${entry}`;
        const sourceLabel = `rig-cwd:${basename(cwd)}/${entry}`;
        const detected = this.detectPlugin(pluginPath, "rig-cwd", id, sourceLabel);
        if (detected) out.push(detected);
      }
    }
    const codexPluginsDir = join(cwd, ".codex", "plugins");
    if (existsSync(codexPluginsDir)) {
      for (const entry of safeReaddir(codexPluginsDir)) {
        const pluginPath = join(codexPluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const id = `rig-cwd:${cwd}/.codex/plugins/${entry}`;
        const sourceLabel = `rig-cwd:${basename(cwd)}/${entry}`;
        const detected = this.detectPlugin(pluginPath, "rig-cwd", id, sourceLabel);
        if (detected) out.push(detected);
      }
    }
  }

  getPlugin(id: string): PluginDetail | null {
    // Slice 3.3 fix-iteration — rig-cwd: IDs are self-resolvable.
    // Pre-fix, getPlugin called this.listPlugins() (no opts), which
    // excluded rig-cwd entries because cwdScanRoots is empty by default.
    // Result: /api/plugins?cwd= returned a rig-cwd id, /api/plugins/:id
    // 404'd on the same id (redo-guard-2 BLOCK item 1). Fix: parse the
    // cwd out of the rig-cwd: prefix and pass it as cwdScanRoots so
    // the entry is in the list. ID format constructed in
    // scanCwdBundledPlugins:
    //   rig-cwd:<cwd>/.claude/plugins/<plugin>
    //   rig-cwd:<cwd>/.codex/plugins/<plugin>
    const cwdScanRoots = extractCwdFromRigCwdId(id);
    const entry = this.listPlugins(cwdScanRoots ? { cwdScanRoots } : {}).find((p) => p.id === id);
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

    // Slice 3.3 fix-A — MCP server discovery from each runtime's manifest.
    const mcpServers: PluginMcpServerSummary[] = [
      ...readMcpServers(claudeManifest, "claude"),
      ...readMcpServers(codexManifest, "codex"),
    ];

    return { entry, claudeManifest, codexManifest, skills, hooks, mcpServers };
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

    // Slice 28 — skillCount: count subdirectories under <plugin>/skills/.
    // Matches the detail-side enumeration in getPlugin() which also
    // collects subdirs under that path (no .md filtering at this level
    // — every shipped skill folder counts, whether or not it has
    // landed a SKILL.md yet).
    let skillCount = 0;
    const skillsDir = join(pluginPath, "skills");
    if (existsSync(skillsDir)) {
      for (const entry of safeReaddir(skillsDir)) {
        if (isDir(join(skillsDir, entry))) skillCount += 1;
      }
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
      skillCount,
    };
  }
}

// Slice 3.3 fix-iteration — parse cwd from a rig-cwd: id so getPlugin
// can re-scan that cwd before the lookup. Returns the cwd in a
// single-element array (caller passes as cwdScanRoots) or null when
// the id is not a rig-cwd: id, can't be parsed, or both manifest dir
// markers are absent. Tolerant of both `/.claude/plugins/` and
// `/.codex/plugins/` markers (whichever appears first wins; in the
// canonical id one of them is always present).
const RIG_CWD_PREFIX = "rig-cwd:";
const CLAUDE_MARKER = "/.claude/plugins/";
const CODEX_MARKER = "/.codex/plugins/";
function extractCwdFromRigCwdId(id: string): string[] | null {
  if (!id.startsWith(RIG_CWD_PREFIX)) return null;
  const rest = id.slice(RIG_CWD_PREFIX.length);
  const claudeIdx = rest.indexOf(CLAUDE_MARKER);
  const codexIdx = rest.indexOf(CODEX_MARKER);
  let cwd: string | null = null;
  if (claudeIdx >= 0 && (codexIdx < 0 || claudeIdx < codexIdx)) {
    cwd = rest.slice(0, claudeIdx);
  } else if (codexIdx >= 0) {
    cwd = rest.slice(0, codexIdx);
  }
  if (!cwd) return null;
  return [cwd];
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

// Slice 3.3 fix-A — read MCP server declarations from a manifest's
// `mcpServers` field. The Claude/Codex plugin spec convention is
// mcpServers: { <name>: { command, args, transport, ... } }. We
// surface the names + best-effort command/transport for the UI.
function readMcpServers(
  manifest: PluginManifestSummary | null,
  runtime: PluginRuntime,
): PluginMcpServerSummary[] {
  if (!manifest) return [];
  const raw = manifest.raw;
  if (!raw || typeof raw !== "object") return [];
  const mcpServers = (raw as Record<string, unknown>)["mcpServers"];
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return [];
  }
  const out: PluginMcpServerSummary[] = [];
  for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
    let command: string | null = null;
    let transport: string | null = null;
    if (value && typeof value === "object") {
      const config = value as Record<string, unknown>;
      if (typeof config.command === "string") command = config.command;
      if (typeof config.transport === "string") transport = config.transport;
    }
    out.push({ runtime, name, command, transport });
  }
  return out;
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
