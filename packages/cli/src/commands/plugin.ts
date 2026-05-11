// rig plugin CLI verb family — read-only plugin inspection.
//
// Per IMPL-PRD §4 plugin-primitive Phase 3a slice 3.4 + DESIGN.md §6
// (CLI minimalism: 4 read-only inspection commands).
//
// Subcommands at slice 3.4 scope (this commit):
//   list                — aggregated view of discoverable plugins
//                         flags: --runtime claude|codex
//                                --source vendored|claude-cache|codex-cache
//                                --json
//   show <id>           — inspect manifest + skills + hooks + mcp servers
//                         flags: --json
//   used-by <id>        — agents referencing this plugin
//                         flags: --json
//   validate <path>     — local file inspection of a plugin source tree
//                         (manifest shape + skill frontmatter per agentskills.io)
//                         flags: --json
//
// list/show consume slice 3.3 daemon HTTP routes (GET /api/plugins[/...]).
//
// All commands ship --json output for agent consumption per banked
// building-agent-software + IMPL-PRD §4.4 HG-4.5.
//
// Wire shapes mirror slice 3.3 PluginDiscoveryService exports verbatim
// (packages/daemon/src/domain/plugin-discovery-service.ts L41-132). Types
// here are the wire contract; any drift from daemon source means the
// daemon shape changed and this file must update in lockstep.
//
// Flags NOT supported at v0 (deferred per velocity-guard 3.4.A blocker):
//   --used  — declared in PRD §4.2 but daemon route doesn't expose a
//             "filter to plugins referenced by an agent" filter; would
//             require client-side post-filter against /api/plugins +
//             /api/plugins/:id/used-by N+1 calls. Not in v0 scope.
//   --tree  — declared in PRD §4.2 but show output already prints the
//             tree structure (manifests + skills + hooks + mcp).
//             Distinct tree-only mode is post-v0 polish.
//   --source rig-cwd — daemon route's parseSourceFilter doesn't accept
//             rig-cwd; rig-cwd scan is enabled via separate ?cwd=<path>
//             query (out of scope for v0 since CLI doesn't have a "scan
//             this rig's cwd" surface yet).
//   --runtime both — daemon parseRuntimeFilter accepts only claude|codex;
//             omitting --runtime returns all (the "both" semantic is
//             default no-filter).
// Each of these surfaces in a future slice; CLI flag declarations are
// tightly scoped to what the daemon actually supports.

import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// Filter-value enums per slice-3.3 daemon route validation
// (packages/daemon/src/routes/plugins.ts L37-58). CLI-side validation
// gives operators clear errors instead of silent pass-through where the
// daemon ignores unknown values.
const VALID_RUNTIMES = ["claude", "codex"] as const;
const VALID_SOURCES = ["vendored", "claude-cache", "codex-cache"] as const;

// ============================================================
// Wire shapes — must mirror PluginDiscoveryService verbatim
// (packages/daemon/src/domain/plugin-discovery-service.ts L41-132)
// ============================================================

type PluginRuntime = "claude" | "codex";
type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache" | "rig-cwd";

interface PluginEntryWire {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: PluginSourceKind;
  sourceLabel: string;
  runtimes: PluginRuntime[];
  path: string;
  lastSeenAt: string | null;
}

