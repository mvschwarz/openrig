// OPR.0.4.6.WF4 (C4) — instance rows over GET /api/workflow/list (the same
// read the WF-3 CLI projects; FR-4 parity — no UI-side recomputation, every
// cell below is a recorded field or the daemon's own derived deadline verdict).
//
// Used twice: Option A (the Library spec page's "runs of THIS spec" band,
// filtered by workflowName) and the /workflows altitude (unfiltered, grouped by
// the caller). Zero instances renders NOTHING when `quietWhenEmpty` — the
// shipped Library page stays byte-identical (the zero-regression AC).

import { Link } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import {
  useWorkflowInstances,
  type WorkflowInstanceWithDeadline,
} from "../../hooks/useWorkflow.js";

/** Attention-first ordering: exceptions outrank the healthy, live outranks the
 *  finished — the NEEDS-YOU-first reading order at every altitude. */
export function instanceAttentionRank(i: WorkflowInstanceWithDeadline): number {
  if (i.status === "failed") return 0;
  if (i.deadline.state !== "healthy") return 1;
  if (i.status === "waiting") return 2;
  if (i.status === "active") return 3;
  return 4; // completed
}

function statusChip(i: WorkflowInstanceWithDeadline): { glyph: string; label: string; cls: string } {
  if (i.status === "failed") return { glyph: "▲", label: "FAILED", cls: "text-red-700" };
  if (i.deadline.state !== "healthy") return { glyph: "▲", label: i.deadline.state.toUpperCase(), cls: "text-amber-700" };
  if (i.status === "waiting") return { glyph: "◐", label: "WAITING", cls: "text-on-surface-variant" };
  if (i.status === "active") return { glyph: "●", label: "ACTIVE", cls: "text-emerald-800" };
  return { glyph: "○", label: "COMPLETED", cls: "text-on-surface-variant" };
}

function shortUlid(id: string): string {
  return `…${id.slice(-6)}`;
}

function ageLabel(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

/** The recorded live position, honest to the list payload: an active/waiting
 *  instance has the durable currentStepId binding; terminal instances have it
 *  cleared (read the trail on the instance page for where it ended). */
function positionLabel(i: WorkflowInstanceWithDeadline): string {
  if (i.currentStepId) return `at ${i.currentStepId}`;
  if (i.status === "completed") return "closed";
  if (i.status === "failed") return "felled";
  return "—";
}

export function WorkflowInstanceRow({ instance }: { instance: WorkflowInstanceWithDeadline }) {
  const chip = statusChip(instance);
  return (
    <li>
      <Link
        to="/workflow/instance/$instanceId"
        params={{ instanceId: instance.instanceId }}
        data-testid={`workflow-instance-row-${instance.instanceId}`}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-variant/50"
      >
        <span className={cn("font-mono text-[11px]", chip.cls)} aria-hidden>
          {chip.glyph}
        </span>
        <span className={cn("font-mono text-[9px] uppercase w-32 shrink-0", chip.cls)}>{chip.label}</span>
        <span className="font-mono text-[11px] text-on-surface" title={instance.instanceId}>
          {shortUlid(instance.instanceId)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface">
          {positionLabel(instance)}
          <span className="text-on-surface-variant"> · hop {instance.hopCount}</span>
          {instance.resumeCount > 0 ? (
            <span className="text-on-surface-variant"> · resumed {instance.resumeCount}×</span>
          ) : null}
        </span>
        {instance.deadline.state !== "healthy" && instance.deadline.evidence ? (
          <span className="hidden font-mono text-[10px] text-amber-800 md:inline truncate max-w-64">
            {instance.deadline.evidence.ownerSession} · {Math.floor(instance.deadline.evidence.overdueBySeconds / 60)}m over
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(instance.createdAt)}</span>
        <span className="font-mono text-[10px] text-on-surface-variant" aria-hidden>
          →
        </span>
      </Link>
    </li>
  );
}

/** Select the instances a spec band shows: name+version discrimination (a
 *  name-only filter mixes versions across specs that share a name — guard
 *  blocker 2) + the attention-first sort. Pure; the render is proven in the VM
 *  lease. */
export function selectSpecInstances(
  rows: readonly WorkflowInstanceWithDeadline[],
  workflowName?: string,
  workflowVersion?: string,
): WorkflowInstanceWithDeadline[] {
  return rows
    .filter((i) => (workflowName ? i.workflowName === workflowName : true))
    .filter((i) => (workflowVersion ? i.workflowVersion === workflowVersion : true))
    .slice()
    .sort((a, b) => instanceAttentionRank(a) - instanceAttentionRank(b));
}

export function WorkflowInstancesBand({
  workflowName,
  workflowVersion,
  testId,
  quietWhenEmpty = true,
}: {
  /** Filter to runs of one spec (the Option-A spec-page band). `workflowVersion`
   *  pins the EXACT spec: two cached specs can share a name across versions and
   *  the Library page is "runs of THIS spec", so a name-only filter would mix
   *  versions (guard blocker 2). */
  workflowName?: string;
  workflowVersion?: string;
  testId?: string;
  /** Option A: absent instances render nothing (zero-regression). The
   *  /workflows altitude passes false and owns its own empty state. */
  quietWhenEmpty?: boolean;
}) {
  const { data, isLoading } = useWorkflowInstances();
  const rows = selectSpecInstances(data ?? [], workflowName, workflowVersion);

  if (isLoading || rows.length === 0) {
    if (quietWhenEmpty) return null;
    return (
      <p data-testid={testId ? `${testId}-empty` : undefined} className="font-mono text-[11px] text-on-surface-variant">
        {isLoading ? "Loading instances…" : "0 instances — computed from /api/workflow/list"}
      </p>
    );
  }

  const live = rows.filter((r) => r.status === "active" || r.status === "waiting").length;
  const exceptional = rows.filter((r) => instanceAttentionRank(r) <= 1).length;

  return (
    <div data-testid={testId ?? "workflow-instances-band"} className="space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">
        Instances
        <span className="ml-2 normal-case tracking-normal">
          {rows.length} total · {live} live{exceptional > 0 ? ` · ${exceptional} need attention` : ""}
        </span>
      </div>
      <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
        {rows.map((i) => (
          <WorkflowInstanceRow key={i.instanceId} instance={i} />
        ))}
      </ul>
    </div>
  );
}
