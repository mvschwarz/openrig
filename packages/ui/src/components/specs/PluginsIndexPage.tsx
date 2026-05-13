import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { usePlugins } from "../../hooks/usePlugins.js";

export function PluginsIndexPage() {
  const { data: plugins = [], isLoading } = usePlugins();
  const sorted = [...plugins].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      data-testid="plugins-index-page"
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Library</SectionHeader>
        <div className="mt-1 flex items-baseline justify-between">
          <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900">
            Plugins
          </h1>
          <span data-testid="plugins-index-count" className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500">
            {isLoading ? "loading" : `${sorted.length} ${sorted.length === 1 ? "plugin" : "plugins"}`}
          </span>
        </div>
      </header>

      {isLoading && sorted.length === 0 ? (
        <div data-testid="plugins-index-loading" className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500">
          Loading plugins…
        </div>
      ) : sorted.length === 0 ? (
        <div
          data-testid="plugins-index-empty"
          className="border border-outline-variant bg-white/25 px-4 py-6 font-mono text-xs leading-relaxed text-stone-700"
        >
          <p className="font-bold uppercase tracking-wide text-stone-900">No plugins visible</p>
          <p className="mt-2">
            Plugins are discovered from Claude Code's global plugin cache, Codex's plugin cache, or
            OpenRig's vendored set (openrig-core ships with the daemon).
          </p>
        </div>
      ) : (
        <ul data-testid="plugins-index-rows" className="border border-outline-variant bg-white/25 hard-shadow divide-y divide-outline-variant">
          {sorted.map((plugin) => (
            <li key={plugin.id}>
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: plugin.id }}
                data-testid={`plugins-index-row-${plugin.id}`}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 font-mono text-left hover:bg-stone-100/60 focus:outline-none focus:bg-stone-100/80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="plugin" title={`${plugin.name} plugin`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-stone-900">{plugin.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
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
