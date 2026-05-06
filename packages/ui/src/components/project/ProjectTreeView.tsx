// V1 attempt-3 Phase 3 — Project tree per project-tree.md L13–L46 + SC-24.
//
// Workspace > mission > slice tree. V1 groups slices by railItem (the
// existing slice rail-item is the closest analog to "mission" in the
// current data model); workspace level is the single openrig-work
// surface. Phase 5 polish + filesystem mission discovery is the V2 path.

import { useState, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSlices } from "../../hooks/useSlices.js";
import { MissionStatusBadge, type MissionStatus } from "../MissionStatusBadge.js";

type GroupedMission = {
  id: string;
  label: string;
  status: MissionStatus;
  slices: Array<{ name: string; displayName: string; status: string }>;
};

function deriveStatus(slices: Array<{ status: string }>): MissionStatus {
  if (slices.length === 0) return "unknown";
  if (slices.some((s) => s.status === "blocked")) return "blocked";
  if (slices.some((s) => s.status === "active")) return "active";
  if (slices.every((s) => s.status === "done")) return "shipped";
  return "active";
}

export function ProjectTreeView() {
  const { data: slicesResp } = useSlices("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    workspace: true,
  });
  const toggle = (k: string) =>
    setExpanded((p) => ({ ...p, [k]: !p[k] }));

  const missions = useMemo<GroupedMission[]>(() => {
    // useSlices returns SliceListResponse | SlicesUnavailable; the unavailable
    // case (slices_root_not_configured) lacks the `slices` field — guard for it.
    const list = slicesResp && "slices" in slicesResp ? slicesResp.slices : [];
    const buckets = new Map<string, GroupedMission["slices"]>();
    for (const s of list) {
      const key = s.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({
        name: s.name,
        displayName: s.displayName,
        status: s.status,
      });
    }
    return Array.from(buckets.entries()).map(([k, slices]) => ({
      id: k,
      label: k === "unsorted" ? "Unsorted" : k,
      status: deriveStatus(slices),
      slices,
    }));
  }, [slicesResp]);

  return (
    <div data-testid="project-tree-view" className="flex-1 overflow-y-auto py-2">
      <ul>
        <li data-testid="project-workspace-node">
          <button
            type="button"
            onClick={() => toggle("workspace")}
            className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
            data-testid="project-workspace-toggle"
          >
            {expanded.workspace ? (
              <ChevronDown className="h-3 w-3 text-on-surface-variant" />
            ) : (
              <ChevronRight className="h-3 w-3 text-on-surface-variant" />
            )}
            <span className="font-mono text-[11px] uppercase tracking-wide text-stone-900 flex-1">
              openrig-work
            </span>
            <Link
              to="/project"
              data-testid="project-workspace-link"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant hover:text-stone-900"
            >
              open
            </Link>
          </button>
          {expanded.workspace ? (
            <ul className="ml-4 border-l border-stone-200">
              {missions.length === 0 ? (
                <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
                  No missions yet.
                </li>
              ) : (
                missions.map((m) => (
                  <li key={m.id} data-testid={`project-mission-${m.id}`}>
                    <button
                      type="button"
                      onClick={() => toggle(`mission-${m.id}`)}
                      className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low text-left"
                      data-testid={`project-mission-toggle-${m.id}`}
                    >
                      {expanded[`mission-${m.id}`] ? (
                        <ChevronDown className="h-3 w-3 text-on-surface-variant" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-on-surface-variant" />
                      )}
                      <span className="font-mono text-[11px] text-stone-900 flex-1 truncate">
                        {m.label}
                      </span>
                      <MissionStatusBadge status={m.status} testId={`project-mission-${m.id}-badge`} />
                    </button>
                    {expanded[`mission-${m.id}`] ? (
                      <ul className="ml-4 border-l border-stone-200">
                        {m.slices.map((s) => (
                          <li key={s.name}>
                            <Link
                              to="/project/slice/$sliceId"
                              params={{ sliceId: s.name }}
                              data-testid={`project-slice-${s.name}`}
                              className="block px-2 py-0.5 font-mono text-xs text-on-surface hover:text-stone-900 hover:bg-surface-low truncate"
                            >
                              {s.displayName}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </li>
      </ul>
    </div>
  );
}
