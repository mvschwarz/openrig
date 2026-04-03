import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { useAgentSpecReview } from "../hooks/useSpecReview.js";
import {
  WorkflowCodePreview,
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";

export function AgentSpecReview() {
  const navigate = useNavigate();
  const { selectedAgentDraft, currentAgentDraft } = useSpecsWorkspace();
  const draft = selectedAgentDraft ?? currentAgentDraft;
  const { data: review, isLoading, error } = useAgentSpecReview(draft?.yaml ?? null);
  const profiles = review?.profiles ?? [];
  const resources = review?.resources ?? {
    skills: [],
    guidance: [],
    hooks: [],
    subagents: [],
  };
  const startup = review?.startup ?? { files: [], actions: [] };

  if (!draft) {
    return (
      <WorkspacePage>
        <div data-testid="agent-spec-review-empty" className="space-y-5">
          <WorkflowHeader
            eyebrow="Agent Spec Review"
            title="No AgentSpec Selected"
            description="Choose a current or recent agent draft from the Specs drawer to review it here before you validate it."
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
            <WorkflowSummaryCard label="Profiles" value={profiles.length} testId="agent-spec-summary-profiles" />
            <WorkflowSummaryCard
              label="Skills"
              value={resources.skills.length}
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

        {/* Profiles */}
        {review && profiles.length > 0 && (
          <div data-testid="agent-profiles-section" className="border border-stone-200 p-3">
            <div className="font-mono text-xs font-bold mb-2">Profiles</div>
            <div className="space-y-1">
              {profiles.map((p) => (
                <div key={p.name} className="font-mono text-[10px] flex justify-between">
                  <span className="font-bold">{p.name}</span>
                  {p.description && <span className="text-stone-500">{p.description}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resources */}
        {review && (
          <div data-testid="agent-resources-section" className="border border-stone-200 p-3">
            <div className="font-mono text-xs font-bold mb-2">Resources</div>
            <div className="space-y-2 font-mono text-[10px]">
              {resources.skills.length > 0 && (
                <div>
                  <span className="text-stone-500">Skills:</span>{" "}
                  {resources.skills.map((s, i) => (
                    <span key={i} className="inline-block bg-stone-100 px-1.5 py-0.5 mr-1 mb-0.5">{s}</span>
                  ))}
                </div>
              )}
              {resources.guidance.length > 0 && (
                <div>
                  <span className="text-stone-500">Guidance:</span>{" "}
                  {resources.guidance.map((g, i) => (
                    <span key={i} className="inline-block bg-stone-100 px-1.5 py-0.5 mr-1 mb-0.5">{g}</span>
                  ))}
                </div>
              )}
              {resources.hooks.length > 0 && (
                <div>
                  <span className="text-stone-500">Hooks:</span> {resources.hooks.join(", ")}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Startup */}
        {review && (startup.files.length > 0 || startup.actions.length > 0) && (
          <div data-testid="agent-startup-section" className="border border-stone-200 p-3">
            <div className="font-mono text-xs font-bold mb-2">Startup</div>
            {startup.files.length > 0 && (
              <div className="mb-2">
                <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Files</div>
                {startup.files.map((f, i) => (
                  <div key={i} className="font-mono text-[10px]">
                    {f.path} {f.required && <span className="text-red-500 text-[8px]">REQUIRED</span>}
                  </div>
                ))}
              </div>
            )}
            {startup.actions.length > 0 && (
              <div>
                <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Actions</div>
                {startup.actions.map((a, i) => (
                  <div key={i} className="font-mono text-[10px]">
                    <span className="text-stone-500">{a.type}:</span> {a.value}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* YAML */}
        <WorkflowCodePreview title="YAML Preview" testId="agent-spec-yaml">
          {draft.yaml}
        </WorkflowCodePreview>
      </div>
    </WorkspacePage>
  );
}
