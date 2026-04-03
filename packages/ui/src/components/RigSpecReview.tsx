import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { useRigSpecReview } from "../hooks/useSpecReview.js";
import { SpecTopologyPreview } from "./SpecTopologyPreview.js";
import {
  WorkflowCodePreview,
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";

type Tab = "topology" | "configuration" | "yaml";

export function RigSpecReview() {
  const navigate = useNavigate();
  const { selectedRigDraft, currentRigDraft } = useSpecsWorkspace();
  const draft = selectedRigDraft ?? currentRigDraft;
  const [activeTab, setActiveTab] = useState<Tab>("topology");
  const { data: review, isLoading, error } = useRigSpecReview(draft?.yaml ?? null);
  const reviewPods = review?.pods ?? [];
  const reviewNodes = review?.nodes ?? [];
  const reviewEdges = review?.edges ?? [];

  if (!draft) {
    return (
      <WorkspacePage>
        <div data-testid="rig-spec-review-empty" className="space-y-5">
          <WorkflowHeader
            eyebrow="Rig Spec Review"
            title="No RigSpec Selected"
            description="Choose a current or recent rig draft from the Specs drawer to review it here before you import or bootstrap it."
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>
            Open Import
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <div data-testid="rig-spec-review" className="space-y-6">
        <WorkflowHeader
          eyebrow="Rig Spec Review"
          title={review?.name ?? draft.label}
          description={review?.summary ?? "Review the spec structure before import or bootstrap."}
          actions={(
            <>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>
                Open In Import
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/bootstrap" })}>
                Bootstrap
              </Button>
            </>
          )}
        />

        {/* Summary cards */}
        {review && (
          <WorkflowSummaryGrid>
            <WorkflowSummaryCard
              label="Format"
              value={review.format === "pod_aware" ? "Pod-Aware" : "Legacy"}
              testId="rig-spec-summary-format"
            />
            <WorkflowSummaryCard
              label={review.format === "pod_aware" ? "Pods" : "Nodes"}
              value={review.format === "pod_aware" ? reviewPods.length : reviewNodes.length}
              testId="rig-spec-summary-pods"
            />
            <WorkflowSummaryCard
              label="Members"
              value={review.format === "pod_aware"
                ? reviewPods.reduce((sum, p) => sum + p.members.length, 0)
                : reviewNodes.length}
              testId="rig-spec-summary-members"
            />
            <WorkflowSummaryCard
              label="Edges"
              value={reviewEdges.length + (review.format === "pod_aware"
                ? reviewPods.reduce((sum, p) => sum + (p.edges?.length ?? 0), 0)
                : 0)}
              testId="rig-spec-summary-edges"
            />
          </WorkflowSummaryGrid>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-stone-200">
          {(["topology", "configuration", "yaml"] as Tab[]).map((tab) => (
            <button
              key={tab}
              data-testid={`tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                activeTab === tab
                  ? "border-b-2 border-stone-900 text-stone-900 font-bold"
                  : "text-stone-500 hover:text-stone-700"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Loading / Error */}
        {isLoading && <div className="font-mono text-[10px] text-stone-400">Loading review...</div>}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">
            {(error as Error).message}
          </div>
        )}

        {/* Tab content */}
        {review && activeTab === "topology" && (
          <SpecTopologyPreview graph={review.graph} testId="rig-topology-preview" />
        )}

        {review && activeTab === "configuration" && (
          <div data-testid="rig-config-tables" className="space-y-4">
            {review.format === "pod_aware" && reviewPods.map((pod) => (
              <div key={pod.id} className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">{pod.label ?? pod.id}</div>
                <table className="w-full font-mono text-[10px]">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-500">
                      <th className="text-left py-1">Member</th>
                      <th className="text-left py-1">Agent Ref</th>
                      <th className="text-left py-1">Runtime</th>
                      <th className="text-left py-1">Profile</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pod.members.map((m) => (
                      <tr key={m.id} className="border-b border-stone-100">
                        <td className="py-1">{m.id}</td>
                        <td className="py-1 text-stone-600">{m.agentRef}</td>
                        <td className="py-1">{m.runtime}</td>
                        <td className="py-1 text-stone-500">{m.profile ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {review.format === "legacy" && reviewNodes.length > 0 && (
              <div className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">Nodes</div>
                <table className="w-full font-mono text-[10px]">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-500">
                      <th className="text-left py-1">ID</th>
                      <th className="text-left py-1">Runtime</th>
                      <th className="text-left py-1">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewNodes.map((n) => (
                      <tr key={n.id} className="border-b border-stone-100">
                        <td className="py-1">{n.id}</td>
                        <td className="py-1">{n.runtime}</td>
                        <td className="py-1 text-stone-500">{n.role ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {reviewEdges.length > 0 && (
              <div className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">
                  {review.format === "pod_aware" ? "Cross-Pod Edges" : "Edges"}
                </div>
                <table className="w-full font-mono text-[10px]">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-500">
                      <th className="text-left py-1">From</th>
                      <th className="text-left py-1">To</th>
                      <th className="text-left py-1">Kind</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewEdges.map((e, i) => (
                      <tr key={i} className="border-b border-stone-100">
                        <td className="py-1">{e.from}</td>
                        <td className="py-1">{e.to}</td>
                        <td className="py-1 text-stone-500">{e.kind}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === "yaml" && (
          <WorkflowCodePreview title="YAML Preview" testId="rig-spec-yaml">
            {draft.yaml}
          </WorkflowCodePreview>
        )}
      </div>
    </WorkspacePage>
  );
}
