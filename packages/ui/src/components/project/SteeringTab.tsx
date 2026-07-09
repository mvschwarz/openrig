// OPR.0.4.1.17 — Mission Steering tab (the mission LANDING). Two stacked READ-ONLY
// projections, top-to-bottom: Panel 1 = the live STEERING.md directive (what agents are told
// to do right now, traceable to its source) via GET /api/steering; Panel 2 = the human-facing
// brief (MISSION_BRIEF.md, projected to the slice-16 pinned schema). It reads, never writes;
// it introduces no new write path and no new STEERING source contract.

import type { ReactNode } from "react";
import {
  useSteering,
  type SteeringPayload,
  type SteeringUnavailable,
} from "../../hooks/useSteering.js";
import { useMission } from "../../hooks/useMission.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { useHostSelection, useLocalFilesAllowed } from "../../hooks/useHosts.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";

function isUnavailable(
  data: SteeringPayload | SteeringUnavailable | undefined,
): data is SteeringUnavailable {
  return Boolean(data && "unavailable" in data);
}

// --- Panel 1: STEERING.md projection (GET /api/steering) ------------------------------
function SteeringPanel() {
  const { data, isLoading, error } = useSteering();

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div data-testid="steering-panel-loading" className="font-mono text-[11px] text-on-surface-variant">
        Loading…
      </div>
    );
  } else if (error) {
    body = (
      <EmptyState
        label="STEERING UNAVAILABLE"
        description={(error as Error)?.message ?? "Could not load /api/steering."}
        variant="card"
        testId="steering-panel-error"
      />
    );
  } else if (isUnavailable(data)) {
    // The daemon's steering_workspace_not_configured 503 surfaces as this sentinel.
    body = (
      <div data-testid="steering-panel-unavailable">
        <EmptyState
          label="NO STEERING CONFIGURED"
          description={
            data.hint ??
            "Set workspace.steering_path to a STEERING.md so the live directive projects here."
          }
          variant="card"
          testId="steering-panel-unavailable-state"
        />
      </div>
    );
  } else if (data?.priorityStack) {
    const ps = data.priorityStack;
    body = (
      <>
        <div data-testid="steering-panel-content" className="mt-1">
          <MarkdownViewer content={ps.content} hideFrontmatter hideRawToggle />
        </div>
        {/* Off-intent → traceable-to-source: the live directive + where it lives. */}
        <div data-testid="steering-panel-source" className="mt-2 font-mono text-[10px] text-on-surface-variant">
          source: {ps.absolutePath} · updated {new Date(ps.mtime).toLocaleString()}
        </div>
      </>
    );
  } else {
    body = (
      <EmptyState
        label="NO STEERING.md YET"
        description="No STEERING.md content at the configured workspace.steering_path. The live directive projects here once it exists."
        variant="card"
        testId="steering-panel-empty"
      />
    );
  }

  return (
    <section data-testid="steering-panel" className="border border-outline-variant bg-surface-lowest/30 p-4">
      <SectionHeader>Steering · STEERING.md</SectionHeader>
      {body}
    </section>
  );
}

// --- Panel 2: MISSION_BRIEF.md projection (slice-16 pinned contract) -------------------
// Byte-exact canonical headers + order. The scaffold, the populate SOP, and this projector
// all copy THESE strings — never re-derived (a mismatch = the brief silently never renders).
const BRIEF_SECTIONS = ["What & why", "Building", "Progress", "Proven", "Needs you", "Pointers"];

interface ParsedBrief {
  title: string | null;
  tldr: string | null;
  sections: { header: string; body: string }[];
}

/** Split MISSION_BRIEF.md into the leading `#` title (+ optional italic TL;DR) and the `##`
 *  sections in DOCUMENT ORDER. Unknown sections are preserved (never dropped). */
function parseBrief(markdown: string): ParsedBrief {
  let title: string | null = null;
  let tldr: string | null = null;
  const sections: { header: string; body: string[] }[] = [];
  let current: { header: string; body: string[] } | null = null;
  let sawTitle = false;

  for (const line of markdown.split("\n")) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h2) {
      current = { header: h2[1]!.trim(), body: [] };
      sections.push(current);
    } else if (h1 && !sawTitle && !current) {
      title = h1[1]!.trim();
      sawTitle = true;
    } else if (current) {
      current.body.push(line);
    } else if (sawTitle && tldr === null && line.trim().length > 0) {
      tldr = line.trim();
    }
  }
  return {
    title,
    tldr,
    sections: sections.map((s) => ({ header: s.header, body: s.body.join("\n").trim() })),
  };
}

