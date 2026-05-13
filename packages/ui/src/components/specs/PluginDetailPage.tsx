import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { usePlugin, usePluginUsedBy } from "../../hooks/usePlugins.js";

interface PluginDetailPageProps {
  pluginId: string;
}

// Virtual tree node tokens. Each token maps to a viewer panel; the
// docs-browser shell drives selection by token. Skills sub-tokens follow
// the shape `skill:<name>` so each skill row is its own selectable entry.
type NodeToken =
  | "manifest"
  | "skills-root"
  | `skill:${string}`
  | "hooks-root"
  | `hook:${string}`
  | "mcp-root"
  | `mcp:${string}`
  | "used-by";

export function PluginDetailPage({ pluginId }: PluginDetailPageProps) {
  const { data: detail, isLoading: detailLoading, error: detailError } = usePlugin(pluginId);
  const { data: usedBy = [], isLoading: usedByLoading } = usePluginUsedBy(pluginId);
  const [selected, setSelected] = useState<NodeToken>("manifest");

  if (detailLoading) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="LOADING PLUGIN"
          description="Loading plugin manifest from discovery service."
          variant="card"
          testId="plugin-detail-loading"
        />
      </div>
    );
  }

  if (detailError || !detail) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="PLUGIN NOT FOUND"
          description="The selected plugin is not visible through any configured discovery source."
          variant="card"
          testId="plugin-detail-not-found"
        />
      </div>
    );
  }

  const entry = detail.entry;

  return (
    <div
      data-testid="plugin-detail-page"
      className="h-full overflow-hidden bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-4">
        <SectionHeader tone="muted">Plugin</SectionHeader>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="font-headline text-2xl font-bold tracking-tight text-stone-900">
            {entry.name}
          </h1>
          <span className="font-mono text-sm text-stone-600">v{entry.version}</span>
          {entry.runtimes.map((rt) => (
            <span
              key={rt}
              data-testid={`plugin-detail-runtime-${rt}`}
              className="inline-block border border-outline-variant bg-white/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-700"
            >
              {rt}
            </span>
          ))}
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500"
            title={entry.path}
          >
            {entry.sourceLabel}
          </span>
        </div>
        {entry.description && (
          <p className="mt-2 max-w-3xl text-sm text-stone-600">{entry.description}</p>
        )}
      </header>

      <div
        data-testid="plugin-detail-docs-browser"
        className="flex h-[calc(100%-7rem)] flex-col border border-outline-variant bg-white/25 hard-shadow sm:flex-row"
      >
        <aside
          data-testid="plugin-detail-tree"
          className="w-full max-h-64 shrink-0 overflow-y-auto border-b border-outline-variant bg-white/30 sm:w-72 sm:max-h-none sm:border-b-0 sm:border-r"
        >
          <PluginTree detail={detail} selected={selected} onSelect={setSelected} usedByCount={usedBy.length} />
        </aside>
        <main data-testid="plugin-detail-viewer" className="flex-1 min-w-0 overflow-y-auto bg-white">
          <PluginViewer
            detail={detail}
            selected={selected}
            usedBy={usedBy}
            usedByLoading={usedByLoading}
          />
        </main>
      </div>
    </div>
  );
}

