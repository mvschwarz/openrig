import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { useContextPackLibrary, type ContextPackEntry } from "../../hooks/useContextPackLibrary.js";
import { useAgentImageLibrary, type AgentImageEntry } from "../../hooks/useAgentImageLibrary.js";
import { useLibrarySkills, type LibrarySkillEntry } from "../../hooks/useLibrarySkills.js";
import { librarySkillHref } from "../../lib/library-skills-routing.js";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";
// Phase 3a slice 3.3 — plugins library category.
import { usePlugins, type PluginEntry } from "../../hooks/usePlugins.js";

const TOOLBAR_ACTIONS = [
  { label: "+ Add spec", to: "/specs/rig", testId: "specs-toolbar-add" },
  { label: "Import", to: "/import", testId: "specs-toolbar-import" },
  { label: "Discover", to: "/search", testId: "specs-toolbar-discover" },
  { label: "Create rig", to: "/specs/rig", testId: "specs-toolbar-create-rig" },
  { label: "Generate workflow", to: "/specs/agent", testId: "specs-toolbar-gen-workflow" },
] as const;

interface LibraryRow {
  id: string;
  label: string;
  meta: string;
  metaNode?: ReactNode;
  entryId?: string;
  /** Slice 11 — diagnostic state for unparseable YAML in the workflows
   *  folder. "error" rows render non-navigable with the parser/validator
   *  message inline so the operator can fix the file in place. */
  status?: "valid" | "error";
}

function specRow(entry: SpecLibraryEntry): LibraryRow {
  if (entry.status === "error") {
    // Diagnostic row: no entryId → non-navigable; meta carries the
    // parse/validate reason so the operator sees it inline.
    return {
      id: entry.id,
      label: entry.name,
      meta: entry.errorMessage ?? "Invalid workflow YAML",
      status: "error",
    };
  }
  return {
    id: entry.id,
    label: entry.name,
    meta: `${entry.version} · ${entry.sourceType}`,
    entryId: entry.id,
  };
}

function contextPackRow(entry: ContextPackEntry): LibraryRow {
  return {
    id: entry.id,
    label: entry.name,
    meta: `${entry.version} · ${entry.sourceType} · ~${entry.derivedEstimatedTokens} tokens`,
    entryId: entry.id,
  };
}

function agentImageRow(entry: AgentImageEntry): LibraryRow {
  return {
    id: entry.id,
    label: entry.name,
    meta: `${entry.version} · ${entry.sourceType}`,
    metaNode: <RuntimeBadge runtime={entry.runtime} size="xs" compact variant="inline" />,
    entryId: entry.id,
  };
}

