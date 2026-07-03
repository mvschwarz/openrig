// OPR.0.4.1.24 — Workspace PARENT-altitude portfolio (source build).
//
// Founder intent: "the workspace parent altitude is empty — give it a simple
// portfolio of all missions + their steering; missions COLLAPSED by default,
// sorted MOST-RECENTLY-MODIFIED, so I can jump straight to the one I want."
//
// Promotes the founder-approved twin mockup (digital-twin/opr-0.4.1.24/) to real
// data, REUSING the existing project-mission machinery:
//   - missions DERIVED from useSlices (group SliceListEntry by missionId via
//     projectSliceFromListEntry; status via deriveMissionStatusFromSlices),
//   - sorted most-recently-modified via sortProjectMissions
//     (latestProjectMissionActivity desc), COLLAPSED by default.
//   - PER-MISSION STEERING GLANCE = the shipped MISSION_BRIEF.md path
//     (useMission -> useScopeMarkdown, the slice-17 Panel-2 mechanism): each
//     mission's `## Building` + `## Needs you` sections. NO new per-mission
//     STEERING.md source (settled operationally). A mission without a
//     MISSION_BRIEF.md -> a graceful muted glance.
//
// LAZY-LOAD (the slice-17/21 over-fetch lesson): the collapsed landing reads only
// the slice index (one useSlices query, already loaded). A mission's MISSION_BRIEF
// is fetched ONLY when its row is expanded (MissionGlance mounts on expand) — never
// N brief reads on landing.

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useSlices } from "../../hooks/useSlices.js";
import { useMission } from "../../hooks/useMission.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import {
  projectSliceFromListEntry,
  deriveMissionStatusFromSlices,
  sortProjectMissions,
  latestProjectMissionActivity,
  type ProjectMissionGroup,
} from "../../lib/project-mission-state.js";
import { MissionStatusBadge } from "../MissionStatusBadge.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { cn } from "../../lib/utils.js";

function formatActivity(ts: number): string {
  if (!ts || ts <= 0) return "no recent activity";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Extract the named `## <header>` section body from a MISSION_BRIEF.md (slice-16
 *  schema). Returns null when the section is absent. */
function briefSection(markdown: string, header: string): string | null {
  const lines = markdown.split("\n");
  let collecting = false;
  const body: string[] = [];
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (collecting) break; // next section ends the one we want
      collecting = h2[1]!.trim().toLowerCase() === header.toLowerCase();
      continue;
    }
    if (collecting) body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** The expand-only per-mission steering glance: the mission's MISSION_BRIEF.md
 *  Building + Needs-you. Mounts only when the row is expanded → lazy by construction. */
function MissionGlance({ missionId }: { missionId: string }) {
  const mission = useMission(missionId);
  const missionPath =
    mission.data && "missionPath" in mission.data ? mission.data.missionPath : null;
  const brief = useScopeMarkdown(missionPath, "MISSION_BRIEF.md");

  if (mission.isLoading || brief.isLoading) {
    return <div data-testid={`portfolio-glance-loading-${missionId}`} className="font-mono text-[11px] text-on-surface-variant">Loading steering…</div>;
  }

  if (brief.unavailable || !brief.content) {
    return (
      <div data-testid={`portfolio-glance-empty-${missionId}`} className="font-mono text-[11px] text-on-surface-variant">
        No MISSION_BRIEF.md at this mission root yet — the steering glance projects here once it is briefed.
      </div>
    );
  }

  const building = briefSection(brief.content, "Building");
  const needsYou = briefSection(brief.content, "Needs you");
  if (!building && !needsYou) {
    return (
      <div data-testid={`portfolio-glance-thin-${missionId}`} className="font-mono text-[11px] text-on-surface-variant">
        MISSION_BRIEF.md has no Building / Needs-you sections yet.
      </div>
    );
  }

  return (
    <div data-testid={`portfolio-glance-${missionId}`} className="space-y-2">
      {building ? (
        <div>
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">Building</div>
          <MarkdownViewer content={building} hideFrontmatter hideRawToggle />
        </div>
      ) : null}
      {needsYou ? (
        <div>
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">Needs you</div>
          <MarkdownViewer content={needsYou} hideFrontmatter hideRawToggle />
        </div>
      ) : null}
    </div>
  );
}

function MissionRow({ mission, expanded, onToggle }: { mission: ProjectMissionGroup; expanded: boolean; onToggle: () => void }) {
  const recency = latestProjectMissionActivity(mission);
  const sliceCount = mission.slices.length;
  // OPR.0.4.1.24 rev1-r2 forward-fix: the founder-approved rollup is
  // PROVEN/active/slices (proof-of-work, not done-status). hasProofPacket is
  // the proven signal already carried on every ProjectSliceRow.
  const provenCount = mission.slices.filter((s) => s.hasProofPacket).length;
  const activeCount = mission.slices.filter((s) => s.status === "active").length;

  return (
    <article data-testid={`portfolio-mission-${mission.id}`} className="border border-outline-variant bg-surface-lowest/35 backdrop-blur-sm">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          data-testid={`portfolio-toggle-${mission.id}`}
          className="flex flex-1 items-start gap-3 px-4 py-3 text-left hover:bg-surface-lowest/50"
        >
          <span aria-hidden className={cn("mt-0.5 font-mono text-[12px] text-on-surface-variant transition-transform", expanded && "rotate-90 text-on-surface-variant")}>
            ▸
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] uppercase tracking-[0.06em] text-on-surface">{mission.label}</span>
              <MissionStatusBadge status={mission.status} />
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-on-surface-variant">
              {provenCount} proven · {activeCount} active · {sliceCount} slice{sliceCount === 1 ? "" : "s"} · {formatActivity(recency)}
            </div>
          </div>
        </button>
        <Link
          to="/project/mission/$missionId"
          params={{ missionId: mission.id }}
          data-testid={`portfolio-open-${mission.id}`}
          className="flex shrink-0 items-center border-l border-outline-variant px-3 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface-variant hover:bg-surface-lowest/50 hover:text-on-surface"
        >
          Open →
        </Link>
      </div>
      {expanded ? (
        <div className="border-t border-outline-variant bg-surface-lowest/20 px-4 py-3">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">Steering glance · MISSION_BRIEF.md</div>
          <MissionGlance missionId={mission.id} />
        </div>
      ) : null}
    </article>
  );
}

