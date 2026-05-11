// Slice 18 — Plugins top-level Library index.
//
// Second consumer of the LibraryTopLevelEntry primitive (after Skills).
// Mounts at /specs/plugins, reads usePlugins, groups by source
// (vendored / claude-cache / codex-cache), navigates to existing
// /plugins/$pluginId detail route on row click. Treats vendored entries
// as built-ins (always shipped with openrig-core); cache entries as
// user-installed.

import { useNavigate } from "@tanstack/react-router";
import { LibraryTopLevelEntry } from "./LibraryTopLevelEntry.js";
import { usePlugins, type PluginEntry } from "../../hooks/usePlugins.js";

function formatPluginFolder(source: unknown): string {
  if (source === "vendored") return "Vendored (openrig-core)";
  if (source === "claude-cache") return "Claude cache";
  if (source === "codex-cache") return "Codex cache";
  return String(source ?? "Other");
}

function PluginsEmptyState() {
  return (
    <div
      data-testid="plugins-empty-state"
      className="border border-outline-variant bg-white/25 px-4 py-6 font-mono text-xs leading-relaxed text-stone-700"
    >
      <p className="font-bold uppercase tracking-wide text-stone-900">No user-installed plugins</p>
      <p className="mt-2">
        Plugins are loaded from Claude Code's global plugin cache, Codex's plugin cache, or from
        OpenRig's vendored set (the openrig-core plugin shipped with the daemon).
      </p>
      <p className="mt-2">
        Install a plugin into <code className="font-mono text-stone-900">~/.claude/plugins</code> or
        <code className="font-mono text-stone-900"> ~/.codex/plugins</code> and refresh — it will
        appear here once the discovery service picks it up.
      </p>
    </div>
  );
}

export function PluginsIndexPage() {
  const { data: plugins = [], isLoading } = usePlugins();
  const navigate = useNavigate();

  const handlePluginClick = (plugin: PluginEntry) => {
    navigate({ to: "/plugins/$pluginId", params: { pluginId: plugin.id } });
  };

  return (
    <LibraryTopLevelEntry<PluginEntry>
      slug="plugins"
      displayName="Plugins"
      iconKind="plugin"
      items={plugins}
      folderField="source"
      formatFolderLabel={formatPluginFolder}
      emptyState={<PluginsEmptyState />}
      onItemClick={handlePluginClick}
      isLoading={isLoading}
      isUserDefined={(plugin) => plugin.source !== "vendored"}
    />
  );
}
