import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  type Node,
  type Edge,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  useLibraryReview,
  useSpecLibrary,
  setActiveLens,
  clearActiveLens,
  useActiveLens,
  type LibraryRigReview,
  type LibraryAgentReview,
  type LibraryWorkflowReview,
} from "../hooks/useSpecLibrary.js";
import { useQueryClient } from "@tanstack/react-query";
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

  if (review.kind === "workflow") {
    return <LibraryWorkflowReviewPage review={review as LibraryWorkflowReview} />;
  }

  return <LibraryRigReviewContent review={review as LibraryRigReview} />;
}

// --- Workflows in Spec Library v0: workflow review variant ---

const WF_NODE_WIDTH = 180;
const WF_NODE_HEIGHT = 56;
const WF_H_SPACING = 220;
const WF_V_SPACING = 110;

function WorkflowTopologyGraph({
  topology,
  testId,
}: {
  topology: LibraryWorkflowReview["topology"];
  testId?: string;
}) {
  const { nodes, edges } = useMemo(() => {
    // Simple BFS-based depth assignment from entry nodes.
    const adj = new Map<string, string[]>();
    for (const e of topology.edges) {
      if (!adj.has(e.fromStepId)) adj.set(e.fromStepId, []);
      adj.get(e.fromStepId)!.push(e.toStepId);
    }
    const depth = new Map<string, number>();
    const queue: Array<{ id: string; d: number }> = [];
    for (const n of topology.nodes) {
      if (n.isEntry) {
        depth.set(n.stepId, 0);
        queue.push({ id: n.stepId, d: 0 });
      }
    }
    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      const next = adj.get(id) ?? [];
      for (const child of next) {
        if (!depth.has(child) || (depth.get(child) ?? 0) < d + 1) {
          depth.set(child, d + 1);
          queue.push({ id: child, d: d + 1 });
        }
      }
    }
    // Fallback for orphan nodes.
    let fallbackDepth = 0;
    for (const n of topology.nodes) {
      if (!depth.has(n.stepId)) {
        depth.set(n.stepId, fallbackDepth++);
      }
    }
    // Group by depth → assign x by index within depth.
    const byDepth = new Map<number, string[]>();
    for (const n of topology.nodes) {
      const d = depth.get(n.stepId) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(n.stepId);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [d, ids] of byDepth) {
      ids.forEach((id, idx) => {
        positions.set(id, { x: idx * WF_H_SPACING, y: d * WF_V_SPACING });
      });
    }

    const rfNodes: Node[] = topology.nodes.map((n) => {
      const pos = positions.get(n.stepId) ?? { x: 0, y: 0 };
      const accent = n.isEntry ? "#a8c8d4" : n.isTerminal ? "#d4b8a8" : "#d4c4a8";
      return {
        id: n.stepId,
        type: "default",
        position: pos,
        data: {
          label: (
            <div className="font-mono text-[10px] leading-tight">
              <div className="font-bold">{n.stepId}</div>
              <div className="text-stone-600">{n.role}</div>
              {n.preferredTarget && <div className="text-[8px] text-stone-500">→ {n.preferredTarget}</div>}
            </div>
          ),
        },
        style: {
          backgroundColor: accent,
          border: "1px solid #8a8577",
          fontSize: 11,
          fontFamily: "monospace",
          width: WF_NODE_WIDTH,
          height: WF_NODE_HEIGHT,
          padding: 6,
        },
      };
    });

    const rfEdges: Edge[] = topology.edges.map((e, i) => ({
      id: `e-${i}`,
      source: e.fromStepId,
      target: e.toStepId,
      style: { stroke: "#8a8577" },
    }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [topology]);

  return (
    <div data-testid={testId ?? "workflow-topology-graph"} className="w-full h-[400px] bg-stone-50 border border-stone-200">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={0.5} color="#d4d0c8" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function LibraryWorkflowReviewPage({ review }: { review: LibraryWorkflowReview }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: activeLens } = useActiveLens();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isThisLensActive = activeLens?.specName === review.name && activeLens?.specVersion === review.version;

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      await setActiveLens(review.name, review.version);
      await queryClient.invalidateQueries({ queryKey: ["spec-library", "active-lens"] });
      await queryClient.invalidateQueries({ queryKey: ["slices"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearActiveLens();
      await queryClient.invalidateQueries({ queryKey: ["spec-library", "active-lens"] });
      await queryClient.invalidateQueries({ queryKey: ["slices"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-workflow" className="space-y-6">
        <WorkflowHeader
          eyebrow={review.isBuiltIn ? "Library — Workflow (Built-in)" : "Library — Workflow"}
          title={`${review.name} v${review.version}`}
          description={review.purpose ?? "Workflow spec from library."}
          actions={
            <div className="flex gap-2 items-center">
              {isThisLensActive ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="workflow-deactivate-lens"
                  onClick={() => void deactivate()}
                  disabled={busy}
                >
                  {busy ? "..." : "Deactivate Lens"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="workflow-activate-lens"
                  onClick={() => void activate()}
                  disabled={busy}
                >
                  {busy ? "..." : "Activate as Lens"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back</Button>
            </div>
          }
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState="library_item" />
        {error && <div data-testid="workflow-lens-error" className="font-mono text-[10px] text-red-600">{error}</div>}

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value="WorkflowSpec" testId="lib-wf-format" />
          <WorkflowSummaryCard label="Version" value={review.version} testId="lib-wf-version" />
          <WorkflowSummaryCard label="Roles" value={review.rolesCount} testId="lib-wf-roles" />
          <WorkflowSummaryCard label="Steps" value={review.stepsCount} testId="lib-wf-steps" />
          <WorkflowSummaryCard label="Target Rig" value={review.targetRig ?? "(any)"} testId="lib-wf-target-rig" />
          <WorkflowSummaryCard label="Source" value={review.isBuiltIn ? "built-in" : "user file"} testId="lib-wf-source" />
        </WorkflowSummaryGrid>

        <div data-testid="workflow-terminal-rule" className="border border-stone-300/40 bg-white/10 px-3 py-2 font-mono text-[10px] text-stone-700">
          <span className="text-stone-500 uppercase tracking-[0.16em] text-[8px] mr-2">Coordination Terminal Turn:</span>
          {review.terminalTurnRule}
        </div>

        <WorkflowTopologyGraph topology={review.topology} />

        <div className="space-y-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">Steps</div>
          <div className="space-y-1">
            {review.steps.map((step) => (
              <div
                key={step.stepId}
                data-testid={`workflow-step-${step.stepId}`}
                className="border border-stone-300/40 bg-white/5 px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold text-stone-800">{step.stepId}</span>
                  <span className="font-mono text-[9px] text-stone-500">{step.role}</span>
                </div>
                {step.objective && <div className="mt-1 text-[10px] text-stone-600 leading-tight">{step.objective}</div>}
                {step.allowedNextSteps.length > 0 && (
                  <div className="mt-1 font-mono text-[9px] text-stone-500">
                    next: {step.allowedNextSteps.map((n) => `${n.stepId} (${n.role})`).join(", ")}
                  </div>
                )}
                {step.allowedExits.length > 0 && (
                  <div className="font-mono text-[9px] text-stone-400">
                    exits: {step.allowedExits.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}
