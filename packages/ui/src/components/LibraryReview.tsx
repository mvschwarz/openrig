import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useLibraryReview, useSpecLibrary, type LibraryRigReview, type LibraryAgentReview } from "../hooks/useSpecLibrary.js";
import {
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";
import { RigSpecDisplay } from "./RigSpecDisplay.js";
import { buildSetupPrompt } from "../lib/build-setup-prompt.js";
import { copyText } from "../lib/copy-text.js";

interface LibraryReviewProps {
  entryId: string;
}

function ProvenanceBadge({ sourcePath, sourceState }: { sourcePath: string; sourceState: string }) {
  return (
    <div className="font-mono text-[9px] text-stone-500" data-testid="library-provenance">
      Source: {sourcePath} · {sourceState}
    </div>
  );
}

function LibraryAgentReviewPage({ review }: { review: LibraryAgentReview }) {
  const navigate = useNavigate();
  const profiles = review.profiles ?? [];
  const resources = review.resources ?? { skills: [], guidance: [], hooks: [], subagents: [] };

  return (
    <WorkspacePage>
      <div data-testid="library-review-agent" className="space-y-6">
        <WorkflowHeader
          eyebrow="Library — Agent Spec"
          title={review.name}
          description={review.description ?? "Agent spec from library."}
          actions={<Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>Validate</Button>}
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value="AgentSpec" testId="lib-agent-format" />
          <WorkflowSummaryCard label="Version" value={review.version} testId="lib-agent-version" />
          <WorkflowSummaryCard label="Profiles" value={profiles.length} testId="lib-agent-profiles" />
          <WorkflowSummaryCard label="Skills" value={resources.skills.length} testId="lib-agent-skills" />
        </WorkflowSummaryGrid>

        <AgentSpecDisplay review={review} yaml={review.raw} testIdPrefix="lib-agent" />
      </div>
    </WorkspacePage>
  );
}

function LibraryRigReviewContent({ review }: { review: LibraryRigReview }) {
  const navigate = useNavigate();
  const [setupPromptCopied, setSetupPromptCopied] = useState(false);
  const { data: agentEntries = [] } = useSpecLibrary("agent");
  const agentEntryByName = new Map(agentEntries.map((entry) => [entry.name, entry]));
  const reviewPods = review.pods ?? [];
  const reviewNodes = review.nodes ?? [];
  const reviewEdges = review.edges ?? [];

  const resolveMemberAgent = (agentRef: string) => {
    if (!agentRef.startsWith("local:")) return null;
    const refPath = agentRef.slice("local:".length);

    // Resolve the ref path against the rig's source directory
    const rigDir = review.sourcePath.replace(/\/[^/]+$/, "");
    const segments = `${rigDir}/${refPath}`.split("/");
    const resolved: string[] = [];
    for (const seg of segments) {
      if (seg === "..") { resolved.pop(); }
      else if (seg !== "." && seg !== "") { resolved.push(seg); }
    }
    const resolvedDir = "/" + resolved.join("/");

    // Match against library entries by sourcePath prefix (agent dir contains agent.yaml)
    return agentEntries.find((entry) => entry.sourcePath.startsWith(resolvedDir + "/")) ?? null;
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-rig" className="space-y-6">
        <WorkflowHeader
          eyebrow={review.services ? "Library — Managed App" : "Library — Rig Spec"}
          title={review.name}
          description={review.summary ?? "Rig spec from library."}
          actions={
            <div className="flex gap-2">
              {review.services && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="copy-setup-prompt"
                  onClick={() => void (async () => {
                    const copied = await copyText(buildSetupPrompt({
                      name: review.name,
                      summary: review.summary,
                      sourcePath: review.sourcePath,
                    }));
                    if (!copied) return;
                    setSetupPromptCopied(true);
                    window.setTimeout(() => setSetupPromptCopied(false), 2000);
                  })()}
                >
                  {setupPromptCopied ? "Copied" : "Copy Setup Prompt"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>Import</Button>
            </div>
          }
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value={review.format === "pod_aware" ? "Pod-Aware" : "Legacy"} testId="lib-rig-format" />
          {review.services && (
            <WorkflowSummaryCard label="Type" value="Agent-Managed App" testId="lib-rig-type" />
          )}
          {review.services && reviewPods.length > 0 && (() => {
            const specialistPod = reviewPods.find((p) => p.members.some((m) => m.id === "specialist"));
            if (!specialistPod) return null;
            return (
              <WorkflowSummaryCard
                label="Specialist Agent"
                value={`${specialistPod.id}.specialist`}
                testId="lib-rig-specialist"
              />
            );
          })()}
          <WorkflowSummaryCard
            label={review.format === "pod_aware" ? "Pods" : "Nodes"}
            value={review.format === "pod_aware" ? reviewPods.length : reviewNodes.length}
            testId="lib-rig-pods"
          />
          <WorkflowSummaryCard
            label="Members"
            value={review.format === "pod_aware"
              ? reviewPods.reduce((sum, p) => sum + p.members.length, 0)
              : reviewNodes.length}
            testId="lib-rig-members"
          />
          <WorkflowSummaryCard
            label="Edges"
            value={reviewEdges.length + (review.format === "pod_aware"
              ? reviewPods.reduce((sum, p) => sum + (p.edges?.length ?? 0), 0)
              : 0)}
            testId="lib-rig-edges"
          />
        </WorkflowSummaryGrid>

        <RigSpecDisplay
          review={review}
          yaml={review.raw}
          testIdPrefix="lib"
          yamlTestId="lib-rig-yaml"
          showEnvironmentTab={!!review.services}
          onMemberClick={(podId, member) => {
            const agentEntry = resolveMemberAgent(member.agentRef);
            if (agentEntry) {
              void navigate({ to: "/specs/library/$entryId", params: { entryId: agentEntry.id } });
            }
          }}
        />
      </div>
    </WorkspacePage>
  );
}

export function LibraryReview({ entryId }: LibraryReviewProps) {
  const navigate = useNavigate();
  const { data: review, isLoading, error } = useLibraryReview(entryId);

  if (isLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-stone-400">Loading spec review...</div>
      </WorkspacePage>
    );
  }

  if (error || !review) {
    return (
      <WorkspacePage>
        <div data-testid="library-review-error" className="space-y-4">
          <WorkflowHeader eyebrow="Library" title="Spec Not Found" description={(error as Error)?.message ?? "Could not load spec."} />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Specs</Button>
        </div>
      </WorkspacePage>
    );
  }

  if (review.kind === "agent") {
    return <LibraryAgentReviewPage review={review as LibraryAgentReview} />;
  }

  return <LibraryRigReviewContent review={review as LibraryRigReview} />;
}