export function WorkspacePortfolioPanel() {
  const { data, isLoading } = useSlices("all");

  const missions = useMemo<ProjectMissionGroup[]>(() => {
    if (!data || "unavailable" in data) return [];
    const buckets = new Map<string, ProjectMissionGroup["slices"]>();
    for (const slice of data.slices) {
      const row = projectSliceFromListEntry(slice);
      const key = row.missionId ?? row.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }
    return Array.from(buckets.entries())
      .map(([key, slices]) => ({
        id: key,
        label: key === "unsorted" ? "Unsorted" : key,
        status: deriveMissionStatusFromSlices(slices),
        slices,
      }))
      .sort(sortProjectMissions); // most-recently-modified first
  }, [data]);

  // COLLAPSED by default (the founder's landing requirement). Empty set = all collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (isLoading) {
    return <EmptyState label="LOADING WORKSPACE" description="Reading the mission index." variant="card" testId="portfolio-loading" />;
  }
  if (data && "unavailable" in data) {
    return (
      <EmptyState
        label="WORKSPACE INDEX UNAVAILABLE"
        description={data.hint ?? "The slice index is not available from the configured workspace."}
        variant="card"
        testId="portfolio-unavailable"
      />
    );
  }
  if (missions.length === 0) {
    return (
      <EmptyState
        label="NO MISSIONS YET"
        description="No missions are indexed in this workspace. Missions appear here as you create them; each row opens to its steering glance."
        variant="card"
        testId="portfolio-empty"
      />
    );
  }

  return (
    <div data-testid="workspace-portfolio" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <SectionHeader>Portfolio · all missions</SectionHeader>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-on-surface-variant">
          {missions.length} mission{missions.length === 1 ? "" : "s"} · most recently modified
        </span>
      </div>
      <div className="space-y-2">
        {missions.map((mission) => (
          <MissionRow
            key={mission.id}
            mission={mission}
            expanded={expanded.has(mission.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(mission.id)) next.delete(mission.id);
                else next.add(mission.id);
                return next;
              })
            }
          />
        ))}
      </div>
    </div>
  );
}
