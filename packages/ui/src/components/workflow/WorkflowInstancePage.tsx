// OPR.0.4.6.WF4 (C4) — the instance detail page (the FR-2 reference shape).
//
// ZOOM-ADDRESSED, not nav chrome (the /agents precedent): reached from instance
// rows (Library band / the /workflows altitude) and from NEEDS-YOU workflow
// rows (deep-linked with the FR-3 `?step=` anchor), never from a nav rail.
//
// One source of truth, two projections (FR-4): everything here is the SAME read
// `rig workflow trace` projects — GET /api/workflow/:id/trace (instance + trail,
// deadline verdict attached) — plus the workflow SHAPE from the Library review
// payload, composed client-side (no UI-side recomputation, BR-4).
//
// v1 mutation surface = RESUME only (a thin client of the shipped POST
// /:id/resume). ROUTE-FROM-WEB is DEFERRED (pm ruling) — the twin's RE-ROUTE
// affordance is intentionally OMITTED here; the stuck frame renders the evidence
// + resume, not a re-route button. This is the one disclosed twin-vs-build delta.

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { PageHeader } from "../ui/page-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { StatusBadge } from "../ui/status-badge.js";
import { cn } from "../../lib/utils.js";
import { WorkspacePage } from "../WorkspacePage.js";
import { useLibraryReview, type LibraryWorkflowReview } from "../../hooks/useSpecLibrary.js";
import {
  useWorkflowTrace,
  type WorkflowInstanceWithDeadline,
  type WorkflowStepTrailEntry,
} from "../../hooks/useWorkflow.js";
import { WorkflowTopologyGraph } from "./WorkflowTopologyGraph.js";
import { InstanceTrailTimeline } from "./InstanceTrailTimeline.js";

function fmtTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

// The surface identity for human web actions (matches SliceReviewTab /
// RigAgentsPage / MissionReviewTab). Resume is a HUMAN redrive from the web.
const SURFACE_ACTOR = "human@host";

/** POST /api/workflow/:id/resume — a thin client of the shipped WF-5 redrive.
 *  The route requires a structured `actorSession` (routes/workflow.ts:266) and
 *  400s without it — send it from the surface identity, never a prose value. */
