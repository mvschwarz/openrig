// V1 attempt-3 Phase 3 — Specs tree per specs-tree.md L13–L46 + SC-27.
//
// 6 sections (rigs / workspaces / workflows / context-packs / agent-images
// / applications). useSpecLibrary surfaces rig / agent / workflow today;
// the remaining 3 sections render with V2 placeholders so the canonical
// tree shape is correct.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useSpecLibrary } from "../../hooks/useSpecLibrary.js";

interface SectionDef {
  id: string;
  label: string;
  matchKind?: string;
  v2Note?: string;
}

const SECTIONS: SectionDef[] = [
  { id: "rigs", label: "Rigs", matchKind: "rig" },
  { id: "workspaces", label: "Workspaces", v2Note: "V2" },
  { id: "workflows", label: "Workflows", matchKind: "workflow" },
  { id: "context-packs", label: "Context Packs", v2Note: "V2" },
  { id: "agent-images", label: "Agent Images", matchKind: "agent" },
  { id: "applications", label: "Applications", v2Note: "V2" },
];

function Section({
  def,
  expanded,
  onToggle,
  entries,
}: {
  def: SectionDef;
  expanded: boolean;
  onToggle: () => void;
  entries: Array<{ id: string; name: string; relativePath: string }> | null;
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
        {def.v2Note ? (
          <span className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">
            {def.v2Note}
          </span>
        ) : entries ? (
          <span className="font-mono text-[10px] text-on-surface-variant">{entries.length}</span>
        ) : null}
      </button>
      {expanded ? (
        <ul className="ml-5 border-l border-stone-200">
          {def.v2Note ? (
            <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
              Coming in V2.
            </li>
          ) : entries && entries.length > 0 ? (
            entries.map((e) => (
              <li key={e.id} className="px-2 py-0.5">
                <Link
                  to="/specs/library/$entryId"
                  params={{ entryId: e.id }}
                  data-testid={`specs-leaf-${e.id}`}
                  className="block font-mono text-xs text-on-surface hover:text-stone-900 hover:bg-surface-low truncate"
                >
                  {e.name}
                </Link>
              </li>
            ))
          ) : (
            <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
              No {def.label.toLowerCase()} yet.
            </li>
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function SpecsTreeView() {
  const { data: library } = useSpecLibrary();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    rigs: true,
    workflows: false,
    "agent-images": false,
    workspaces: false,
    "context-packs": false,
    applications: false,
  });
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div data-testid="specs-tree-view" className="flex-1 overflow-y-auto py-2">
      <div className="px-2 mb-2">
        <Link
          to="/specs"
          data-testid="specs-tree-overview-link"
          className="block font-mono text-[11px] uppercase tracking-wide text-stone-900 px-2 py-1 hover:bg-surface-low"
        >
          {"> "}Specs library
        </Link>
      </div>
      <ul>
        {SECTIONS.map((def) => {
          const entries = def.matchKind && library
            ? library
                .filter((e) => e.kind === def.matchKind)
                .map((e) => ({ id: e.id, name: e.name, relativePath: e.relativePath }))
            : null;
          return (
            <Section
              key={def.id}
              def={def}
              expanded={!!expanded[def.id]}
              onToggle={() => toggle(def.id)}
              entries={entries}
            />
          );
        })}
      </ul>
    </div>
  );
}