interface PluginManifestSummaryWire {
  raw: Record<string, unknown>;
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

interface PluginSkillSummaryWire {
  name: string;
  relativePath: string;
}

interface PluginHookSummaryWire {
  runtime: PluginRuntime;
  relativePath: string;
  events: string[];
}

interface PluginMcpServerSummaryWire {
  runtime: PluginRuntime;
  name: string;
  command: string | null;
  transport: string | null;
}

interface PluginDetailWire {
  entry: PluginEntryWire;
  claudeManifest: PluginManifestSummaryWire | null;
  codexManifest: PluginManifestSummaryWire | null;
  skills: PluginSkillSummaryWire[];
  hooks: PluginHookSummaryWire[];
  mcpServers: PluginMcpServerSummaryWire[];
}

// AgentReference per PluginDiscoveryService L134-141 verbatim.
interface AgentReferenceWire {
  agentName: string;
  sourcePath: string;
  profiles: string[];
}

export function pluginCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("plugin");
  cmd.description("Inspect plugins (read-only)");

  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      throw new Error("Daemon not running. Start it with: rig daemon start");
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  // -- rig plugin list --
  cmd.command("list")
    .description("List discoverable plugins (aggregated across vendored + runtime caches)")
    .option("--runtime <runtime>", "Filter by runtime support: claude | codex (omit for all)")
    .option("--source <source>", "Filter by source: vendored | claude-cache | codex-cache")
    .option("--json", "JSON output")
    .action(async (opts: { runtime?: string; source?: string; json?: boolean }) => {
      try {
        // CLI-side filter-value validation per pre-close punch from velocity-guard
        // 3.4.A repair verdict: typos like --source rig-cwd should fail loud,
        // not silently be ignored by the daemon route.
        if (opts.runtime && !(VALID_RUNTIMES as readonly string[]).includes(opts.runtime)) {
          throw new Error(`Invalid --runtime value "${opts.runtime}". Valid: ${VALID_RUNTIMES.join(" | ")} (omit flag for all)`);
        }
        if (opts.source && !(VALID_SOURCES as readonly string[]).includes(opts.source)) {
          throw new Error(`Invalid --source value "${opts.source}". Valid: ${VALID_SOURCES.join(" | ")}`);
        }

        const client = await getClient();
        const params: string[] = [];
        if (opts.runtime) params.push(`runtime=${encodeURIComponent(opts.runtime)}`);
        if (opts.source) params.push(`source=${encodeURIComponent(opts.source)}`);
        const path = `/api/plugins${params.length > 0 ? `?${params.join("&")}` : ""}`;
        const res = await client.get<PluginEntryWire[]>(path);
        const entries = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        if (entries.length === 0) {
          console.log("No plugins discovered.");
          return;
        }

        for (const e of entries) {
          const runtimesStr = e.runtimes.join(",");
          // Real fields only: id, version, runtimes, sourceLabel, path
          console.log(
            `${e.id.padEnd(28)} v${String(e.version).padEnd(8)} ` +
            `[${runtimesStr.padEnd(13)}] ${e.sourceLabel.padEnd(36)} ` +
            `${e.path}`
          );
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // -- rig plugin show <id> --
  cmd.command("show")
    .argument("<id>", "Plugin id (e.g., openrig-core)")
    .description("Show plugin manifest + skills + hooks + mcp servers")
    .option("--json", "JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.get<PluginDetailWire>(`/api/plugins/${encodeURIComponent(id)}`);
        if (res.status === 404) {
          throw new Error(`Plugin not found: "${id}"`);
        }
        if (res.status !== 200 || !res.data) {
          throw new Error(`Daemon returned HTTP ${res.status}`);
        }
        const detail = res.data;

        if (opts.json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }

        const entry = detail.entry;
        console.log(`Id:          ${entry.id}`);
        console.log(`Name:        ${entry.name}`);
        console.log(`Version:     ${entry.version}`);
        console.log(`Description: ${entry.description ?? "(none)"}`);
        console.log(`Source:      ${entry.sourceLabel}`);
        console.log(`Path:        ${entry.path}`);
        console.log(`Runtimes:    ${entry.runtimes.join(", ")}`);
        if (entry.lastSeenAt) {
          console.log(`Last seen:   ${entry.lastSeenAt}`);
        }
        console.log("");

        // Manifests — real PluginManifestSummary fields
        console.log("Manifests:");
        if (detail.claudeManifest) {
          const m = detail.claudeManifest;
          const parts: string[] = [];
          if (m.name) parts.push(`name=${m.name}`);
          if (m.version) parts.push(`version=${m.version}`);
          if (m.license) parts.push(`license=${m.license}`);
          if (m.repository) parts.push(`repo=${m.repository}`);
          console.log(`  claude:    ${parts.join(" ") || "(present)"}`);
        }
        if (detail.codexManifest) {
          const m = detail.codexManifest;
          const parts: string[] = [];
          if (m.name) parts.push(`name=${m.name}`);
          if (m.version) parts.push(`version=${m.version}`);
          if (m.license) parts.push(`license=${m.license}`);
          if (m.repository) parts.push(`repo=${m.repository}`);
          console.log(`  codex:     ${parts.join(" ") || "(present)"}`);
        }
        if (!detail.claudeManifest && !detail.codexManifest) {
          console.log("  (none)");
        }

        // Skills — PluginSkillSummary has name + relativePath only
        console.log("");
        console.log(`Skills (${detail.skills.length}):`);
        for (const s of detail.skills) {
          console.log(`  ${s.name.padEnd(40)} ${s.relativePath}`);
        }

        // Hooks — PluginHookSummary has runtime + relativePath + events[]
        console.log("");
        console.log(`Hooks (${detail.hooks.length}):`);
        for (const h of detail.hooks) {
          const eventList = h.events.length > 0 ? h.events.join(",") : "(none)";
          console.log(`  ${h.runtime.padEnd(10)} ${String(h.events.length).padStart(2)} events  [${eventList}]  ${h.relativePath}`);
        }

        // MCP servers
        if (detail.mcpServers.length > 0) {
          console.log("");
          console.log(`MCP servers (${detail.mcpServers.length}):`);
          for (const m of detail.mcpServers) {
            const detail2: string[] = [];
            if (m.transport) detail2.push(`transport=${m.transport}`);
            if (m.command) detail2.push(`command=${m.command}`);
            console.log(`  ${m.runtime.padEnd(10)} ${m.name.padEnd(28)} ${detail2.join(" ")}`);
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // -- rig plugin used-by <id> --
  cmd.command("used-by")
    .argument("<id>", "Plugin id (e.g., openrig-core)")
    .description("List agents referencing this plugin in their profile.uses.plugins[]")
    .option("--json", "JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.get<AgentReferenceWire[]>(`/api/plugins/${encodeURIComponent(id)}/used-by`);
        if (res.status !== 200) {
          throw new Error(`Daemon returned HTTP ${res.status}`);
        }
        const refs = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(refs, null, 2));
          return;
        }

        if (refs.length === 0) {
          console.log(`No agents reference plugin "${id}".`);
          return;
        }

        for (const r of refs) {
          const profilesStr = r.profiles.length > 0 ? r.profiles.join(",") : "(none)";
          console.log(`${r.agentName.padEnd(36)} [${profilesStr.padEnd(20)}] ${r.sourcePath}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // -- rig plugin validate <path> --
  // Local file inspection — no daemon dependency; useful when authoring
  // a plugin in a feature branch where the daemon may not yet have
  // discovered it. Validates manifest shape (per Claude/Codex specs)
  // + skill frontmatter (per agentskills.io: name + description ≤1024 chars).
  cmd.command("validate")
    .argument("<path>", "Plugin source directory to validate")
    .description("Validate plugin manifest + skill frontmatter against agentskills.io spec")
    .option("--json", "JSON output ({ valid: boolean, errors: string[] })")
    .action((path: string, opts: { json?: boolean }) => {
      const errors = validatePluginTree(path);
      const valid = errors.length === 0;

      if (opts.json) {
        console.log(JSON.stringify({ valid, errors }, null, 2));
        process.exitCode = valid ? undefined : 1;
        return;
      }

      if (valid) {
        console.log(`Plugin at ${path}: valid`);
        return;
      }

      console.error(`Plugin at ${path}: INVALID (${errors.length} error${errors.length === 1 ? "" : "s"})`);
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      process.exitCode = 1;
    });

  return cmd;
}

// ============================================================
// validate plumbing — local file inspection
// ============================================================

function validatePluginTree(pluginPath: string): string[] {
  const errors: string[] = [];

  if (!existsSync(pluginPath)) {
    errors.push(`Plugin path does not exist: ${pluginPath}`);
    return errors;
  }
  if (!statSync(pluginPath).isDirectory()) {
    errors.push(`Plugin path is not a directory: ${pluginPath}`);
    return errors;
  }

  const claudeManifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
  const codexManifestPath = join(pluginPath, ".codex-plugin", "plugin.json");
  const hasClaude = existsSync(claudeManifestPath);
  const hasCodex = existsSync(codexManifestPath);

  if (!hasClaude && !hasCodex) {
    errors.push("No plugin manifest found: expected .claude-plugin/plugin.json and/or .codex-plugin/plugin.json");
    return errors;
  }

  if (hasClaude) {
    errors.push(...validateManifest(claudeManifestPath, "claude"));
  }
  if (hasCodex) {
    errors.push(...validateManifest(codexManifestPath, "codex"));
  }

  // Validate skill frontmatter
  const skillsDir = join(pluginPath, "skills");
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const skillId of readdirSync(skillsDir)) {
      const skillMdPath = join(skillsDir, skillId, "SKILL.md");
      if (existsSync(skillMdPath)) {
        errors.push(...validateSkillFrontmatter(skillMdPath, skillId));
      }
    }
  }

  return errors;
}

function validateManifest(manifestPath: string, runtime: "claude" | "codex"): string[] {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    errors.push(`${runtime} manifest parse error at ${manifestPath}: ${(err as Error).message}`);
    return errors;
  }
  // Guard non-object/null parse results — JSON.parse('null') returns null,
  // JSON.parse('[1,2]') returns an array — both must fail validation, not crash.
  if (!isPlainObject(parsed)) {
    errors.push(`${runtime} manifest at ${manifestPath} must be a JSON object (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`);
    return errors;
  }
  const raw = parsed;
  if (typeof raw["name"] !== "string" || raw["name"].trim().length === 0) {
    errors.push(`${runtime} manifest missing required field: name (must be non-empty string)`);
  }
  if (typeof raw["version"] !== "string" || raw["version"].trim().length === 0) {
    errors.push(`${runtime} manifest missing required field: version (must be non-empty string)`);
  }
  // Codex spec: description is REQUIRED. Claude spec: description is recommended but
  // not a hard requirement; we treat missing description as a warning by NOT erroring
  // on Claude-only-missing-description while erroring on Codex-missing-description.
  if (runtime === "codex" && (typeof raw["description"] !== "string" || raw["description"].trim().length === 0)) {
    errors.push(`codex manifest missing required field: description (Codex spec requires it)`);
  }
  return errors;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSkillFrontmatter(skillPath: string, skillId: string): string[] {
  const errors: string[] = [];
  let content: string;
  try {
    content = readFileSync(skillPath, "utf-8");
  } catch (err) {
    errors.push(`skill "${skillId}": failed to read SKILL.md: ${(err as Error).message}`);
    return errors;
  }
  // Frontmatter: file MUST start with `---\n` and contain a closing `---` line
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    errors.push(`skill "${skillId}": SKILL.md missing frontmatter (must open with --- ... ---)`);
    return errors;
  }
  const fmBody = fmMatch[1] ?? "";

  // Parse frontmatter as YAML — regex-based validation can pass quoted-empty
  // values and miss type errors per velocity-guard 3.4.C BLOCKING-CONCERN.
  let parsed: unknown;
  try {
    parsed = parseYaml(fmBody);
  } catch (err) {
    errors.push(`skill "${skillId}": invalid YAML frontmatter: ${(err as Error).message}`);
    return errors;
  }
  if (!isPlainObject(parsed)) {
    errors.push(`skill "${skillId}": frontmatter must be a YAML object/map (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`);
    return errors;
  }

  // Required: name (non-empty string after trim)
  const name = parsed["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    errors.push(`skill "${skillId}": frontmatter missing required field: name (must be non-empty string)`);
  }

  // Required: description (non-empty string after trim; ≤1024 chars per agentskills.io)
  const description = parsed["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push(`skill "${skillId}": frontmatter missing required field: description (must be non-empty string)`);
  } else if (description.trim().length > 1024) {
    errors.push(`skill "${skillId}": description length ${description.trim().length} chars exceeds agentskills.io limit of 1024`);
  }

  return errors;
}