function PluginTree({
  detail,
  selected,
  onSelect,
  usedByCount,
}: {
  detail: NonNullable<ReturnType<typeof usePlugin>["data"]>;
  selected: NodeToken;
  onSelect: (token: NodeToken) => void;
  usedByCount: number;
}) {
  const skills = detail.skills;
  const hooks = detail.hooks;
  const mcpServers = detail.mcpServers;
  const skillsOpen = useMemo(() => selected === "skills-root" || selected.startsWith("skill:"), [selected]);
  const hooksOpen = useMemo(() => selected === "hooks-root" || selected.startsWith("hook:"), [selected]);
  const mcpOpen = useMemo(() => selected === "mcp-root" || selected.startsWith("mcp:"), [selected]);

  return (
    <ul className="p-1 font-mono text-[10px]">
      <TreeRow
        token="manifest"
        label="manifest"
        selected={selected}
        onSelect={onSelect}
        meta={detail.claudeManifest || detail.codexManifest ? null : "(none)"}
      />
      <TreeRow
        token="skills-root"
        label="skills/"
        selected={selected}
        onSelect={onSelect}
        meta={`${skills.length}`}
        expanded={skillsOpen}
      />
      {skillsOpen && skills.length > 0 && (
        <ul className="ml-4 border-l border-outline-variant">
          {skills.map((skill) => (
            <TreeRow
              key={`skill:${skill.name}`}
              token={`skill:${skill.name}`}
              label={skill.name}
              selected={selected}
              onSelect={onSelect}
              indent
              meta={null}
            />
          ))}
        </ul>
      )}
      <TreeRow
        token="hooks-root"
        label="hooks/"
        selected={selected}
        onSelect={onSelect}
        meta={`${hooks.length}`}
        expanded={hooksOpen}
      />
      {hooksOpen && hooks.length > 0 && (
        <ul className="ml-4 border-l border-outline-variant">
          {hooks.map((hook) => (
            <TreeRow
              key={`hook:${hook.runtime}`}
              token={`hook:${hook.runtime}`}
              label={hook.runtime}
              selected={selected}
              onSelect={onSelect}
              indent
              meta={null}
            />
          ))}
        </ul>
      )}
      {mcpServers.length > 0 && (
        <>
          <TreeRow
            token="mcp-root"
            label="mcp servers"
            selected={selected}
            onSelect={onSelect}
            meta={`${mcpServers.length}`}
            expanded={mcpOpen}
          />
          {mcpOpen && (
            <ul className="ml-4 border-l border-outline-variant">
              {mcpServers.map((server) => (
                <TreeRow
                  key={`mcp:${server.runtime}:${server.name}`}
                  token={`mcp:${server.runtime}:${server.name}`}
                  label={`${server.runtime}/${server.name}`}
                  selected={selected}
                  onSelect={onSelect}
                  indent
                  meta={null}
                />
              ))}
            </ul>
          )}
        </>
      )}
      <TreeRow
        token="used-by"
        label="used by"
        selected={selected}
        onSelect={onSelect}
        meta={`${usedByCount}`}
      />
    </ul>
  );
}

