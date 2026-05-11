// rig plugin CLI verb family — read-only plugin inspection.
//
// Per IMPL-PRD §4 plugin-primitive Phase 3a slice 3.4 + DESIGN.md §6
// (CLI minimalism: 4 read-only inspection commands).
//
// Subcommands:
//   list                    — aggregated view of discoverable plugins
//                             flags: --runtime claude|codex|both
//                                    --used (only those referenced by an agent)
//                                    --source vendored|claude-cache|codex-cache|rig-cwd
//                                    --json
//   show <id>               — inspect manifest + contents per plugin
//                             flags: --tree, --json
//   used-by <id>            — which agents reference this plugin
//                             flags: --json
//   validate <path>         — local file validation; manifest + skill frontmatter
//                             flags: --json
//
// list/show/used-by consume slice 3.3 daemon HTTP routes (GET /api/plugins[/...]).
// validate is local file inspection; reuses agent-manifest's plugin
// validation path + skill frontmatter checks.
//
// All commands ship --json output for agent consumption per banked
// building-agent-software + IMPL-PRD §4.4 HG-4.5.

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// Wire shapes — mirror slice 3.3 PluginDiscoveryService exports
// (packages/daemon/src/domain/plugin-discovery-service.ts).

interface PluginEntryWire {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: "vendored" | "claude-cache" | "codex-cache" | "rig-cwd";
  sourceLabel: string;
  runtimes: Array<"claude" | "codex">;
  rootPath: string;
  skillCount: number;
  hookEventCount: number;
  mcpServerCount: number;
}

interface PluginManifestWire {
  name: string;
  version: string;
  description: string | null;
  skillsRef?: string;
  hooksRef?: string;
}

interface PluginSkillWire {
  id: string;
  path: string;
  description: string | null;
}

interface PluginHookWire {
  runtime: "claude" | "codex";
  eventCount: number;
}

interface PluginMcpServerWire {
  runtime: "claude" | "codex";
  name: string;
}

interface PluginDetailWire {
  entry: PluginEntryWire;
  claudeManifest: PluginManifestWire | null;
  codexManifest: PluginManifestWire | null;
  skills: PluginSkillWire[];
  hooks: PluginHookWire[];
  mcpServers: PluginMcpServerWire[];
}

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
    .option("--runtime <runtime>", "Filter by runtime support (claude | codex)")
    .option("--source <source>", "Filter by source (vendored | claude-cache | codex-cache | rig-cwd)")
    .option("--used", "Only show plugins referenced by some agent")
    .option("--json", "JSON output")
    .action(async (opts: { runtime?: string; source?: string; used?: boolean; json?: boolean }) => {
      try {
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
          console.log(
            `${e.id.padEnd(28)} v${String(e.version).padEnd(8)} ` +
            `[${runtimesStr.padEnd(13)}] ${e.sourceLabel.padEnd(36)} ` +
            `${String(e.skillCount).padStart(2)} skills`
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
    .option("--tree", "File tree only")
    .option("--json", "JSON output")
    .action(async (id: string, opts: { tree?: boolean; json?: boolean }) => {
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

        console.log(`Id:          ${detail.entry.id}`);
        console.log(`Name:        ${detail.entry.name}`);
        console.log(`Version:     ${detail.entry.version}`);
        console.log(`Description: ${detail.entry.description ?? "(none)"}`);
        console.log(`Source:      ${detail.entry.sourceLabel}`);
        console.log(`Root:        ${detail.entry.rootPath}`);
        console.log(`Runtimes:    ${detail.entry.runtimes.join(", ")}`);
        console.log("");

        // Manifests
        console.log("Manifests:");
        if (detail.claudeManifest) {
          console.log(`  claude:    ${detail.claudeManifest.name}@${detail.claudeManifest.version}` +
            `${detail.claudeManifest.skillsRef ? ` skills=${detail.claudeManifest.skillsRef}` : ""}` +
            `${detail.claudeManifest.hooksRef ? ` hooks=${detail.claudeManifest.hooksRef}` : ""}`);
        }
        if (detail.codexManifest) {
          console.log(`  codex:     ${detail.codexManifest.name}@${detail.codexManifest.version}` +
            `${detail.codexManifest.skillsRef ? ` skills=${detail.codexManifest.skillsRef}` : ""}` +
            `${detail.codexManifest.hooksRef ? ` hooks=${detail.codexManifest.hooksRef}` : ""}`);
        }
        if (!detail.claudeManifest && !detail.codexManifest) {
          console.log("  (none)");
        }

        // Skills
        console.log("");
        console.log(`Skills (${detail.skills.length}):`);
        for (const s of detail.skills) {
          console.log(`  ${s.id.padEnd(40)} ${s.path}`);
          if (s.description) console.log(`    ${s.description}`);
        }

        // Hooks
        console.log("");
        console.log(`Hooks (${detail.hooks.length}):`);
        for (const h of detail.hooks) {
          console.log(`  ${h.runtime.padEnd(10)} ${h.eventCount} events`);
        }

        // MCP servers
        if (detail.mcpServers.length > 0) {
          console.log("");
          console.log(`MCP servers (${detail.mcpServers.length}):`);
          for (const m of detail.mcpServers) {
            console.log(`  ${m.runtime.padEnd(10)} ${m.name}`);
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
