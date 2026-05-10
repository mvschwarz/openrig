// Phase 3a slice 3.3 — PluginDetailPage.
//
// Mounts at /plugins/:pluginId. Reads usePlugin + usePluginUsedBy and
// renders:
//   - Top section: name + version + description + runtime support badges +
//     source label + provenance metadata.
//   - Manifest section: rendered manifest fields (claude + codex when both).
//   - Skills section: list of skill folders the plugin ships.
//   - Hooks section: list of hook configs (per-runtime) + declared events.
//   - Used-by section: list of agents in spec library that reference this plugin.
//
// Visual chrome mirrors SpecsLibraryPage section pattern (border + bg + hard-shadow)
// for taxonomic consistency with the Library.

import { Link } from "@tanstack/react-router";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { usePlugin, usePluginUsedBy } from "../../hooks/usePlugins.js";

interface PluginDetailPageProps {
  pluginId: string;
}

export function PluginDetailPage({ pluginId }: PluginDetailPageProps) {
  const { data: detail, isLoading: detailLoading, error: detailError } = usePlugin(pluginId);
  const { data: usedBy = [], isLoading: usedByLoading } = usePluginUsedBy(pluginId);

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
      className="h-full overflow-y-auto bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-5">
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

      <div className="grid gap-4 xl:grid-cols-2">
        <ManifestSection detail={detail} />
        <SkillsSection skills={detail.skills} />
        <HooksSection hooks={detail.hooks} />
        <UsedBySection
          usedBy={usedBy}
          isLoading={usedByLoading}
        />
      </div>
    </div>
  );
}

function ManifestSection({ detail }: { detail: NonNullable<ReturnType<typeof usePlugin>["data"]> }) {
  return (
    <section
      data-testid="plugin-detail-manifest"
      className="border border-outline-variant bg-white/25 hard-shadow"
    >
      <header className="border-b border-outline-variant bg-white/30 px-3 py-2">
        <SectionHeader tone="default">Manifest</SectionHeader>
      </header>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 px-3 py-3 font-mono text-[11px]">
        <ManifestRow label="claude" value={detail.claudeManifest ? `${detail.claudeManifest.name ?? "—"} v${detail.claudeManifest.version ?? "—"}` : "(not declared)"} />
        <ManifestRow label="codex" value={detail.codexManifest ? `${detail.codexManifest.name ?? "—"} v${detail.codexManifest.version ?? "—"}` : "(not declared)"} />
        {detail.claudeManifest?.homepage && (
          <ManifestRow label="homepage" value={detail.claudeManifest.homepage} />
        )}
        {detail.claudeManifest?.repository && (
          <ManifestRow label="repository" value={detail.claudeManifest.repository} />
        )}
        {detail.claudeManifest?.license && (
          <ManifestRow label="license" value={detail.claudeManifest.license} />
        )}
        {detail.entry.lastSeenAt && (
          <ManifestRow label="last seen" value={detail.entry.lastSeenAt} />
        )}
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

function SkillsSection({ skills }: { skills: NonNullable<ReturnType<typeof usePlugin>["data"]>["skills"] }) {
  return (
    <section
      data-testid="plugin-detail-skills"
      className="border border-outline-variant bg-white/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2">
        <SectionHeader tone="default">Skills</SectionHeader>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
          {skills.length} {skills.length === 1 ? "skill" : "skills"}
        </span>
      </header>
      {skills.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label="NO SKILLS"
            description="This plugin does not ship any skills under its skills/ folder."
            variant="card"
            testId="plugin-skills-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {skills.map((skill) => (
            <li
              key={skill.name}
              data-testid={`plugin-skill-${skill.name}`}
              className="flex items-baseline justify-between gap-3 px-3 py-2 font-mono"
            >
              <span className="truncate text-xs text-stone-900">{skill.name}</span>
              <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">
                {skill.relativePath}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HooksSection({ hooks }: { hooks: NonNullable<ReturnType<typeof usePlugin>["data"]>["hooks"] }) {
  return (
    <section
      data-testid="plugin-detail-hooks"
      className="border border-outline-variant bg-white/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2">
        <SectionHeader tone="default">Hooks</SectionHeader>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
          {hooks.length} {hooks.length === 1 ? "config" : "configs"}
        </span>
      </header>
      {hooks.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label="NO HOOKS"
            description="This plugin does not ship hook configurations."
            variant="card"
            testId="plugin-hooks-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {hooks.map((hook) => (
            <li
              key={hook.runtime}
              data-testid={`plugin-hook-${hook.runtime}`}
              className="px-3 py-2 font-mono text-[11px]"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-bold uppercase text-stone-900">{hook.runtime}</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">
                  {hook.relativePath}
                </span>
              </div>
              {hook.events.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1 font-mono text-[9px] uppercase tracking-[0.10em] text-stone-600">
                  {hook.events.map((event) => (
                    <span key={event} className="border border-outline-variant px-1.5 py-0.5">
                      {event}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UsedBySection({
  usedBy,
  isLoading,
}: {
  usedBy: { agentName: string; sourcePath: string; profiles: string[] }[];
  isLoading: boolean;
}) {
  return (
    <section
      data-testid="plugin-detail-used-by"
      className="border border-outline-variant bg-white/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2">
        <SectionHeader tone="default">Used by</SectionHeader>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
          {isLoading ? "loading" : `${usedBy.length} ${usedBy.length === 1 ? "agent" : "agents"}`}
        </span>
      </header>
      {usedBy.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label="NOT USED"
            description="No agent.yaml in the spec library currently references this plugin."
            variant="card"
            testId="plugin-used-by-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {usedBy.map((ref) => (
            <li
              key={ref.agentName}
              data-testid={`plugin-used-by-${ref.agentName}`}
              className="flex items-baseline justify-between gap-3 px-3 py-2 font-mono"
            >
              <span className="truncate text-xs text-stone-900">{ref.agentName}</span>
              <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">
                {ref.profiles.join(", ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