function LibrarySection({
  id,
  title,
  rows,
  isLoading,
  emptyLabel,
}: {
  id: string;
  title: string;
  rows: LibraryRow[];
  isLoading?: boolean;
  emptyLabel?: string;
}) {
  return (
    <section data-testid={`library-section-${id}`} className="border border-outline-variant bg-white/25 hard-shadow">
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2">
        <SectionHeader tone="default">{title}</SectionHeader>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
          {isLoading ? "loading" : `${rows.length} items`}
        </span>
      </header>
      {rows.length > 0 ? (
        <ul className="divide-y divide-outline-variant">
          {rows.map((row) => (
            <li key={row.id}>
              {row.entryId ? (
                <Link
                  to="/specs/library/$entryId"
                  params={{ entryId: row.entryId }}
                  data-testid={`library-row-${id}-${row.id}`}
                  className="block px-3 py-2 hover:bg-stone-100/50"
                >
                  <LibraryRowContent row={row} />
                </Link>
              ) : (
                <div
                  data-testid={`library-row-${id}-${row.id}`}
                  data-status={row.status}
                  className={`px-3 py-2 ${row.status === "error" ? "bg-red-50/40 text-red-900" : ""}`}
                >
                  <LibraryRowContent row={row} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 py-4 font-mono text-[10px] text-stone-500">
          {isLoading ? "Loading..." : emptyLabel ?? "No entries."}
        </div>
      )}
    </section>
  );
}

function LibraryRowContent({ row }: { row: LibraryRow }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-mono">
      <span className="truncate text-xs font-bold text-stone-900">{row.label}</span>
      <span className="flex shrink-0 items-center gap-2 text-[9px] uppercase tracking-[0.08em] text-stone-500">
        {row.metaNode}
        <span>{row.meta}</span>
      </span>
    </div>
  );
}

// Phase 3a slice 3.3 — Plugins library section.
//
// Mirrors SkillsSection's chrome (border + hard-shadow + header with count),
// renders one row per discovered plugin with name, version, runtime support
// badges (claude/codex), source label provenance. Each row links to the
// plugin detail viewer at /plugins/:id.
function PluginsSection({
  plugins,
  isLoading,
}: {
  plugins: PluginEntry[];
  isLoading: boolean;
}) {
  return (
    <section
      id="library-plugins"
      data-testid="library-section-plugins"
      className="border border-outline-variant bg-white/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2">
        <SectionHeader tone="default">Plugins</SectionHeader>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
          {isLoading ? "loading" : `${plugins.length} plugins`}
        </span>
      </header>
      {plugins.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label={isLoading ? "LOADING" : "NO PLUGINS DISCOVERED"}
            description={isLoading
              ? "Loading plugins..."
              : "Install a Claude Code or Codex plugin (or wait for openrig-core to vendor) to see it appear here."}
            variant="card"
            testId="library-plugins-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: plugin.id }}
                data-testid={`library-plugin-${plugin.id}`}
                className="flex items-center justify-between gap-3 px-3 py-2 font-mono hover:bg-stone-100/50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${plugin.name} plugin`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-stone-900">{plugin.name}</span>
                  <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-stone-500">
                    v{plugin.version}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[9px] uppercase tracking-[0.08em] text-stone-500">
                  {plugin.runtimes.map((rt) => (
                    <span
                      key={rt}
                      data-testid={`plugin-runtime-${rt}`}
                      className="inline-block border border-outline-variant px-1.5 py-0.5 font-mono"
                    >
                      {rt}
                    </span>
                  ))}
                  <span title={plugin.path}>{plugin.sourceLabel}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillsSection({
  skills,
  isLoading,
}: {
  skills: LibrarySkillEntry[];
  isLoading: boolean;
}) {
  return (
    <section
      id="library-skills"
      data-testid="library-section-skills"
      className="border border-outline-variant bg-white/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2">
        <SectionHeader tone="default">Skills</SectionHeader>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
          {isLoading ? "loading" : `${skills.length} folders`}
        </span>
      </header>
      {skills.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label={isLoading ? "LOADING" : "NO SKILLS FOUND"}
            description={isLoading
              ? "Loading skill folders..."
              : "No .openrig/skills or packaged OpenRig skill folders are visible through configured file roots."}
            variant="card"
            testId="library-skills-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {skills.map((skill) => (
            <li key={skill.id}>
              <a
                href={librarySkillHref(skill.id)}
                data-testid={`library-skill-${skill.name}`}
                className="flex items-center justify-between gap-3 px-3 py-2 font-mono hover:bg-stone-100/50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${skill.name} skill`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-stone-900">{skill.name}</span>
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-stone-500">
                  {skill.files.length} files
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SpecsLibraryPage() {
  const { data: specs = [], isLoading: specsLoading } = useSpecLibrary();
  const { data: contextPacks = [], isLoading: contextPacksLoading } = useContextPackLibrary();
  const { data: agentImages = [], isLoading: agentImagesLoading } = useAgentImageLibrary();
  const { data: skills = [], isLoading: skillsLoading } = useLibrarySkills();
  // Phase 3a slice 3.3 — plugins category.
  const { data: plugins = [], isLoading: pluginsLoading } = usePlugins();

  const sections = useMemo(() => {
    const rigSpecs = specs.filter((entry) => entry.kind === "rig" && !entry.hasServices).map(specRow);
    const workflowSpecs = specs.filter((entry) => entry.kind === "workflow").map(specRow);
    const agentSpecs = specs.filter((entry) => entry.kind === "agent").map(specRow);
    const applications = specs.filter((entry) => entry.kind === "rig" && entry.hasServices).map(specRow);
    return { rigSpecs, workflowSpecs, agentSpecs, applications };
  }, [specs]);

  const total =
    sections.rigSpecs.length
    + sections.workflowSpecs.length
    + sections.agentSpecs.length
    + sections.applications.length
    + contextPacks.length
    + agentImages.length
    + skills.length;

  return (
    <div
      data-testid="specs-library-page"
      className="h-full overflow-y-auto bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionHeader tone="muted">Library</SectionHeader>
          <h1 className="mt-1 font-headline text-2xl font-bold tracking-tight text-stone-900">
            Library
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-stone-600">
            Specs, context packs, agent images, applications, and skill folders.
          </p>
        </div>
        <nav
          aria-label="Library actions"
          className="flex flex-wrap justify-end gap-2"
        >
          {TOOLBAR_ACTIONS.map((a) => (
            <Link
              key={a.testId}
              to={a.to}
              data-testid={a.testId}
              className="border border-outline-variant bg-white/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-700 hard-shadow hover:bg-white/40"
            >
              {a.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.14em] text-stone-500">
        {total} library entries visible through current sources
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <LibrarySection
          id="rig-specs"
          title="Rig Specs"
          rows={sections.rigSpecs}
          isLoading={specsLoading}
          emptyLabel="No rig specs found."
        />
        <LibrarySection
          id="workspace-specs"
          title="Workspace Specs"
          rows={[]}
          emptyLabel="No workspace specs source is wired yet."
        />
        <LibrarySection
          id="workflow-specs"
          title="Workflow Specs"
          rows={sections.workflowSpecs}
          isLoading={specsLoading}
          emptyLabel="No workflow specs found."
        />
        <LibrarySection
          id="context-packs"
          title="Context Packs"
          rows={contextPacks.map(contextPackRow)}
          isLoading={contextPacksLoading}
          emptyLabel="No context packs found."
        />
        <LibrarySection
          id="agent-specs"
          title="Agent Specs"
          rows={sections.agentSpecs}
          isLoading={specsLoading}
          emptyLabel="No agent specs found."
        />
        <LibrarySection
          id="agent-images"
          title="Agent Images"
          rows={agentImages.map(agentImageRow)}
          isLoading={agentImagesLoading}
          emptyLabel="No agent images found."
        />
        <LibrarySection
          id="applications"
          title="Applications"
          rows={sections.applications}
          isLoading={specsLoading}
          emptyLabel="No application specs found."
        />
      </div>

      <div className="mt-4 space-y-4">
        {/* Phase 3a slice 3.3 — Plugins category sits between the spec
            grid and the Skills folder roundup; both are wide single-
            column sections rather than grid columns because their row
            count varies more dramatically than the spec categories. */}
        <PluginsSection plugins={plugins} isLoading={pluginsLoading} />
        <SkillsSection skills={skills} isLoading={skillsLoading} />
      </div>
    </div>
  );
}
