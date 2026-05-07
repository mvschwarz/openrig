import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { useContextPackLibrary } from "../../hooks/useContextPackLibrary.js";
import { useAgentImageLibrary } from "../../hooks/useAgentImageLibrary.js";
import { useLibrarySkills } from "../../hooks/useLibrarySkills.js";

interface TreeEntry {
  id: string;
  name: string;
  entryId?: string;
  meta?: string;
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
                ) : (
                  <div
                    data-testid={`specs-leaf-${entry.id}`}
                    className="truncate font-mono text-xs text-on-surface"
                  >
                    {entry.name}
                  </div>
                )}
                {entry.meta ? (
                  <div className="truncate font-mono text-[9px] text-on-surface-variant">
                    {entry.meta}
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
  const { data: library = [], isLoading: specsLoading } = useSpecLibrary();
  const { data: contextPacks = [], isLoading: contextPacksLoading } = useContextPackLibrary();
  const { data: agentImages = [], isLoading: agentImagesLoading } = useAgentImageLibrary();
  const { data: skills = [], isLoading: skillsLoading } = useLibrarySkills();
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
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

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
          meta: `${entry.version} · ${entry.runtime}`,
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
          meta: skill.source === "workspace" ? "workspace" : "openrig",
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
      <ul>
        {sections.map((def) => (
          <Section
            key={def.id}
            def={def}
            expanded={!!expanded[def.id]}
            onToggle={() => toggle(def.id)}
          />
        ))}
      </ul>
    </div>
  );
}
