import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import {
  WorkflowCodePreview,
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function summarizeRigSpec(yaml: string) {
  const isPodAware = /^\s*pods:\s*$/m.test(yaml) || /^\s*pods:\s*\[/m.test(yaml);

  if (isPodAware) {
    return {
      formatLabel: "Pod-Aware RigSpec",
      primaryLabel: "Pods",
      primaryCount: countMatches(yaml, /^\s*members:\s*$/gm),
      memberCount: countMatches(yaml, /^\s*agent_ref:\s*.+$/gm),
      edgeCount: countMatches(yaml, /^\s*-\s*kind:\s*.+$/gm),
    };
  }

  return {
    formatLabel: "Legacy RigSpec",
    primaryLabel: "Nodes",
    primaryCount: countMatches(yaml, /^\s*runtime:\s*.+$/gm),
    memberCount: countMatches(yaml, /^\s*runtime:\s*.+$/gm),
    edgeCount: countMatches(yaml, /^\s*-\s*kind:\s*.+$/gm),
  };
}

export function RigSpecReview() {
  const navigate = useNavigate();
  const { selectedRigDraft, currentRigDraft } = useSpecsWorkspace();
  const draft = selectedRigDraft ?? currentRigDraft;

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

  const summary = summarizeRigSpec(draft.yaml);

  return (
    <WorkspacePage>
      <div data-testid="rig-spec-review" className="space-y-8">
        <WorkflowHeader
          eyebrow="Rig Spec Review"
          title={draft.label}
          description="Review the saved draft structure before you move into import or bootstrap. This surface stays read-only on purpose."
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

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value={summary.formatLabel} testId="rig-spec-summary-format" />
          <WorkflowSummaryCard label={summary.primaryLabel} value={summary.primaryCount} testId="rig-spec-summary-pods" />
          <WorkflowSummaryCard label="Members" value={summary.memberCount} testId="rig-spec-summary-members" />
          <WorkflowSummaryCard label="Edges" value={summary.edgeCount} testId="rig-spec-summary-edges" />
        </WorkflowSummaryGrid>

        <WorkflowCodePreview title="YAML Preview" testId="rig-spec-yaml">
          {draft.yaml}
        </WorkflowCodePreview>
      </div>
    </WorkspacePage>
  );
}
