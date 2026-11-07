import { useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "../ui/button.js";
import { PageHeader } from "../ui/page-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { StatusBadge } from "../ui/status-badge.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu.js";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { useContextPackLibrary, type ContextPackEntry } from "../../hooks/useContextPackLibrary.js";
import { useAgentImageLibrary, type AgentImageEntry } from "../../hooks/useAgentImageLibrary.js";
import { useLibrarySkills, type LibrarySkillEntry } from "../../hooks/useLibrarySkills.js";
import { librarySkillHref } from "../../lib/library-skills-routing.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
// Phase 3a slice 3.3 — plugins library category.
import { usePlugins, type PluginEntry } from "../../hooks/usePlugins.js";

/** C14b: the 5 toolbar buttons collapse to one primary "New rig" + a
 *  "More" dropdown. Destinations are unchanged from TOOLBAR_ACTIONS. */
const MORE_ACTIONS = [
  { label: "New agent", to: "/specs/agent", testId: "specs-toolbar-add" },
  { label: "Workflows", to: "/workflows", testId: "specs-toolbar-gen-workflow" },
  { label: "Import", to: "/import", testId: "specs-toolbar-import" },
  { label: "Discover", to: "/search", testId: "specs-toolbar-discover" },
] as const;

interface LibraryRow {
  id: string;
  label: string;
  meta?: string;
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
    entryId: entry.id,
  };
}

function contextPackRow(entry: ContextPackEntry): LibraryRow {
  return {
    id: entry.id,
    label: entry.name,
    entryId: entry.id,
  };
}

function agentImageRow(entry: AgentImageEntry): LibraryRow {
  const parts: string[] = [`v${entry.version}`];
  if (entry.derivedEstimatedTokens > 0) parts.push(`~${entry.derivedEstimatedTokens} tok`);
  if (entry.stats.forkCount > 0) parts.push(`forks: ${entry.stats.forkCount}`);
  if (entry.stats.lastUsedAt) parts.push(`used: ${formatRelativeAge(entry.stats.lastUsedAt)}`);
  return {
    id: entry.id,
    label: entry.name,
    meta: parts.join(" · "),
    entryId: entry.id,
  };
}

function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function LibrarySection({
  id,
  title,
  rows,
  isLoading,
  emptyLabel,
  badge,
}: {
  id: string;
  title: string;
  rows: LibraryRow[];
  isLoading?: boolean;
  emptyLabel?: string;
  /** Optional aggregate badge shown in the header right slot in place of the
   *  default item count (e.g. agent-images "3 images · 128 MB"). */
  badge?: string;
}) {
  return (
    <section data-testid={`library-section-${id}`} className="rounded-lg border bg-surface-lowest shadow-sm">
      <header className="flex items-baseline justify-between border-b border-outline-variant px-3 py-2">
        <h2 className="text-sm font-semibold text-on-surface">{title}</h2>
        <span
          data-testid={`library-section-${id}-badge`}
          className="shrink-0 text-xs text-on-surface-variant"
        >
          {isLoading ? "Loading" : badge ?? `${rows.length} items`}
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
                  className="block px-3 py-2 text-sm hover:bg-surface-low/50"
                >
                  <LibraryRowContent row={row} />
                </Link>
              ) : (
                <div
                  data-testid={`library-row-${id}-${row.id}`}
                  data-status={row.status}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                >
                  <StatusBadge status={row.status} />
                  <span className="min-w-0 flex-1"><LibraryRowContent row={row} /></span>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 py-4 text-sm text-on-surface-variant">
          {isLoading ? "Loading…" : emptyLabel ?? "No entries."}
        </div>
      )}
    </section>
  );
}

