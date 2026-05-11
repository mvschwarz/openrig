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
//
// Pending in later checkpoints of slice 3.4:
//   used-by <id>        — agents referencing this plugin (3.4.B)
//   validate <path>     — local file inspection (3.4.C)
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
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

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

  return cmd;
}
