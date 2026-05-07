import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { useAgentSpecReview } from "../hooks/useSpecReview.js";
import {
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";

export function AgentSpecReview() {
  const navigate = useNavigate();
  const { selectedAgentDraft, currentAgentDraft } = useSpecsWorkspace();
  const draft = selectedAgentDraft ?? currentAgentDraft;
  const { data: review, isLoading, error } = useAgentSpecReview(draft?.yaml ?? null);

  if (!draft) {
    return (
      <WorkspacePage>
        <div data-testid="agent-spec-review-empty" className="space-y-5">
          <WorkflowHeader
            eyebrow="Agent Spec Review"
            title="No AgentSpec Selected"
            description="Choose a current or recent agent draft from the Library drawer to review it here before you validate it."
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>
            Open Validate
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <div data-testid="agent-spec-review" className="space-y-6">
        <WorkflowHeader
          eyebrow="Agent Spec Review"
          title={review?.name ?? draft.label}
          description={review?.description ?? "Review the agent spec structure before validation."}
          actions={(
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>
              Open In Validate
            </Button>
          )}
        />

        {/* Summary cards */}
        {review && (
          <WorkflowSummaryGrid>
            <WorkflowSummaryCard label="Format" value="AgentSpec" testId="agent-spec-summary-format" />
            <WorkflowSummaryCard label="Version" value={review.version} testId="agent-spec-summary-version" />
            <WorkflowSummaryCard label="Profiles" value={(review.profiles ?? []).length} testId="agent-spec-summary-profiles" />
            <WorkflowSummaryCard
              label="Skills"
              value={(review.resources ?? { skills: [] }).skills.length}
              testId="agent-spec-summary-skills"
            />
          </WorkflowSummaryGrid>
        )}

        {/* Loading / Error */}
        {isLoading && <div className="font-mono text-[10px] text-stone-400">Loading review...</div>}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">
            {(error as Error).message}
          </div>
        )}

        {/* Delegated display */}
        <AgentSpecDisplay review={review} yaml={draft.yaml} testIdPrefix="agent" />
      </div>
    </WorkspacePage>
  );
}