/** Compact human-readable byte size for the agent-image aggregate badge. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function LibraryRowContent({ row }: { row: LibraryRow }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
      <span className="truncate font-medium text-on-surface">{row.label}</span>
      {row.meta ? (
        <span className="shrink-0 font-mono text-xs text-on-surface-variant">
          {row.meta}
        </span>
      ) : null}
    </div>
  );
}

// Phase 3a slice 3.3 — Plugins library section.
//
// Mirrors SkillsSection's chrome, renders one row per discovered plugin
// with name, version, runtime support badges (claude/codex), source label
// provenance. Each row links to the plugin detail viewer at /plugins/:id.
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
      className="rounded-lg border bg-surface-lowest shadow-sm"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant px-3 py-2">
        <h2 className="text-sm font-semibold text-on-surface">Plugins</h2>
        <span className="shrink-0 text-xs text-on-surface-variant">
          {isLoading ? "Loading" : `${plugins.length} plugins`}
        </span>
      </header>
      {plugins.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label={isLoading ? "Loading" : "No plugins discovered"}
            title={isLoading ? "Loading" : "No plugins discovered"}
            description={isLoading
              ? "Loading plugins…"
              : "Install a Claude Code or Codex plugin (or wait for openrig-core to vendor) to see it appear here."}
            variant="minimal"
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
                className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-low/50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${plugin.name} plugin`} size="xs" decorative />
                  <span className="truncate font-medium text-on-surface">{plugin.name}</span>
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
      className="rounded-lg border bg-surface-lowest shadow-sm"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant px-3 py-2">
        <h2 className="text-sm font-semibold text-on-surface">Skills</h2>
        <span className="shrink-0 text-xs text-on-surface-variant">
          {isLoading ? "Loading" : `${skills.length} folders`}
        </span>
      </header>
      {skills.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label={isLoading ? "Loading" : "No skills found"}
            title={isLoading ? "Loading" : "No skills found"}
            description={isLoading
              ? "Loading skill folders…"
              : "No .openrig/skills or packaged OpenRig skill folders are visible through configured file roots."}
            variant="minimal"
            testId="library-skills-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {skills.map((skill) => (
            <li key={skill.id}>
              <Link
                to={librarySkillHref(skill.id)}
                data-testid={`library-skill-${skill.name}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-low/60 focus:outline-none focus:bg-surface-low/80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${skill.name} skill`} size="xs" decorative />
                  <span className="truncate font-medium text-on-surface">{skill.name}</span>
                </span>
                <span className="shrink-0 text-xs text-on-surface-variant">
                  {skill.files.length} files
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LibraryToolbarActions() {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2">
      <Button asChild size="sm" data-testid="specs-toolbar-create-rig">
        <Link to="/specs/rig">New rig</Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" data-testid="specs-toolbar-more">
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {MORE_ACTIONS.map((a) => (
            <DropdownMenuItem
              key={a.testId}
              data-testid={a.testId}
              onSelect={() => void navigate({ to: a.to })}
            >
              {a.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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

  // OPR.0.4.3.05 — aggregate agent-image status badge (count + total estimated
  // size) over the already-in-scope library array. Rendered into the existing
  // Agent Images section header; no new data wiring, no phantom Steering panel.
  const agentImageBadge = useMemo(() => {
    const count = agentImages.length;
    const totalBytes = agentImages.reduce((sum, e) => sum + (e.stats?.estimatedSizeBytes ?? 0), 0);
    return `${count} ${count === 1 ? "image" : "images"} · ${formatBytes(totalBytes)}`;
  }, [agentImages]);

  const total =
    sections.rigSpecs.length
    + sections.workflowSpecs.length
    + sections.agentSpecs.length
    + sections.applications.length
    + contextPacks.length
    + agentImages.length
    + skills.length
    + plugins.length;

  const anyLoading = specsLoading || contextPacksLoading || agentImagesLoading || skillsLoading || pluginsLoading;

  return (
    <div
      data-testid="specs-library-page"
      className="h-full overflow-y-auto px-6 py-5 text-sm lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <PageHeader
        title="Library"
        description="Browse rig and agent specs, skills and plugins. Start a new rig or open anything to review it."
        actions={<LibraryToolbarActions />}
      />

      <div className="mb-4 text-xs text-on-surface-variant">
        {total} library entries visible through current sources
      </div>

      {!anyLoading && total === 0 ? (
        <EmptyState
          title="Your library is empty"
          label="Your library is empty"
          description="Specs, skills and plugins you add or discover show up here."
          action={{ label: "Discover", href: "/search" }}
          variant="card"
          testId="library-empty"
        />
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <LibrarySection
              id="rig-specs"
              title="Rig specs"
              rows={sections.rigSpecs}
              isLoading={specsLoading}
              emptyLabel="No rig specs found."
            />
            <LibrarySection
              id="workspace-specs"
              title="Workspace specs"
              rows={[]}
              emptyLabel="No workspace specs source is wired yet."
            />
            <LibrarySection
              id="workflow-specs"
              title="Workflow specs"
              rows={sections.workflowSpecs}
              isLoading={specsLoading}
              emptyLabel="No workflow specs found."
            />
            <LibrarySection
              id="context-packs"
              title="Context packs"
              rows={contextPacks.map(contextPackRow)}
              isLoading={contextPacksLoading}
              emptyLabel="No context packs found."
            />
            <LibrarySection
              id="agent-specs"
              title="Agent specs"
              rows={sections.agentSpecs}
              isLoading={specsLoading}
              emptyLabel="No agent specs found."
            />
            <LibrarySection
              id="agent-images"
              title="Agent images"
              rows={agentImages.map(agentImageRow)}
              isLoading={agentImagesLoading}
              emptyLabel="No agent images found."
              badge={agentImageBadge}
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
        </>
      )}
    </div>
  );
}