export async function postResume(instanceId: string): Promise<void> {
  const res = await fetch(`/api/workflow/${encodeURIComponent(instanceId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorSession: SURFACE_ACTOR }),
  });
  if (!res.ok) throw new Error(`resume failed — HTTP ${res.status}`);
}

/** Position history from the recorded trail: visited steps + the taken
 *  consecutive step→step edges (+ the hop into the live current step).
 *  Derivation only — pairs with no matching shape edge style nothing. */
function takenFromTrail(
  trail: WorkflowStepTrailEntry[],
  currentStepId: string | null,
): { visited: string[]; edgeKeys: string[] } {
  const seq = trail.map((t) => t.stepId);
  if (currentStepId) seq.push(currentStepId);
  const edgeKeys: string[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    if (seq[i] !== seq[i + 1]) edgeKeys.push(`${seq[i]}→${seq[i + 1]}`);
  }
  return { visited: trail.map((t) => t.stepId), edgeKeys };
}

function ExceptionTone(instance: WorkflowInstanceWithDeadline): { card: string; text: string } {
  const failed = instance.status === "failed";
  const overdue = instance.deadline.state !== "healthy" && instance.deadline.evidence;
  if (failed || overdue) return { card: "border-destructive/60 bg-destructive/5", text: "text-destructive" };
  return { card: "border-amber-700/60 bg-amber-700/5", text: "text-amber-800" };
}

export function ExceptionBanner({
  instance,
  onResume,
  resuming,
  resumeError,
}: {
  instance: WorkflowInstanceWithDeadline;
  onResume: () => void;
  resuming: boolean;
  resumeError: string | null;
}) {
  const gated = instance.status === "waiting" && instance.currentStepId != null;
  const overdue = instance.deadline.state !== "healthy" && instance.deadline.evidence;
  const failed = instance.status === "failed";
  if (!gated && !overdue && !failed) return null;

  const tone = ExceptionTone(instance);
  return (
    <div data-testid="workflow-exception-banner" className={cn("space-y-2 rounded-lg border px-3 py-2 text-sm", tone.card)}>
      {failed ? (
        <p className={cn("text-sm", tone.text)}>
          <StatusBadge status={instance.status} /> No remediation branch mapped for the failing exit
          {instance.resumeCount > 0 ? ` · resumed ${instance.resumeCount}× already` : ""}
        </p>
      ) : null}
      {overdue ? (
        <p className={cn("text-sm", tone.text)}>
          <StatusBadge status={instance.deadline.state} /> step {instance.deadline.evidence!.stepId ?? "(unbound)"} packet{" "}
          <span className="font-mono text-xs">{instance.deadline.evidence!.packetId}</span> held by{" "}
          <span className="font-mono text-xs">{instance.deadline.evidence!.ownerSession}</span>,{" "}
          {Math.floor(instance.deadline.evidence!.overdueBySeconds / 60)}m past its{" "}
          {instance.deadline.evidence!.anchor} anchor
        </p>
      ) : null}
      {gated && !overdue && !failed ? (
        <p className={cn("text-sm", tone.text)}>
          Waiting at <span className="font-mono text-xs">{instance.currentStepId}</span> — the gate packet is parked pending sign-off; resolving the
          NEEDS-YOU item resumes the deterministic flow
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
        {failed ? (
          <button
            type="button"
            data-testid="workflow-resume"
            disabled={resuming}
            onClick={onResume}
            className="border border-outline px-3 py-1 text-xs hover:bg-surface-variant disabled:cursor-not-allowed disabled:opacity-50"
            title={`POST /api/workflow/${instance.instanceId}/resume — redrive from the failed step (WF-5 FR-4)`}
          >
            {resuming ? "Resuming…" : "Resume"}
          </button>
        ) : null}
        {/* ROUTE-FROM-WEB DEFERRED (pm ruling) — the twin's RE-ROUTE affordance
            is intentionally OMITTED in v1; the disclosed twin-vs-build delta. */}
        {resumeError ? (
          <span data-testid="workflow-resume-error" className="font-mono text-xs text-red-700">
            {resumeError}
          </span>
        ) : null}
        <span className="font-mono text-xs">
          CLI: rig workflow trace {instance.instanceId}
        </span>
      </div>
    </div>
  );
}

export function WorkflowInstancePage({
  instanceId,
  anchorStepId,
}: {
  instanceId: string;
  /** The FR-3 `?step=` deep-link anchor. */
  anchorStepId?: string | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: trace, isLoading, error } = useWorkflowTrace(instanceId);
  const specLibraryId = trace ? `workflow:${trace.instance.workflowName}:${trace.instance.workflowVersion}` : null;
  const { data: specReview } = useLibraryReview(specLibraryId);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const onResume = () => {
    setResuming(true);
    setResumeError(null);
    void postResume(instanceId)
      .then(() => queryClient.invalidateQueries({ queryKey: ["workflow"] }))
      .catch((e: unknown) => setResumeError((e as Error).message))
      .finally(() => setResuming(false));
  };

  if (isLoading) {
    return (
      <WorkspacePage>
        <div className="text-xs text-on-surface-variant">Loading workflow instance…</div>
      </WorkspacePage>
    );
  }
  if (error || !trace) {
    return (
      <WorkspacePage>
        <div data-testid="workflow-instance-error" className="space-y-4 text-sm">
          <PageHeader
            title="Instance not found"
            description={(error as Error)?.message ?? `No workflow instance ${instanceId}.`}
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/workflows" })}>
            Back to Workflows
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  const { instance, trail } = trace;
  const { visited, edgeKeys } = takenFromTrail(trail, instance.currentStepId);
  const workflowReview =
    specReview && (specReview as LibraryWorkflowReview).kind === "workflow"
      ? (specReview as LibraryWorkflowReview)
      : null;
  const statusLabel = instance.deadline.state !== "healthy" ? instance.deadline.state : instance.status;

  return (
    <WorkspacePage>
      <div data-testid="workflow-instance-page" className="space-y-6 text-sm">
        <PageHeader
          title={`Workflow run ${instance.instanceId}`}
          description={
            instance.currentStepId
              ? `${instance.status} at ${instance.currentStepId} · hop ${instance.hopCount}`
              : `${instance.status} · hop ${instance.hopCount}`
          }
          actions={
            <div className="flex gap-2 items-center">
              <Button
                variant="outline"
                size="sm"
                data-testid="workflow-view-spec"
                onClick={() =>
                  specLibraryId && navigate({ to: "/specs/library/$entryId", params: { entryId: specLibraryId } })
                }
              >
                View Spec
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/workflows" })}>
                Back
              </Button>
            </div>
          }
        />

        <div className="grid gap-3 rounded-lg border bg-surface-lowest p-4 shadow-sm sm:grid-cols-2 xl:grid-cols-4">
          <WorkflowSummaryCell label="Status" testId="wf-inst-status">
            <StatusBadge status={statusLabel} />
          </WorkflowSummaryCell>
          <WorkflowSummaryCell
            label="Position"
            testId="wf-inst-position"
            mono
            value={instance.currentStepId ?? (instance.status === "completed" ? "closed" : "felled")}
          />
          <WorkflowSummaryCell label="Hops" testId="wf-inst-hops" mono value={instance.hopCount} />
          <WorkflowSummaryCell label="Resumes" testId="wf-inst-resumes" mono value={instance.resumeCount} />
        </div>

        <p data-testid="wf-inst-provenance" className="font-mono text-xs text-on-surface-variant">
          created by {instance.createdBySession} · {fmtTime(instance.createdAt)}
          {instance.completedAt ? ` · completed ${fmtTime(instance.completedAt)}` : ""}
        </p>

        <ExceptionBanner instance={instance} onResume={onResume} resuming={resuming} resumeError={resumeError} />

        {workflowReview ? (
          <WorkflowTopologyGraph
            topology={workflowReview.topology}
            testId="workflow-instance-graph"
            currentStepId={instance.currentStepId}
            visitedStepIds={visited}
            takenEdgeKeys={edgeKeys}
          />
        ) : (
          <EmptyState
            title="Shape unavailable"
            label="Shape unavailable"
            description="The workflow shape is not in the library cache."
            variant="card"
            testId="workflow-instance-shape-empty"
          />
        )}

        <InstanceTrailTimeline trail={trail} instance={instance} anchorStepId={anchorStepId} />
      </div>
    </WorkspacePage>
  );
}

function WorkflowSummaryCell({
  label,
  value,
  testId,
  mono,
  children,
}: {
  label: string;
  value?: React.ReactNode;
  testId: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-on-surface-variant">{label}</div>
      <div data-testid={testId} className={mono ? "mt-2 font-mono text-xs text-on-surface" : "mt-2 text-sm text-on-surface"}>
        {children ?? value}
      </div>
    </div>
  );
}