function TreeRow({
  token,
  label,
  selected,
  onSelect,
  meta,
  indent,
  expanded,
}: {
  token: NodeToken;
  label: string;
  selected: NodeToken;
  onSelect: (token: NodeToken) => void;
  meta?: string | null;
  indent?: boolean;
  expanded?: boolean;
}) {
  const isSelected = selected === token;
  return (
    <li>
      <button
        type="button"
        data-testid={`plugin-detail-tree-${token}`}
        data-active={isSelected}
        data-expanded={expanded ?? false}
        onClick={() => onSelect(token)}
        className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-stone-100 ${
          isSelected ? "bg-stone-200/80 text-stone-900" : "text-stone-700"
        } ${indent ? "pl-3" : ""}`}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <ToolMark tool={label} size="xs" title={label} decorative />
          <span className="truncate">{label}</span>
        </span>
        {meta && (
          <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">{meta}</span>
        )}
      </button>
    </li>
  );
}

function PluginViewer({
  detail,
  selected,
  usedBy,
  usedByLoading,
}: {
  detail: NonNullable<ReturnType<typeof usePlugin>["data"]>;
  selected: NodeToken;
  usedBy: { agentName: string; sourcePath: string; profiles: string[] }[];
  usedByLoading: boolean;
}) {
  if (selected === "manifest") return <ManifestPanel detail={detail} />;
  if (selected === "skills-root") return <SkillsRootPanel detail={detail} />;
  if (selected.startsWith("skill:")) return <SkillPanel detail={detail} skillName={selected.slice("skill:".length)} />;
  if (selected === "hooks-root") return <HooksRootPanel detail={detail} />;
  if (selected.startsWith("hook:")) return <HookPanel detail={detail} runtime={selected.slice("hook:".length)} />;
  if (selected === "mcp-root") return <McpRootPanel detail={detail} />;
  if (selected.startsWith("mcp:")) {
    const [runtime = "", ...nameParts] = selected.slice("mcp:".length).split(":");
    return <McpServerPanel detail={detail} runtime={runtime} name={nameParts.join(":")} />;
  }
  if (selected === "used-by") return <UsedByPanel usedBy={usedBy} isLoading={usedByLoading} />;
  return null;
}

function ManifestPanel({ detail }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]> }) {
  return (
    <section data-testid="plugin-viewer-manifest" className="p-4">
      <SectionHeader tone="default">Manifest</SectionHeader>
      <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
        <ManifestRow label="claude" value={detail.claudeManifest ? `${detail.claudeManifest.name ?? "—"} v${detail.claudeManifest.version ?? "—"}` : "(not declared)"} />
        <ManifestRow label="codex" value={detail.codexManifest ? `${detail.codexManifest.name ?? "—"} v${detail.codexManifest.version ?? "—"}` : "(not declared)"} />
        {detail.claudeManifest?.homepage && <ManifestRow label="homepage" value={detail.claudeManifest.homepage} />}
        {detail.claudeManifest?.repository && <ManifestRow label="repository" value={detail.claudeManifest.repository} />}
        {detail.claudeManifest?.license && <ManifestRow label="license" value={detail.claudeManifest.license} />}
        {detail.entry.lastSeenAt && <ManifestRow label="last seen" value={detail.entry.lastSeenAt} />}
      </dl>
    </section>
  );
}

function ManifestRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">{label}</dt>
      <dd className="font-mono text-[11px] text-stone-900">{value}</dd>
    </>
  );
}

function SkillsRootPanel({ detail }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]> }) {
  return (
    <section data-testid="plugin-viewer-skills-root" className="p-4">
      <SectionHeader tone="default">Skills</SectionHeader>
      <p className="mt-2 text-sm text-stone-600">
        {detail.skills.length === 0
          ? "This plugin does not ship any skills under its skills/ folder."
          : `This plugin ships ${detail.skills.length} ${detail.skills.length === 1 ? "skill" : "skills"}. Select one from the tree to view details.`}
      </p>
      {detail.skills.length > 0 && (
        <ul className="mt-3 divide-y divide-outline-variant border border-outline-variant bg-white/30">
          {detail.skills.map((skill) => (
            <li
              key={skill.name}
              data-testid={`plugin-viewer-skill-row-${skill.name}`}
              className="flex items-baseline justify-between gap-3 px-3 py-2 font-mono text-xs"
            >
              <span className="truncate text-stone-900">{skill.name}</span>
              <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">{skill.relativePath}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillPanel({ detail, skillName }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]>; skillName: string }) {
  const skill = detail.skills.find((s) => s.name === skillName);
  if (!skill) {
    return (
      <section data-testid="plugin-viewer-skill-missing" className="p-4">
        <EmptyState label="SKILL MISSING" description={`No skill named "${skillName}" in this plugin.`} variant="card" />
      </section>
    );
  }
  return (
    <section data-testid={`plugin-viewer-skill-${skill.name}`} className="p-4">
      <SectionHeader tone="default">Skill</SectionHeader>
      <h2 className="mt-2 font-headline text-lg font-bold tracking-tight text-stone-900">{skill.name}</h2>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">{skill.relativePath}</p>
      <p className="mt-3 text-sm text-stone-600">
        This skill ships inside <code className="font-mono">{detail.entry.name}</code>. To view its SKILL.md and
        navigate the skill folder, open the Skills Library entry.
      </p>
      <Link
        to="/specs/skills"
        data-testid={`plugin-viewer-skill-${skill.name}-open-library`}
        className="mt-3 inline-block border border-stone-400 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-700 hover:bg-stone-100"
      >
        Open Skills Library →
      </Link>
    </section>
  );
}

function HooksRootPanel({ detail }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]> }) {
  return (
    <section data-testid="plugin-viewer-hooks-root" className="p-4">
      <SectionHeader tone="default">Hooks</SectionHeader>
      {detail.hooks.length === 0 ? (
        <p className="mt-2 text-sm text-stone-600">This plugin does not ship hook configurations.</p>
      ) : (
        <p className="mt-2 text-sm text-stone-600">
          {detail.hooks.length} hook {detail.hooks.length === 1 ? "config" : "configs"}. Select a runtime from the tree to view declared events.
        </p>
      )}
    </section>
  );
}

function HookPanel({ detail, runtime }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]>; runtime: string }) {
  const hook = detail.hooks.find((h) => h.runtime === runtime);
  if (!hook) {
    return (
      <section data-testid="plugin-viewer-hook-missing" className="p-4">
        <EmptyState label="HOOK MISSING" description={`No hook config for runtime "${runtime}".`} variant="card" />
      </section>
    );
  }
  return (
    <section data-testid={`plugin-viewer-hook-${hook.runtime}`} className="p-4">
      <SectionHeader tone="default">Hook · {hook.runtime}</SectionHeader>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">{hook.relativePath}</p>
      {hook.events.length > 0 ? (
        <div className="mt-3">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">Events</h3>
          <ul className="mt-1 flex flex-wrap gap-1 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-700">
            {hook.events.map((event) => (
              <li key={event} className="border border-outline-variant px-1.5 py-0.5">
                {event}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-sm text-stone-600">No events declared in this hook config.</p>
      )}
    </section>
  );
}

function McpRootPanel({ detail }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]> }) {
  return (
    <section data-testid="plugin-viewer-mcp-root" className="p-4">
      <SectionHeader tone="default">MCP Servers</SectionHeader>
      {detail.mcpServers.length === 0 ? (
        <p className="mt-2 text-sm text-stone-600">This plugin does not declare MCP servers.</p>
      ) : (
        <p className="mt-2 text-sm text-stone-600">
          {detail.mcpServers.length} MCP server {detail.mcpServers.length === 1 ? "declared" : "declarations"}. Select one from the tree for details.
        </p>
      )}
    </section>
  );
}

function McpServerPanel({ detail, runtime, name }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]>; runtime: string; name: string }) {
  const server = detail.mcpServers.find((s) => s.runtime === runtime && s.name === name);
  if (!server) {
    return (
      <section data-testid="plugin-viewer-mcp-missing" className="p-4">
        <EmptyState label="MCP SERVER MISSING" description={`No MCP server "${name}" for runtime "${runtime}".`} variant="card" />
      </section>
    );
  }
  return (
    <section data-testid={`plugin-viewer-mcp-${server.runtime}-${server.name}`} className="p-4">
      <SectionHeader tone="default">MCP · {server.runtime}/{server.name}</SectionHeader>
      <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
        <dt className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">runtime</dt>
        <dd className="font-mono text-[11px] text-stone-900">{server.runtime}</dd>
        <dt className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">name</dt>
        <dd className="font-mono text-[11px] text-stone-900">{server.name}</dd>
        {server.command && (
          <>
            <dt className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">command</dt>
            <dd className="font-mono text-[11px] text-stone-900">{server.command}</dd>
          </>
        )}
        {server.transport && (
          <>
            <dt className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">transport</dt>
            <dd className="font-mono text-[11px] text-stone-900">{server.transport}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function UsedByPanel({
  usedBy,
  isLoading,
}: {
  usedBy: { agentName: string; sourcePath: string; profiles: string[] }[];
  isLoading: boolean;
}) {
  return (
    <section data-testid="plugin-viewer-used-by" className="p-4">
      <SectionHeader tone="default">Used By</SectionHeader>
      {isLoading ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">Loading…</p>
      ) : usedBy.length === 0 ? (
        <p className="mt-2 text-sm text-stone-600">No agent.yaml in the spec library currently references this plugin.</p>
      ) : (
        <ul className="mt-3 divide-y divide-outline-variant border border-outline-variant bg-white/30">
          {usedBy.map((ref) => (
            <li
              key={ref.agentName}
              data-testid={`plugin-viewer-used-by-${ref.agentName}`}
              className="flex items-baseline justify-between gap-3 px-3 py-2 font-mono text-xs"
            >
              <span className="truncate text-stone-900">{ref.agentName}</span>
              <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">{ref.profiles.join(", ")}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
