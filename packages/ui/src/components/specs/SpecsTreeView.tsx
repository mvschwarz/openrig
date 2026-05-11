import { useMemo, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { useContextPackLibrary } from "../../hooks/useContextPackLibrary.js";
import { useAgentImageLibrary } from "../../hooks/useAgentImageLibrary.js";
import { useLibrarySkills } from "../../hooks/useLibrarySkills.js";
import {
  librarySkillFileToken,
  librarySkillSelectionFromPath,
  librarySkillToken,
} from "../../lib/library-skills-routing.js";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";

interface TreeEntry {
  id: string;
  name: string;
  entryId?: string;
  skillId?: string;
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

function Section({
  def,
  expanded,
  onToggle,
}: {
  def: SectionDef;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <li data-testid={`specs-section-${def.id}`}>
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
                    className="block truncate font-mono text-xs text-on-surface hover:bg-surface-low hover:text-stone-900"
                  >
                    {entry.name}
                  </Link>
                ) : entry.skillId ? (
                  <Link
                    to="/specs/skills/$skillToken"
                    params={{ skillToken: librarySkillToken(entry.skillId) }}
                    data-testid={`specs-leaf-${entry.id}`}
                    className="block truncate font-mono text-xs text-on-surface hover:bg-surface-low hover:text-stone-900"
                  >
                    {entry.name}
                  </Link>
                ) : (
                  <div
                    data-testid={`specs-leaf-${entry.id}`}
                    className="truncate font-mono text-xs text-on-surface"
                  >
                    {entry.name}
                  </div>
                )}
                {entry.meta ? (
                  <div className="flex min-w-0 items-center gap-1 truncate font-mono text-[9px] text-on-surface-variant">
                    {entry.metaNode}
                    <span className="truncate">{entry.meta}</span>
                  </div>
                ) : null}
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

      {/* Slice 18 — top-level Library entries (Skills + Plugins) sit
          above the grouped tree as direct navigation to the index pages.
          The existing Section tree below continues to group entries for
          browsing in place. */}
      <ul className="px-2 mb-2 space-y-0.5">
        <li>
          <Link
            to="/specs/skills"
            data-testid="sidebar-skills-top-level"
            className="block font-mono text-[11px] uppercase tracking-wide text-stone-700 hover:text-stone-900 hover:bg-surface-low px-2 py-1"
          >
            {"> "}Skills
          </Link>
        </li>
      </ul>
      <ul>
        {sections.map((def) => {
          if (def.id !== "skills") {
            return (
              <Section
                key={def.id}
                def={def}
                expanded={!!expanded[def.id]}
                onToggle={() => toggle(def.id)}
              />
            );
          }

          const skillsExpanded = expanded.skills || !!activeSkill;
          const Chevron = skillsExpanded ? ChevronDown : ChevronRight;
          return (
            <li key={def.id} data-testid="specs-section-skills">
              <button
                type="button"
                onClick={() => toggle("skills")}
                data-testid="specs-section-toggle-skills"
                className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
              >
                <Chevron className="h-3 w-3 text-on-surface-variant" />
                <span className="font-mono text-[11px] uppercase tracking-wide text-stone-900 flex-1">
                  Skills
                </span>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {skillsLoading ? "..." : skills.length}
                </span>
              </button>
              {skillsExpanded ? (
                <ul className="ml-5 border-l border-stone-200">
                  {skills.length > 0 ? (
                    skills.map((skill) => {
                      const skillOpen = expandedSkills[skill.id] || activeSkill?.skillId === skill.id;
                      const SkillChevron = skillOpen ? ChevronDown : ChevronRight;
                      return (
                        <li key={skill.id} className="px-2 py-0.5">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => toggleSkill(skill.id)}
                              aria-label={`${skillOpen ? "Collapse" : "Expand"} ${skill.name}`}
                              className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-stone-500 hover:text-stone-900"
                            >
                              <SkillChevron className="h-3 w-3" />
                            </button>
                            <Link
                              to="/specs/skills/$skillToken"
                              params={{ skillToken: librarySkillToken(skill.id) }}
                              data-testid={`specs-leaf-${skill.id}`}
                              onClick={() => {
                                setExpandedSkills((prev) => ({ ...prev, [skill.id]: true }));
                              }}
                              className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface hover:bg-surface-low hover:text-stone-900"
                            >
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                <ToolMark tool="skill" size="xs" title={`${skill.name} skill`} decorative />
                                <span className="truncate">{skill.name}</span>
                              </span>
                            </Link>
                          </div>
                          {skillOpen ? (
                            <ul className="ml-4 border-l border-stone-200">
                              {skill.files.map((file) => {
                                const activeFile = activeSkill?.skillId === skill.id
                                  && (activeSkill.filePath === file.path || (!activeSkill.filePath && file.name.toLowerCase() === "skill.md"));
                                return (
                                  <li key={file.path} className="px-2 py-0.5">
                                    <Link
                                      to="/specs/skills/$skillToken/file/$fileToken"
                                      params={{
                                        skillToken: librarySkillToken(skill.id),
                                        fileToken: librarySkillFileToken(file.path),
                                      }}
                                      data-testid={`specs-skill-file-${file.name}`}
                                      data-active={activeFile}
                                      className={`flex min-w-0 items-center gap-1 truncate font-mono text-[11px] hover:bg-surface-low hover:text-stone-900 ${
                                        activeFile ? "text-stone-900" : "text-on-surface-variant"
                                      }`}
                                    >
                                      <ToolMark tool={file.name} size="xs" title={file.name} decorative />
                                      <span className="truncate">{file.name}</span>
                                    </Link>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })
                  ) : (
                    <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
                      {skillsLoading ? "Loading..." : "No skills yet."}
                    </li>
                  )}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
