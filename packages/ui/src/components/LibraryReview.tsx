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
import {
  useContextPackLibrary,
  useContextPackPreview,
  useContextPackSend,
  type ContextPackEntry,
} from "../hooks/useContextPackLibrary.js";
import {
  useAgentImageLibrary,
  useAgentImagePreview,
  useAgentImagePin,
  type AgentImageEntry,
  type AgentImagePreview,
} from "../hooks/useAgentImageLibrary.js";
import { usePsEntries } from "../hooks/usePsEntries.js";
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
  // PL-014: context_packs live at /api/context-packs/library and have
  // an id prefix of "context-pack:". Dispatch to the pack-specific
  // review page before invoking useLibraryReview (which would 404
  // against the spec-library route for context-pack ids).
  if (entryId.startsWith("context-pack:")) {
    return <LibraryContextPackReviewPage entryId={entryId} />;
  }
  // PL-016: agent_images live at /api/agent-images/library with id
  // prefix "agent-image:".
  if (entryId.startsWith("agent-image:")) {
    return <LibraryAgentImageReviewPage entryId={entryId} />;
  }
  return <LibrarySpecReview entryId={entryId} />;
}

function LibrarySpecReview({ entryId }: LibraryReviewProps) {
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
        // Only assign depth on first visit. The `< d+1` relaxation
        // condition the prior version used loops forever on cyclic
        // specs (e.g. rsi-v2-hot-potato has `qa → discovery`). Standard
        // BFS visit-once handles cycles correctly + still produces a
        // shortest-path-from-entry depth assignment.
        if (!depth.has(child)) {
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

// --- Rig Context / Composable Context Injection v0 (PL-014):
//     context_pack review page ---

function LibraryContextPackReviewPage({ entryId }: { entryId: string }) {
  const navigate = useNavigate();
  const { data: packs = [], isLoading: packsLoading, error: packsError } = useContextPackLibrary();
  const entry = packs.find((p) => p.id === entryId) ?? null;
  const { data: preview, isLoading: previewLoading } = useContextPackPreview(entry ? entryId : null);

  if (packsLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-stone-400">Loading context pack…</div>
      </WorkspacePage>
    );
  }
  if (packsError || !entry) {
    return (
      <WorkspacePage>
        <div data-testid="library-review-error" className="space-y-4">
          <WorkflowHeader
            eyebrow="Library"
            title="Context Pack Not Found"
            description={(packsError as Error)?.message ?? `No context pack with id ${entryId}.`}
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Specs</Button>
        </div>
      </WorkspacePage>
    );
  }

  return <ContextPackReviewBody entry={entry} preview={preview} previewLoading={previewLoading} />;
}

function ContextPackReviewBody({
  entry,
  preview,
  previewLoading,
}: {
  entry: ContextPackEntry;
  preview: ReturnType<typeof useContextPackPreview>["data"];
  previewLoading: boolean;
}) {
  const navigate = useNavigate();
  const [showSendPicker, setShowSendPicker] = useState(false);
  const [destinationSession, setDestinationSession] = useState<string>("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<"idle" | "dry-run-shown" | "sent">("idle");
  const sendMutation = useContextPackSend();
  const { data: psEntries = [] } = usePsEntries();

  const runningSessions: string[] = (() => {
    const sessions: string[] = [];
    for (const rig of psEntries) {
      const nodes = (rig as { nodes?: Array<{ canonicalSessionName?: string | null; sessionStatus?: string | null }> }).nodes ?? [];
      for (const n of nodes) {
        if (n.canonicalSessionName && n.sessionStatus === "running") sessions.push(n.canonicalSessionName);
      }
    }
    return sessions.sort();
  })();

  const onDryRun = async () => {
    setSendError(null);
    if (!destinationSession) {
      setSendError("Pick a destination session first.");
      return;
    }
    try {
      await sendMutation.mutateAsync({ id: entry.id, destinationSession, dryRun: true });
      setSendStatus("dry-run-shown");
    } catch (err) {
      setSendError((err as Error).message);
    }
  };

  const onSend = async () => {
    setSendError(null);
    if (!destinationSession) {
      setSendError("Pick a destination session first.");
      return;
    }
    try {
      await sendMutation.mutateAsync({ id: entry.id, destinationSession, dryRun: false });
      setSendStatus("sent");
    } catch (err) {
      setSendError((err as Error).message);
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-context-pack" className="space-y-4">
        <WorkflowHeader
          eyebrow={`Library — Context Pack${entry.sourceType === "builtin" ? " (built-in)" : ""}`}
          title={entry.name}
          description={entry.purpose ?? "Operator-authored composable context bundle."}
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="context-pack-send-button"
                onClick={() => setShowSendPicker((v) => !v)}
              >
                {showSendPicker ? "Hide Send" : "Send to seat"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Specs</Button>
            </div>
          }
        />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Version" value={entry.version} testId="lib-pack-version" />
          <WorkflowSummaryCard label="Files" value={entry.files.length} testId="lib-pack-files" />
          <WorkflowSummaryCard
            label="Tokens (~)"
            value={String(entry.derivedEstimatedTokens)}
            testId="lib-pack-tokens"
          />
          <WorkflowSummaryCard label="Source" value={entry.sourceType} testId="lib-pack-source" />
        </WorkflowSummaryGrid>

        <div data-testid="lib-pack-source-path" className="font-mono text-[9px] text-stone-500">
          path: {entry.sourcePath}
        </div>

        <section className="border border-stone-300/40 bg-white/8">
          <header className="border-b border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-600">
            Files
          </header>
          <ul data-testid="lib-pack-file-list" className="divide-y divide-stone-100">
            {entry.files.map((f) => {
              const missing = f.bytes === null;
              return (
                <li
                  key={f.path}
                  data-testid={`lib-pack-file-${f.path}`}
                  data-missing={missing ? "true" : "false"}
                  className={`px-3 py-2 font-mono text-[10px] ${missing ? "text-red-700" : "text-stone-800"}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-bold truncate">{f.path}</span>
                    <span className="font-mono text-[8px] text-stone-500 shrink-0">
                      role: {f.role}
                      {missing
                        ? " · MISSING"
                        : ` · ${f.bytes}B · ~${f.estimatedTokens} tokens`}
                    </span>
                  </div>
                  {f.summary && (
                    <div className="mt-0.5 text-stone-600 text-[9px]">{f.summary}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {showSendPicker && (
          <section data-testid="context-pack-send-modal" className="border border-stone-400 bg-white px-3 py-3 space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-700">Send to seat</div>
            <select
              data-testid="context-pack-send-session"
              className="w-full font-mono text-[10px] border border-stone-300 px-2 py-1"
              value={destinationSession}
              onChange={(e) => setDestinationSession(e.target.value)}
            >
              <option value="">Pick a running session…</option>
              {runningSessions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="context-pack-send-dry-run"
                onClick={() => void onDryRun()}
                disabled={sendMutation.isPending}
              >
                {sendMutation.isPending ? "…" : "Dry run"}
              </Button>
              <Button
                size="sm"
                data-testid="context-pack-send-confirm"
                onClick={() => void onSend()}
                disabled={sendMutation.isPending || !destinationSession}
              >
                {sendMutation.isPending ? "Sending…" : "Send"}
              </Button>
            </div>
            {sendError && (
              <div data-testid="context-pack-send-error" className="font-mono text-[9px] text-red-600">{sendError}</div>
            )}
            {sendStatus === "sent" && (
              <div data-testid="context-pack-send-success" className="font-mono text-[9px] text-emerald-700">
                Sent to {destinationSession}.
              </div>
            )}
            {sendStatus === "dry-run-shown" && sendMutation.data?.bundleText && (
              <pre
                data-testid="context-pack-send-bundle-preview"
                className="font-mono text-[9px] bg-stone-50 border border-stone-200 px-2 py-1 max-h-64 overflow-y-auto whitespace-pre-wrap"
              >
                {sendMutation.data.bundleText}
              </pre>
            )}
          </section>
        )}

        <section className="border border-stone-300/40 bg-white/8">
          <header className="border-b border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-600">
            Bundle preview
          </header>
          {previewLoading && (
            <div className="px-3 py-2 font-mono text-[9px] text-stone-400">Loading bundle…</div>
          )}
          {preview && (
            <>
              {preview.missingFiles.length > 0 && (
                <div data-testid="lib-pack-missing-warning" className="px-3 py-2 font-mono text-[9px] text-red-700 border-b border-stone-200">
                  Warning: {preview.missingFiles.length} file{preview.missingFiles.length === 1 ? "" : "s"} referenced by manifest but missing on disk.
                </div>
              )}
              <pre
                data-testid="lib-pack-bundle-text"
                className="font-mono text-[9px] text-stone-800 bg-stone-50 px-3 py-2 max-h-96 overflow-y-auto whitespace-pre-wrap"
              >
                {preview.bundleText}
              </pre>
            </>
          )}
        </section>
      </div>
    </WorkspacePage>
  );
}

// --- Fork Primitive + Starter Agent Images v0 (PL-016): agent-image
//     review variant. Shows manifest + statistics badges + lineage +
//     Use-as-starter snippet + Pin/Unpin button. ---

function LibraryAgentImageReviewPage({ entryId }: { entryId: string }) {
  const navigate = useNavigate();
  const { data: images = [], isLoading: imagesLoading, error: imagesError } = useAgentImageLibrary();
  const entry = images.find((i) => i.id === entryId) ?? null;
  const { data: preview, isLoading: previewLoading } = useAgentImagePreview(entry ? entryId : null);

  if (imagesLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-stone-400">Loading agent image…</div>
      </WorkspacePage>
    );
  }
  if (imagesError || !entry) {
    return (
      <WorkspacePage>
        <div data-testid="library-review-error" className="space-y-4">
          <WorkflowHeader
            eyebrow="Library"
            title="Agent Image Not Found"
            description={(imagesError as Error)?.message ?? `No agent image with id ${entryId}.`}
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Specs</Button>
        </div>
      </WorkspacePage>
    );
  }
  return <AgentImageReviewBody entry={entry} preview={preview} previewLoading={previewLoading} />;
}

function AgentImageReviewBody({
  entry,
  preview,
  previewLoading,
}: {
  entry: AgentImageEntry;
  preview: AgentImagePreview | undefined;
  previewLoading: boolean;
}) {
  const navigate = useNavigate();
  const pinMutation = useAgentImagePin();
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const onCopySnippet = async () => {
    if (!preview?.starterSnippet) return;
    const ok = await copyText(preview.starterSnippet);
    if (ok) {
      setSnippetCopied(true);
      window.setTimeout(() => setSnippetCopied(false), 2000);
    }
  };

  const onTogglePin = async () => {
    setPinError(null);
    try {
      await pinMutation.mutateAsync({ id: entry.id, pin: !entry.pinned });
    } catch (err) {
      setPinError((err as Error).message);
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-agent-image" className="space-y-4">
        <WorkflowHeader
          eyebrow={`Library — Agent Image${entry.sourceType === "builtin" ? " (built-in)" : ""}`}
          title={`${entry.name} v${entry.version}`}
          description={entry.notes ?? `Snapshot of ${entry.sourceSeat}.`}
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="agent-image-pin-toggle"
                onClick={() => void onTogglePin()}
                disabled={pinMutation.isPending}
              >
                {entry.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Specs</Button>
            </div>
          }
        />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Runtime" value={entry.runtime} testId="lib-image-runtime" />
          <WorkflowSummaryCard label="Forks" value={String(entry.stats.forkCount)} testId="lib-image-forks" />
          <WorkflowSummaryCard label="Tokens (~)" value={String(entry.derivedEstimatedTokens)} testId="lib-image-tokens" />
          <WorkflowSummaryCard label="Size" value={`${entry.stats.estimatedSizeBytes}B`} testId="lib-image-size" />
        </WorkflowSummaryGrid>

        <div data-testid="lib-image-source" className="font-mono text-[9px] text-stone-500 space-y-0.5">
          <div>source seat: {entry.sourceSeat}</div>
          <div>created: {entry.createdAt}</div>
          <div>last used: {entry.stats.lastUsedAt ?? "never"}</div>
          <div>path: {entry.sourcePath}</div>
          <div data-testid="lib-image-pinned" className={entry.pinned ? "text-amber-700 font-bold" : ""}>pinned: {String(entry.pinned)}</div>
        </div>

        {entry.lineage.length > 0 && (
          <section data-testid="lib-image-lineage" className="border border-stone-300/40 bg-white/8">
            <header className="border-b border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-600">
              Lineage
            </header>
            <div className="px-3 py-2 font-mono text-[10px] text-stone-700">
              {entry.lineage.join(" → ")} → <span className="font-bold">{entry.name}</span>
            </div>
          </section>
        )}

        <section data-testid="lib-image-starter-snippet" className="border border-stone-400 bg-white px-3 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-700">Use as starter</div>
            <Button
              variant="outline"
              size="sm"
              data-testid="agent-image-copy-snippet"
              onClick={() => void onCopySnippet()}
              disabled={!preview?.starterSnippet}
            >
              {snippetCopied ? "Copied" : "Copy snippet"}
            </Button>
          </div>
          <div className="font-mono text-[9px] text-stone-500">
            Paste into your agent.yaml's session_source. The instantiator resolves the image
            via the daemon AgentImageLibraryService at startup time.
          </div>
          {previewLoading && <div className="font-mono text-[9px] text-stone-400">Loading snippet…</div>}
          {preview?.starterSnippet && (
            <pre
              data-testid="lib-image-snippet-text"
              className="font-mono text-[10px] bg-stone-50 border border-stone-200 px-2 py-1 whitespace-pre-wrap"
            >
              {preview.starterSnippet}
            </pre>
          )}
        </section>

        {pinError && (
          <div data-testid="lib-image-pin-error" className="font-mono text-[9px] text-red-600">{pinError}</div>
        )}

        {entry.files.length > 0 && (
          <section className="border border-stone-300/40 bg-white/8">
            <header className="border-b border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-600">
              Supplementary files
            </header>
            <ul className="divide-y divide-stone-100">
              {entry.files.map((f) => (
                <li
                  key={f.path}
                  className="px-3 py-2 font-mono text-[10px] text-stone-800"
                  data-testid={`lib-image-file-${f.path}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-bold truncate">{f.path}</span>
                    <span className="font-mono text-[8px] text-stone-500 shrink-0">
                      role: {f.role}
                      {f.bytes === null ? " · MISSING" : ` · ${f.bytes}B`}
                    </span>
                  </div>
                  {f.summary && <div className="mt-0.5 text-stone-600 text-[9px]">{f.summary}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </WorkspacePage>
  );
}
