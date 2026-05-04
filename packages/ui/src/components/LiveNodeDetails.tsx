import { useState } from "react";
import { useNodeDetail, type NodeDetailData } from "../hooks/useNodeDetail.js";
import { useSpecLibrary, useLibraryReview } from "../hooks/useSpecLibrary.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { WorkflowHeader } from "./WorkflowScaffold.js";
import { LiveIdentityDisplay } from "./LiveIdentityDisplay.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { getActivityLabel, getActivityState, getActivityTextClass, isActivityStale } from "../lib/activity-visuals.js";
import type { AgentSpecReview } from "../hooks/useSpecReview.js";

type Tab = "identity" | "agent-spec" | "startup" | "transcript";

interface LiveNodeDetailsProps {
  rigId: string;
  logicalId: string;
}

/** Extract agent name from a local:agents/<name> ref. Returns null for unsupported forms. */
function resolveAgentName(agentRef: string | null): string | null {
  if (!agentRef) return null;
  const match = agentRef.match(/^local:agents\/([^/]+)$/);
  return match?.[1] ?? null;
}

function AgentSpecSection({ agentRef }: { agentRef: string | null }) {
  const agentName = resolveAgentName(agentRef);
  const { data: agentEntries = [], isLoading: entriesLoading } = useSpecLibrary("agent");

  // Find matching library entry
  const matches = agentName
    ? agentEntries.filter((entry) => entry.name === agentName)
    : [];

  const entryId = matches.length === 1 ? matches[0]!.id : null;
  const { data: review, isLoading: reviewLoading } = useLibraryReview(entryId);

  if (!agentName) {
    return <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-stone-400">No agent spec available</div>;
  }

  if (entriesLoading || reviewLoading) {
    return <div className="p-4 font-mono text-[10px] text-stone-400">Loading agent spec...</div>;
  }

  if (matches.length === 0) {
    return <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-stone-400">No agent spec available</div>;
  }

  if (matches.length > 1) {
    return (
      <div data-testid="agent-spec-ambiguous" className="p-4 font-mono text-[10px] text-amber-600">
        Agent spec ambiguous ({matches.length} matches for &quot;{agentName}&quot;)
      </div>
    );
  }

  if (!review || review.kind !== "agent") {
    return <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-stone-400">No agent spec available</div>;
  }

  return <AgentSpecDisplay review={review as AgentSpecReview} yaml={review.raw} testIdPrefix="live-agent" />;
}

function LiveNodeCurrentState({ data }: { data: NodeDetailData }) {
  const activityState = getActivityState(data.agentActivity);
  const activityLabel = getActivityLabel(activityState);
  const activityTextClass = getActivityTextClass(activityState);
  const activityStale = isActivityStale(data.agentActivity);
  const qitems = data.currentQitems ?? [];

  return (
    <section
      data-testid="live-node-current-state"
      className="grid gap-3 border border-stone-200 bg-stone-50/60 p-3 sm:grid-cols-2"
    >
      <div>
        <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400">Activity</div>
        <div
          data-testid="live-node-agent-activity"
          className={`mt-1 font-mono text-[11px] font-bold uppercase ${activityTextClass}`}
        >
          {activityLabel}{activityStale ? " stale" : ""}
        </div>
        {data.agentActivity?.reason && (
          <div className="mt-1 font-mono text-[9px] text-stone-500">{data.agentActivity.reason}</div>
        )}
      </div>

      <div>
        <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400">Current Work</div>
        <div data-testid="live-node-current-qitems" className="mt-1 space-y-1">
          {qitems.length > 0 ? qitems.map((qitem) => (
            <div key={qitem.qitemId} className="font-mono text-[9px] leading-4 text-stone-700">
              <div className="font-bold text-stone-900">{qitem.qitemId}</div>
              <div>{qitem.bodyExcerpt}</div>
              {qitem.tier && <div className="text-[8px] uppercase tracking-wider text-stone-400">{qitem.tier}</div>}
            </div>
          )) : (
            <div className="font-mono text-[9px] text-stone-400">No current qitems</div>
          )}
        </div>
      </div>
    </section>
  );
}

export function LiveNodeDetails({ rigId, logicalId }: LiveNodeDetailsProps) {
  const { data, isLoading, error } = useNodeDetail(rigId, logicalId);
  const [activeTab, setActiveTab] = useState<Tab>("identity");
  const isAgent = data ? data.nodeKind !== "infrastructure" : true;
  const tabs: Tab[] = isAgent ? ["identity", "agent-spec", "startup", "transcript"] : ["identity", "startup", "transcript"];

  return (
    <WorkspacePage>
      <div data-testid="live-node-details" className="space-y-6">
        <WorkflowHeader
          eyebrow="Live Node Details"
          title={data?.canonicalSessionName ?? logicalId}
          description={`${data?.rigName ?? rigId} / ${data?.podNamespace ?? inferPodName(logicalId) ?? displayPodName(data?.podId ?? null)} / ${logicalId}`}
        />

        {isLoading && <div className="font-mono text-[10px] text-stone-400">Loading...</div>}
        {error && <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">{(error as Error).message}</div>}
        {data && <LiveNodeCurrentState data={data} />}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-stone-200">
          {tabs.map((tab) => (
            <button
              key={tab}
              data-testid={`live-tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                activeTab === tab
                  ? "border-b-2 border-stone-900 text-stone-900 font-bold"
                  : "text-stone-500 hover:text-stone-700"
              }`}
            >
              {tab.replace("-", " ")}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {data && activeTab === "identity" && (
          <LiveIdentityDisplay
            peers={data.peers}
            edges={data.edges}
            transcript={data.transcript}
            compactSpec={data.compactSpec}
            contextUsage={data.contextUsage}
          />
        )}

        {data && activeTab === "agent-spec" && isAgent && (
          <AgentSpecSection agentRef={data.agentRef} />
        )}

        {data && activeTab === "startup" && (
          <div data-testid="live-startup-section" className="space-y-4">
            {data.startupFiles.length > 0 && (
              <div className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">Startup Files</div>
                {data.startupFiles.map((f, i) => (
                  <div key={i} className="font-mono text-[10px]">
                    {f.path} <span className="text-stone-400">({f.deliveryHint})</span>
                    {f.required && <span className="text-red-500 text-[8px] ml-1">REQUIRED</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {data && activeTab === "transcript" && (
          <div data-testid="live-transcript-section" className="space-y-4">
            {data.transcript.enabled ? (
              <div className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">Transcript</div>
                <div className="font-mono text-[10px] text-stone-700">{data.transcript.path}</div>
                {data.transcript.tailCommand && (
                  <code className="block mt-1 font-mono text-[9px] text-stone-500 bg-stone-100 px-2 py-1">{data.transcript.tailCommand}</code>
                )}
              </div>
            ) : (
              <div className="font-mono text-[10px] text-stone-400 p-4">Transcript capture not enabled</div>
            )}
          </div>
        )}
      </div>
    </WorkspacePage>
  );
}
