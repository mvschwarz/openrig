import { Link } from "@tanstack/react-router";
import { PageHeader } from "../ui/page-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { usePlugins } from "../../hooks/usePlugins.js";

export function PluginsIndexPage() {
  const { data: plugins = [], isLoading } = usePlugins();
  const sorted = [...plugins].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      data-testid="plugins-index-page"
      className="mx-auto w-full max-w-[960px] px-6 py-8 text-sm"
    >
      <PageHeader
        title="Plugins"
        description="Claude Code and Codex plugins discovered on this host. Open one to browse its files."
        meta={
          <span data-testid="plugins-index-count" className="text-xs text-on-surface-variant">
            {isLoading ? "Loading" : `${sorted.length} ${sorted.length === 1 ? "plugin" : "plugins"}`}
          </span>
        }
      />

      {isLoading && sorted.length === 0 ? (
        <div data-testid="plugins-index-loading" className="text-xs text-on-surface-variant">
          Loading plugins…
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No plugins visible"
          label="No plugins visible"
          description="Plugins are discovered from Claude Code's global plugin cache, Codex's plugin cache, or OpenRig's vendored set (openrig-core ships with the daemon)."
          variant="card"
          testId="plugins-index-empty"
        />
      ) : (
        <ul data-testid="plugins-index-rows" className="divide-y divide-outline-variant rounded-lg border bg-surface-lowest shadow-sm">
          {sorted.map((plugin) => (
            <li key={plugin.id}>
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: plugin.id }}
                data-testid={`plugins-index-row-${plugin.id}`}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-low/60 focus:outline-none focus:bg-surface-low/80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="plugin" title={`${plugin.name} plugin`} size="xs" decorative />
                  <span className="truncate font-medium text-on-surface">{plugin.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-on-surface-variant">
                  <span data-testid={`plugins-index-row-${plugin.id}-version`}>v{plugin.version}</span>
                  <span data-testid={`plugins-index-row-${plugin.id}-runtimes`} className="flex gap-1">
                    {plugin.runtimes.map((rt) => (
                      <span key={rt} className="border border-outline-variant px-1.5 py-0.5">
                        {rt}
                      </span>
                    ))}
                  </span>
                  <span data-testid={`plugins-index-row-${plugin.id}-skillcount`}>
                    {plugin.skillCount} {plugin.skillCount === 1 ? "skill" : "skills"}
                  </span>
                  <span data-testid={`plugins-index-row-${plugin.id}-source`}>
                    {plugin.sourceLabel}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
