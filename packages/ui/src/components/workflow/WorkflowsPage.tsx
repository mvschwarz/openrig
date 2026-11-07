// OPR.0.4.6.WF4 (C4) Option B — the operational WORKFLOWS altitude.
//
// ZOOM-ADDRESSED like /agents (arch drift-killer 4 — deliberately not in any
// nav rail; pm/founder confirmed addressable-not-in-nav for v1, no rail icon):
// reached from NEEDS-YOU workflow rows, instance deep-links, and the Library
// page. One glance answers: what is running, where each instance is, what needs
// attention — attention FIRST, in the blessed NEEDS-YOU-first reading order.
//
// FR-4 parity: composed CLIENT-side over the same GET /api/workflow/list +
// /api/workflow/specs reads the WF-3 CLI composes its status rollup from
// (commands/workflow.ts defers a daemon rollup endpoint to a named future
// trigger; this page does arithmetic over daemon-classified rows only, Q4).

import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageHeader } from "../ui/page-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { StatusBadge } from "../ui/status-badge.js";
import { WorkspacePage } from "../WorkspacePage.js";
import {
  useWorkflowInstances,
  useWorkflowSpecs,
  type WorkflowInstanceWithDeadline,
} from "../../hooks/useWorkflow.js";
import { WorkflowInstanceRow, instanceAttentionRank } from "./WorkflowInstancesBand.js";

function groupByWorkflow(
  rows: WorkflowInstanceWithDeadline[],
): Array<{ key: string; name: string; version: string; rows: WorkflowInstanceWithDeadline[] }> {
  const byKey = new Map<string, WorkflowInstanceWithDeadline[]>();
  for (const r of rows) {
    const key = `${r.workflowName}:${r.workflowVersion}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const groups = [...byKey.entries()].map(([key, groupRows]) => ({
    key,
    name: groupRows[0]!.workflowName,
    version: groupRows[0]!.workflowVersion,
    rows: groupRows.sort((a, b) => instanceAttentionRank(a) - instanceAttentionRank(b)),
  }));
  // Attention-first between groups too: a group ranks by its hottest row.
  groups.sort((a, b) => instanceAttentionRank(a.rows[0]!) - instanceAttentionRank(b.rows[0]!));
  return groups;
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const { data: instances, isLoading } = useWorkflowInstances();
  const { data: specsData } = useWorkflowSpecs();

  const rows = instances ?? [];
  const groups = groupByWorkflow(rows);
  const attention = rows.filter((r) => instanceAttentionRank(r) <= 1).length;
  const live = rows.filter((r) => r.status === "active" || r.status === "waiting").length;
  const closed = rows.filter((r) => r.status === "completed").length;

  const instantiatedNames = new Set(rows.map((r) => `${r.workflowName}:${r.workflowVersion}`));
  const idleSpecs = (specsData?.specs ?? []).filter((s) => !instantiatedNames.has(`${s.name}:${s.version}`));

  return (
    <WorkspacePage>
      <div data-testid="workflows-page" className="space-y-6 text-sm">
        <PageHeader
          title="Workflows"
          description={
            isLoading
              ? "Loading instances…"
              : `${rows.length} instance${rows.length === 1 ? "" : "s"} · ${attention} need attention · ${live} live · ${closed} completed — computed from /api/workflow/list`
          }
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>
              Workflow Library
            </Button>
          }
        />

        {rows.length === 0 && !isLoading ? (
          <EmptyState
            title="No workflow instances"
            label="No workflow instances"
            description="Instantiate one from a library spec (rig workflow instantiate) and it appears here with its live position."
            action={{ label: "Open workflow library", href: "/specs" }}
            variant="card"
            testId="workflows-empty"
          />
        ) : null}

        {groups.map((g) => {
          const gAttention = g.rows.filter((r) => instanceAttentionRank(r) <= 1).length;
          const gLive = g.rows.filter((r) => r.status === "active" || r.status === "waiting").length;
          return (
            <section key={g.key} data-testid={`workflows-group-${g.name}`} className="space-y-2 rounded-lg border bg-surface-lowest shadow-sm">
              <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant px-3 py-2">
                <button
                  type="button"
                  data-testid={`workflows-group-spec-${g.name}`}
                  onClick={() =>
                    navigate({
                      to: "/specs/library/$entryId",
                      params: { entryId: `workflow:${g.name}:${g.version}` },
                    })
                  }
                  className="font-mono text-xs font-medium text-on-surface underline-offset-2 hover:underline"
                  title={`workflow:${g.name}:${g.version}`}
                >
                  {g.name} v{g.version}
                </button>
                <span className="text-xs text-on-surface-variant">
                  {g.rows.length} instance{g.rows.length === 1 ? "" : "s"} · {gLive} live
                </span>
                {gAttention > 0 ? <StatusBadge status="attention_required" label={`${gAttention} need attention`} /> : null}
              </div>
              <ul className="divide-y divide-outline-variant/50">
                {g.rows.map((i) => (
                  <WorkflowInstanceRow key={i.instanceId} instance={i} />
                ))}
              </ul>
            </section>
          );
        })}

        {idleSpecs.length > 0 ? (
          <section data-testid="workflows-idle-specs" className="space-y-2 rounded-lg border bg-surface-lowest">
            <div className="border-b border-outline-variant px-3 py-2 text-xs text-on-surface-variant">
              Cached specs — no instances
            </div>
            <ul className="divide-y divide-outline-variant/50">
              {idleSpecs.map((s) => (
                <li key={`${s.name}:${s.version}`}>
                  <button
                    type="button"
                    data-testid={`workflows-idle-spec-${s.name}`}
                    onClick={() =>
                      navigate({
                        to: "/specs/library/$entryId",
                        params: { entryId: `workflow:${s.name}:${s.version}` },
                      })
                    }
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-variant/50"
                    title={`workflow:${s.name}:${s.version}`}
                  >
                    <span className="font-mono text-xs text-on-surface-variant" aria-hidden>
                      ◌
                    </span>
                    <span className="font-mono text-xs text-on-surface">
                      {s.name} v{s.version}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-on-surface-variant">
                      {s.purpose ?? ""}
                    </span>
                    <span className="shrink-0 text-xs text-on-surface-variant">
                      {s.isBuiltIn ? "built-in" : "user file"} · 0 instances
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