function BriefSectionBlock({ header, body }: { header: string; body: string | undefined }) {
  return (
    <div data-testid={`brief-section-${header}`} className="border-t border-outline-variant/60 py-2">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-on-surface">{header}</div>
      {body && body.length > 0 ? (
        <div className="mt-1">
          <MarkdownViewer content={body} hideFrontmatter hideRawToggle />
        </div>
      ) : (
        // Missing OR empty canonical section → muted dash (degrade-to-dash; shows the
        // expected shape + tells the populator what to fill).
        <div data-testid={`brief-section-${header}-dash`} className="mt-1 font-mono text-[12px] text-on-surface-variant">
          —
        </div>
      )}
    </div>
  );
}

function BriefPanel({ missionId }: { missionId: string | null }) {
  const mission = useMission(missionId ?? "");
  // OPR.0.4.6.MH2 guard-B1 — useMission is selected-host retargeted, so
  // under a remote selection missionPath is a REMOTE path: it must never
  // resolve against LOCAL allowlist roots (zero /api/files/* + honest copy).
  const { known: selectionKnown, isLocal } = useHostSelection();
  const filesAllowed = useLocalFilesAllowed();
  const missionPath =
    filesAllowed && mission.data && "missionPath" in mission.data ? mission.data.missionPath : null;
  const brief = useScopeMarkdown(missionPath, "MISSION_BRIEF.md");

  let body: ReactNode;
  if (selectionKnown && !isLocal) {
    // Known-REMOTE only — an unknown selection renders the loading branch
    // below (fetches stay gated either way; no misleading gated flash).
    body = (
      <div data-testid="brief-panel-remote-gated">
        <EmptyState
          label="LOCAL FILES NOT SHOWN"
          description="The mission brief lives on the selected host's filesystem, which the remote read view does not browse. Select the local host to read local briefs."
          variant="card"
          testId="brief-panel-remote-gated-state"
        />
      </div>
    );
  } else if (!selectionKnown || mission.isLoading || brief.isLoading) {
    body = (
      <div data-testid="brief-panel-loading" className="font-mono text-[11px] text-on-surface-variant">
        Loading…
      </div>
    );
  } else if (brief.unavailable || brief.content === null) {
    body = (
      <div data-testid="brief-panel-empty">
        <EmptyState
          label="NO BRIEF YET"
          description="No MISSION_BRIEF.md at the mission root. The human-facing brief (what we're building · how far · what's proven · what needs you) projects here once the mission is briefed."
          variant="card"
          testId="brief-panel-empty-state"
        />
      </div>
    );
  } else {
    const parsed = parseBrief(brief.content);
    const knownSet = new Set(BRIEF_SECTIONS);
    const bodyByHeader = new Map(parsed.sections.map((s) => [s.header, s.body]));
    const extras = parsed.sections.filter((s) => !knownSet.has(s.header));
    body = (
      <div data-testid="brief-panel-content">
        {parsed.title && (
          <div className="font-mono text-[13px] uppercase tracking-[0.08em] text-on-surface">{parsed.title}</div>
        )}
        {parsed.tldr && <p className="mt-0.5 text-[12px] italic text-on-surface-variant">{parsed.tldr}</p>}
        {/* Canonical sections, in contract order, by EXACT header match. */}
        {BRIEF_SECTIONS.map((header) => (
          <BriefSectionBlock key={header} header={header} body={bodyByHeader.get(header)} />
        ))}
        {/* Unknown/extra sections render AFTER the known ones, in document order — never dropped. */}
        {extras.map((s, i) => (
          <BriefSectionBlock key={`extra-${i}-${s.header}`} header={s.header} body={s.body} />
        ))}
      </div>
    );
  }

  return (
    <section data-testid="brief-panel" className="border border-outline-variant bg-surface-lowest/20 p-4">
      <SectionHeader>Brief · human-facing</SectionHeader>
      {body}
    </section>
  );
}

export function SteeringTab({ missionId }: { missionId: string | null }) {
  return (
    <div data-testid="steering-tab" className="space-y-6">
      <SteeringPanel />
      <BriefPanel missionId={missionId} />
    </div>
  );
}
