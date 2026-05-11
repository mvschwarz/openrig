// Phase 3a slice 3.3 — AgentPluginsList enrichment component.
//
// Standalone helper that takes a list of plugin IDs (from agent.yaml's
// resources.plugins[].id field, on plugin-primitive-v0 branch) and
// renders enriched chips with:
//   - plugin name + version
//   - runtime support badges (claude / codex)
//   - source label provenance
//   - view-in-library link to /plugins/:pluginId
//
// At slice 3.3 close this component is standalone — NOT yet wired into
// AgentSpecDisplay because batch 1 of the plugin-primitive mission owns
// that file on plugin-primitive-v0 branch (slice 3.3 ships on
// plugin-primitive-3-3-ui off main per dispatch).
//
// At merge-time into plugin-primitive-v0, batch 1's AgentSpecDisplay
// Plugins block (which currently renders plugin IDs as static chips
// per their ACK §2) will consume this component to upgrade to enriched
// chips with manifest data + library navigation. The wiring is a
// 1-line replacement of the inline chip block with `<AgentPluginsList
// pluginIds={profile.uses.plugins} />`.

import { Link } from "@tanstack/react-router";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { EmptyState } from "../ui/empty-state.js";
import { usePlugins, type PluginEntry } from "../../hooks/usePlugins.js";

interface AgentPluginsListProps {
  /** Plugin IDs from the agent's resources.plugins[].id (or the resolved
   *  set from profile.uses.plugins[] — caller's choice). */
  pluginIds: string[];
}

export function AgentPluginsList({ pluginIds }: AgentPluginsListProps) {
  const { data: discovered = [] } = usePlugins();

  if (pluginIds.length === 0) {
    return (
      <div className="px-3 py-4">
        <EmptyState
          label="NO PLUGINS"
          description="This agent's profile does not declare any plugins."
          variant="card"
          testId="agent-plugins-empty"
        />
      </div>
    );
  }

  const lookup = new Map<string, PluginEntry>();
  for (const entry of discovered) lookup.set(entry.id, entry);

  return (
    <ul
      data-testid="agent-plugins-list"
      className="flex flex-col gap-2"
    >
      {pluginIds.map((id) => {
        const entry = lookup.get(id);
        return (
          <li key={id}>
            {entry ? (
              <ResolvedChip entry={entry} />
            ) : (
              <UnresolvedChip pluginId={id} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ResolvedChip({ entry }: { entry: PluginEntry }) {
  return (
    <Link
      to="/plugins/$pluginId"
      params={{ pluginId: entry.id }}
      data-testid={`agent-plugin-chip-${entry.id}`}
      className="flex items-center justify-between gap-3 border border-outline-variant bg-white/30 px-3 py-2 font-mono text-[11px] hover:bg-stone-100/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ToolMark tool="skill" title={`${entry.name} plugin`} size="xs" decorative />
        <span className="truncate text-xs font-bold text-stone-900">{entry.name}</span>
        <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-stone-500">
          {`v${entry.version}`}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[9px] uppercase tracking-[0.08em] text-stone-500">
        {entry.runtimes.map((rt) => (
          <span
            key={rt}
            className="inline-block border border-outline-variant px-1.5 py-0.5 font-mono"
          >
            {rt}
          </span>
        ))}
        <span title={entry.path}>{entry.sourceLabel}</span>
      </span>
    </Link>
  );
}

function UnresolvedChip({ pluginId }: { pluginId: string }) {
  return (
    <Link
      to="/plugins/$pluginId"
      params={{ pluginId }}
      data-testid={`agent-plugin-chip-${pluginId}`}
      className="flex items-center justify-between gap-3 border border-dashed border-outline-variant bg-white/20 px-3 py-2 font-mono text-[11px] hover:bg-stone-100/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ToolMark tool="skill" title={`${pluginId} plugin (unresolved)`} size="xs" decorative />
        <span className="truncate text-xs font-bold text-stone-900">{pluginId}</span>
      </span>
      <span
        data-testid={`agent-plugin-unresolved-${pluginId}`}
        className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-stone-500"
      >
        not discovered
      </span>
    </Link>
  );
}
