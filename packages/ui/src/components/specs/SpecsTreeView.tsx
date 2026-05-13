import { useMemo, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { useContextPackLibrary } from "../../hooks/useContextPackLibrary.js";
import { useAgentImageLibrary } from "../../hooks/useAgentImageLibrary.js";
import { useLibrarySkills } from "../../hooks/useLibrarySkills.js";
import { usePlugins } from "../../hooks/usePlugins.js";
import {
  librarySkillSelectionFromPath,
  librarySkillToken,
} from "../../lib/library-skills-routing.js";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";

interface TreeEntry {
  id: string;
  name: string;
  entryId?: string;
  skillId?: string;
  pluginId?: string;
  meta?: string;
  metaNode?: ReactNode;
}

interface SectionDef {
  id: string;
  label: string;
  entries: TreeEntry[];
  loading?: boolean;
}

function specEntry(entry: SpecLibraryEntry): TreeEntry {
  return { id: entry.id, name: entry.name, entryId: entry.id, meta: entry.version };
}

function entryAccessibleLabel(entry: TreeEntry): string {
  return entry.meta ? `${entry.name} · ${entry.meta}` : entry.name;
}

function LeafContent({ entry }: { entry: TreeEntry }) {
  return (
    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
  );
}

function Section({
  def,
  expanded,
  onToggle,
  navigateTo,
  onNavigate,
}: {
  def: SectionDef;
  expanded: boolean;
  onToggle: () => void;
  // Slice 28 — dual-action sections. When `navigateTo` is provided,
  // the section header is split: chevron-button toggles expand-only;
  // label Link navigates to the index page AND expands the tree.
  // Used by SKILLS + PLUGINS sections; other sections render the
  // single-button full-row toggle (legacy behavior).
  navigateTo?: "/specs/skills" | "/specs/plugins";
  onNavigate?: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <li data-testid={`specs-section-${def.id}`}>
      {navigateTo ? (
        <div className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left">
          <button
            type="button"
            onClick={onToggle}
            data-testid={`specs-section-toggle-${def.id}`}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${def.label}`}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-stone-500 hover:text-stone-900"
          >
            <Chevron className="h-3 w-3" />
          </button>
          <Link
            to={navigateTo}
            data-testid={`specs-section-link-${def.id}`}
            onClick={onNavigate}
            className="font-mono text-[11px] uppercase tracking-wide text-stone-900 flex-1 hover:underline"
          >
            {def.label}
          </Link>
          <span className="font-mono text-[10px] text-on-surface-variant">
            {def.loading ? "..." : def.entries.length}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          data-testid={`specs-section-toggle-${def.id}`}
          className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
        >
          <Chevron className="h-3 w-3 text-on-surface-variant" />
          <span className="font-mono text-[11px] uppercase tracking-wide text-stone-900 flex-1">
            {def.label}
          </span>
          <span className="font-mono text-[10px] text-on-surface-variant">
            {def.loading ? "..." : def.entries.length}
          </span>
        </button>
      )}
      {expanded ? (
        <ul className="ml-5 border-l border-stone-200">
          {def.entries.length > 0 ? (
            def.entries.map((entry) => (
              <li key={entry.id} className="px-2 py-0.5">
                {entry.entryId ? (
                  <Link
                    to="/specs/library/$entryId"
                    params={{ entryId: entry.entryId }}
                    data-testid={`specs-leaf-${entry.id}`}
                    title={entryAccessibleLabel(entry)}
                    aria-label={entryAccessibleLabel(entry)}
                    className="flex min-w-0 items-center justify-between gap-2 truncate font-mono text-xs text-on-surface hover:bg-surface-low hover:text-stone-900"
                  >
                    <LeafContent entry={entry} />
                  </Link>
                ) : entry.skillId ? (
                  <Link
                    to="/specs/skills/$skillToken"
                    params={{ skillToken: librarySkillToken(entry.skillId) }}
                    data-testid={`specs-leaf-${entry.id}`}
                    title={entryAccessibleLabel(entry)}
                    aria-label={entryAccessibleLabel(entry)}
                    className="flex min-w-0 items-center justify-between gap-2 truncate font-mono text-xs text-on-surface hover:bg-surface-low hover:text-stone-900"
                  >
                    <LeafContent entry={entry} />
                  </Link>
                ) : entry.pluginId ? (
                  <Link
                    to="/plugins/$pluginId"
                    params={{ pluginId: entry.pluginId }}
                    data-testid={`specs-leaf-${entry.id}`}
                    title={entryAccessibleLabel(entry)}
                    aria-label={entryAccessibleLabel(entry)}
                    className="flex min-w-0 items-center justify-between gap-2 truncate font-mono text-xs text-on-surface hover:bg-surface-low hover:text-stone-900"
                  >
                    <LeafContent entry={entry} />
                  </Link>
                ) : (
                  <div
                    data-testid={`specs-leaf-${entry.id}`}
                    title={entryAccessibleLabel(entry)}
                    aria-label={entryAccessibleLabel(entry)}
                    className="flex min-w-0 items-center justify-between gap-2 truncate font-mono text-xs text-on-surface"
                  >
                    <LeafContent entry={entry} />
                  </div>
                )}
              </li>
            ))
          ) : (
            <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
              {def.loading ? "Loading..." : `No ${def.label.toLowerCase()} yet.`}
            </li>
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function SpecsTreeView() {
  const routerState = useRouterState();
  const { data: library = [], isLoading: specsLoading } = useSpecLibrary();
  const { data: contextPacks = [], isLoading: contextPacksLoading } = useContextPackLibrary();
  const { data: agentImages = [], isLoading: agentImagesLoading } = useAgentImageLibrary();
  const { data: skills = [], isLoading: skillsLoading } = useLibrarySkills();
  const { data: plugins = [], isLoading: pluginsLoading } = usePlugins();
  const activeSkill = librarySkillSelectionFromPath(routerState.location.pathname);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "rig-specs": true,
    "workspace-specs": false,
    "workflow-specs": false,
    "context-packs": false,
    "agent-specs": false,
    "agent-images": false,
    applications: false,
    skills: false,
    plugins: false,
  });
  const [expandedSkills, setExpandedSkills] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleSkill = (id: string) =>
    setExpandedSkills((prev) => ({ ...prev, [id]: !prev[id] }));

  const sections = useMemo<SectionDef[]>(() => {
    const rigSpecs = library.filter((entry) => entry.kind === "rig" && !entry.hasServices).map(specEntry);
    const workflowSpecs = library.filter((entry) => entry.kind === "workflow").map(specEntry);
    const agentSpecs = library.filter((entry) => entry.kind === "agent").map(specEntry);
    const applications = library.filter((entry) => entry.kind === "rig" && entry.hasServices).map(specEntry);
    return [
      { id: "rig-specs", label: "Rig Specs", entries: rigSpecs, loading: specsLoading },
      { id: "workspace-specs", label: "Workspace Specs", entries: [] },
      { id: "workflow-specs", label: "Workflow Specs", entries: workflowSpecs, loading: specsLoading },
      {
        id: "context-packs",
        label: "Context Packs",
        entries: contextPacks.map((entry) => ({
          id: entry.id,
          name: entry.name,
          entryId: entry.id,
          meta: `${entry.version} · ${entry.sourceType}`,
        })),
        loading: contextPacksLoading,
      },
      { id: "agent-specs", label: "Agent Specs", entries: agentSpecs, loading: specsLoading },
      {
        id: "agent-images",
        label: "Agent Images",
        entries: agentImages.map((entry) => ({
          id: entry.id,
          name: entry.name,
          entryId: entry.id,
          meta: entry.version,
          metaNode: <RuntimeBadge runtime={entry.runtime} size="xs" compact variant="inline" />,
        })),
        loading: agentImagesLoading,
      },
      { id: "applications", label: "Applications", entries: applications, loading: specsLoading },
      // Slice 28 — Plugins above Skills per founder direction (Skills
      // list will be larger; Plugins user-priority).
      {
        id: "plugins",
        label: "Plugins",
        entries: plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          pluginId: plugin.id,
          meta: plugin.version,
        })),
        loading: pluginsLoading,
      },
      {
        id: "skills",
        label: "Skills",
        entries: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          skillId: skill.id,
        })),
        loading: skillsLoading,
      },
    ];
  }, [
    agentImages,
    agentImagesLoading,
    contextPacks,
    contextPacksLoading,
    library,
    plugins,
    pluginsLoading,
    skills,
    skillsLoading,
    specsLoading,
  ]);

  return (
    <div data-testid="specs-tree-view" className="flex-1 overflow-y-auto py-2">
      <div className="px-2 mb-2">
        <Link
          to="/specs"
          data-testid="specs-tree-overview-link"
          className="block font-mono text-[11px] uppercase tracking-wide text-stone-900 px-2 py-1 hover:bg-surface-low"
        >
          {"> "}Library
        </Link>
      </div>

      {/* Slice 28 — top-level Skills + Plugins duplicates removed.
          The grouped tree below carries those entries with dual-action
          (label navigates to index page + expands the subtree). */}
      <ul>
        {sections.map((def) => {
          if (def.id !== "skills") {
            // Slice 28 dual-action: plugins section label navigates
            // to /specs/plugins AND expands the tree. Other sections
            // (rig-specs, agent-specs, etc.) keep legacy toggle-only.
            const navigateTo = def.id === "plugins" ? "/specs/plugins" : undefined;
            return (
              <Section
                key={def.id}
                def={def}
                expanded={!!expanded[def.id]}
                onToggle={() => toggle(def.id)}
                navigateTo={navigateTo}
                onNavigate={navigateTo ? () => setExpanded((prev) => ({ ...prev, [def.id]: true })) : undefined}
              />
            );
          }

          const skillsExpanded = expanded.skills || !!activeSkill;
          const Chevron = skillsExpanded ? ChevronDown : ChevronRight;
          return (
            <li key={def.id} data-testid="specs-section-skills">
              {/* Slice 28 dual-action header: chevron toggles expand;
                  label Link navigates to /specs/skills AND expands. */}
              <div className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left">
                <button
                  type="button"
                  onClick={() => toggle("skills")}
                  data-testid="specs-section-toggle-skills"
                  aria-label={`${skillsExpanded ? "Collapse" : "Expand"} Skills`}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-stone-500 hover:text-stone-900"
                >
                  <Chevron className="h-3 w-3" />
                </button>
                <Link
                  to="/specs/skills"
                  data-testid="specs-section-link-skills"
                  onClick={() => setExpanded((prev) => ({ ...prev, skills: true }))}
                  className="font-mono text-[11px] uppercase tracking-wide text-stone-900 flex-1 hover:underline"
                >
                  Skills
                </Link>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {skillsLoading ? "..." : skills.length}
                </span>
              </div>
              {skillsExpanded ? (
                <SkillsTree
                  skills={skills}
                  loading={skillsLoading}
                  activeSkillId={activeSkill?.skillId ?? null}
                  expandedCategories={expandedSkills}
                  onToggleCategory={toggleSkill}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Slice 29 HG-3 — skills section restructure.
//
// Category-folder grouping: parse the skill id's path segment (after
// "openrig-managed:" or "workspace:<root>:") for a category prefix like
// "core/" / "pm/" / "pods/" / "process/". Skills with a category render
// under that folder; flat skills (e.g. workspace skills with no nested
// path) render under a synthetic "uncategorized" group.
//
// Skill rows are SINGLE-ROW (NOT folder-expandable into files). The
// docs-browser on the skill detail page surfaces files; the sidebar
// stays at one level of nesting (categories → skills). This is the
// intentional asymmetry with plugin tree rows: plugins legitimately
// contain N skills and stay expandable; canonical skills don't.

interface SkillsTreeProps {
  skills: Array<{ id: string; name: string; source: string; files: Array<{ name: string; path: string }> }>;
  loading: boolean;
  activeSkillId: string | null;
  expandedCategories: Record<string, boolean>;
  onToggleCategory: (key: string) => void;
}

function extractCategory(skillId: string): string {
  // id shapes:
  //   openrig-managed:claude-compact-in-place       → "(top-level)"
  //   openrig-managed:core/openrig-user             → "core"
  //   openrig-managed:pm/requirements-writer        → "pm"
  //   workspace:<root>:operator-skill               → "workspace"
  const afterSource = skillId.replace(/^[^:]+:/, "");
  if (afterSource.startsWith("workspace:") || skillId.startsWith("workspace:")) {
    return "workspace";
  }
  const slash = afterSource.indexOf("/");
  if (slash === -1) return "(uncategorized)";
  return afterSource.slice(0, slash);
}

function SkillsTree({ skills, loading, activeSkillId, expandedCategories, onToggleCategory }: SkillsTreeProps) {
  if (loading && skills.length === 0) {
    return (
      <ul className="ml-5 border-l border-stone-200">
        <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">Loading...</li>
      </ul>
    );
  }
  if (skills.length === 0) {
    return (
      <ul className="ml-5 border-l border-stone-200">
        <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">No skills yet.</li>
      </ul>
    );
  }
  const byCategory = new Map<string, typeof skills>();
  for (const skill of skills) {
    const cat = extractCategory(skill.id);
    const list = byCategory.get(cat) ?? [];
    list.push(skill);
    byCategory.set(cat, list);
  }
  const categories = Array.from(byCategory.entries()).sort(([a], [b]) => a.localeCompare(b));
  return (
    <ul className="ml-5 border-l border-stone-200" data-testid="skills-category-tree">
      {categories.map(([category, items]) => {
        const categoryKey = `category:${category}`;
        const isOpen = !!expandedCategories[categoryKey] || items.some((s) => s.id === activeSkillId);
        const CategoryChevron = isOpen ? ChevronDown : ChevronRight;
        return (
          <li key={category} data-testid={`skills-category-${category}`}>
            <button
              type="button"
              onClick={() => onToggleCategory(categoryKey)}
              data-testid={`skills-category-toggle-${category}`}
              className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low text-left"
            >
              <CategoryChevron className="h-3 w-3 text-on-surface-variant" />
              <span className="font-mono text-[10px] uppercase tracking-wide text-stone-700 flex-1">{category}</span>
              <span className="font-mono text-[9px] text-on-surface-variant">{items.length}</span>
            </button>
            {isOpen && (
              <ul className="ml-4 border-l border-stone-200">
                {items.map((skill) => (
                  <li key={skill.id} className="px-2 py-0.5">
                    <Link
                      to="/specs/skills/$skillToken"
                      params={{ skillToken: librarySkillToken(skill.id) }}
                      data-testid={`specs-leaf-${skill.id}`}
                      className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs text-on-surface hover:bg-surface-low hover:text-stone-900"
                    >
                      <ToolMark tool="skill" size="xs" title={`${skill.name} skill`} decorative />
                      <span className="truncate">{skill.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
