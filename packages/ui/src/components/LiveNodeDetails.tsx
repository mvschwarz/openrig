// V1 agent-detail canonical surface.
//
// Polish-8 keeps the title and action row at the top, then makes the tab row
// the only body switcher. Status, preview, current work, transcript, terminal,
// and startup content live inside their named tabs so the page has one clear
// information hierarchy.

import { useState } from "react";
import { useNodeDetail, type NodeDetailData } from "../hooks/useNodeDetail.js";
import { useSpecLibrary, useLibraryReview } from "../hooks/useSpecLibrary.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { WorkflowHeader } from "./WorkflowScaffold.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";
import { PreviewPane } from "./preview/PreviewPane.js";
import { SessionPreviewPane } from "./preview/SessionPreviewPane.js";
import { FileReferenceTrigger } from "./drawer-triggers/FileReferenceTrigger.js";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { copyText } from "../lib/copy-text.js";
import { getActivityLabel, getActivityState, getActivityTextClass, isActivityStale } from "../lib/activity-visuals.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import type { AgentSpecReview } from "../hooks/useSpecReview.js";
import { RuntimeBadge, RuntimeMark, ToolMark } from "./graphics/RuntimeMark.js";

type Tab = "identity" | "agent-spec" | "startup" | "transcript" | "terminal";

interface LiveNodeDetailsProps {
  rigId: string;
  logicalId: string;
}

const SECTION_CLASS = "border border-outline-variant bg-white/30 p-3";

function statusColor(status: string | null): string {
  switch (status) {
    case "ready": return "text-green-600";
    case "pending": return "text-amber-600";
    case "attention_required": return "text-orange-600";
    case "failed": return "text-red-600";
    default: return "text-stone-400";
  }
}

function startupStatusLabel(status: string | null): string {
  switch (status) {
    case "attention_required": return "attention required";
    default: return status ?? "stopped";
  }
}

function resolveAgentName(agentRef: string | null): string | null {
  if (!agentRef) return null;
  const match = agentRef.match(/^local:agents\/([^/]+)$/);
  return match?.[1] ?? null;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between gap-3 font-mono text-[10px]">
      <span className="text-stone-500">{label}</span>
      <span className="truncate text-right text-stone-900">{value}</span>
    </div>
  );
}

function AgentSpecSection({ data }: { data: NodeDetailData }) {
  const agentName = resolveAgentName(data.agentRef);
  const { data: agentEntries = [], isLoading: entriesLoading } = useSpecLibrary("agent");

  const matches = agentName
    ? agentEntries.filter((entry) => entry.name === agentName)
    : [];

  const entryId = matches.length === 1 ? matches[0]!.id : null;
  const { data: review, isLoading: reviewLoading } = useLibraryReview(entryId);

  return (
    <div data-testid="live-agent-spec-section" className="space-y-4">
      {data.compactSpec.name && (
        <section data-testid="detail-compact-spec" className={SECTION_CLASS}>
          <div className="mb-2 font-mono text-[8px] uppercase tracking-wider text-stone-400">Resolved Agent Spec</div>
          <div className="space-y-0.5">
            <InfoRow label="Spec" value={data.compactSpec.name} />
            <InfoRow label="Version" value={data.compactSpec.version} />
            <InfoRow label="Profile" value={data.compactSpec.profile} />
            <InfoRow label="Skills" value={data.compactSpec.skillCount} />
            <InfoRow label="Guidance" value={data.compactSpec.guidanceCount} />
          </div>
        </section>
      )}

      {!agentName ? (
        <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-stone-400">No agent spec available</div>
      ) : entriesLoading || reviewLoading ? (
        <div className="p-4 font-mono text-[10px] text-stone-400">Loading agent spec...</div>
      ) : matches.length === 0 ? (
        <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-stone-400">No agent spec available</div>
      ) : matches.length > 1 ? (
        <div data-testid="agent-spec-ambiguous" className="p-4 font-mono text-[10px] text-amber-600">
          Agent spec ambiguous ({matches.length} matches for &quot;{agentName}&quot;)
        </div>
      ) : !review || review.kind !== "agent" ? (
        <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-stone-400">No agent spec available</div>
      ) : (
        <AgentSpecDisplay
          review={review as AgentSpecReview}
          yaml={review.raw}
          testIdPrefix="live-agent"
          sourcePath={review.sourcePath}
        />
      )}
    </div>
  );
}

function ActionButtonsRow({ rigId, logicalId, data }: { rigId: string; logicalId: string; data: NodeDetailData }) {
  const handleCopyAttach = async () => {
    if (data.tmuxAttachCommand) await copyText(data.tmuxAttachCommand);
  };
  const handleOpenCmux = async () => {
    try {
      await fetch(
        `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/open-cmux`,
        { method: "POST" },
      );
    } catch {
      // best effort
    }
  };
  const handleCopyResume = async () => {
    if (data.resumeCommand) await copyText(data.resumeCommand);
  };
  return (
    <div data-testid="live-node-actions" className="flex flex-wrap gap-2">
      <button
        onClick={handleOpenCmux}
        data-testid="detail-cmux-open"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-outline-variant bg-white/30 font-mono text-[10px] uppercase tracking-wide text-stone-900 hover:bg-stone-100/60"
      >
        <ToolMark tool="cmux" size="sm" />
        Open CMUX
      </button>
      {data.tmuxAttachCommand && (
        <button
          onClick={handleCopyAttach}
          data-testid="detail-copy-attach"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-outline-variant bg-white/30 font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:bg-stone-100/60"
        >
          <ToolMark tool="tmux" size="sm" />
          Copy tmux attach
        </button>
      )}
      {data.resumeCommand && (
        <button
          onClick={handleCopyResume}
          data-testid="detail-copy-resume"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-outline-variant bg-white/30 font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:bg-stone-100/60"
        >
          <RuntimeMark runtime={data.runtime} size="sm" />
          Copy resume command
        </button>
      )}
    </div>
  );
}

function StatusSection({ data }: { data: NodeDetailData }) {
  const showFailure =
    data.startupStatus === "failed" ||
    data.startupStatus === "attention_required" ||
    !!data.latestError;
  return (
    <section
      data-testid="live-node-status"
      className="grid gap-2 border border-outline-variant bg-white/30 p-3 sm:grid-cols-2"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[8px] uppercase tracking-wider text-stone-400">Startup</span>
        <span className={statusColor(data.startupStatus)} data-testid="detail-startup-status">
          {startupStatusLabel(data.startupStatus)}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[8px] uppercase tracking-wider text-stone-400">Restore</span>
        <span
          className={`font-mono text-xs font-bold ${getRestoreStatusColorClass(data.restoreOutcome)}`}
          data-testid="detail-restore-outcome"
        >
          {data.restoreOutcome}
        </span>
      </div>
      {showFailure && (
        <div
          className={`sm:col-span-2 mt-1 p-2 border ${
            data.startupStatus === "attention_required"
              ? "bg-orange-50 border-orange-200"
              : "bg-red-50 border-red-200"
          }`}
          data-testid="detail-failure-banner"
        >
          <div
            className={`font-mono text-[9px] font-bold mb-1 ${
              data.startupStatus === "attention_required" ? "text-orange-700" : "text-red-700"
            }`}
          >
            {data.startupStatus === "attention_required"
              ? "Attention Required"
              : data.startupStatus === "failed"
                ? "Startup Failed"
                : "Error"}
          </div>
          {data.latestError && (
            <div
              className={`font-mono text-[9px] mb-1 ${
                data.startupStatus === "attention_required" ? "text-orange-700" : "text-red-600"
              }`}
            >
              {data.latestError}
            </div>
          )}
          <div className="font-mono text-[8px] text-stone-500">
            {data.startupStatus === "attention_required"
              ? `Use rig capture ${data.canonicalSessionName ?? "<session>"} to inspect the prompt, then rig send ${data.canonicalSessionName ?? "<session>"} to clear it.`
              : data.startupStatus === "failed"
                ? "Check logs with: rig ps --nodes, or restart with: rig up"
                : "Try: rig restore <snapshotId>"}
          </div>
          {data.recoveryGuidance && (
            <div className="mt-2 border-t border-stone-200 pt-2" data-testid="detail-recovery-guidance">
              <div className="font-mono text-[8px] font-bold text-stone-700 mb-1">Recovery</div>
              <div className="font-mono text-[8px] text-stone-600 mb-1">{data.recoveryGuidance.summary}</div>
              <div className="space-y-0.5 mb-1">
                {data.recoveryGuidance.commands.map((command, index) => (
                  <code key={`${command}-${index}`} className="font-mono text-[8px] text-stone-800 bg-stone-100 px-1 py-0.5 block">
                    {command}
                  </code>
                ))}
              </div>
              <div className="space-y-0.5">
                {data.recoveryGuidance.notes.map((note, index) => (
                  <div key={`${note}-${index}`} className="font-mono text-[8px] text-stone-500">
                    {note}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
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
      className="grid gap-3 border border-outline-variant bg-white/30 p-3 sm:grid-cols-2"
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

function RecentEventsSection({ data }: { data: NodeDetailData }) {
  if (!data.recentEvents || data.recentEvents.length === 0) return null;
  return (
    <section data-testid="live-node-recent-events" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400 mb-2">
        Recent Events
      </div>
      <div className="space-y-0.5">
        {data.recentEvents.slice(0, 10).map((e, i) => (
          <div key={`${e.type}-${i}`} className="font-mono text-[9px] flex justify-between gap-3">
            <span className="text-stone-700 truncate">{e.type}</span>
            <span className="text-stone-400 ml-2 shrink-0">{e.createdAt}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function IdentitySummary({ data }: { data: NodeDetailData }) {
  return (
    <section data-testid="live-identity-summary" className={SECTION_CLASS}>
      <div className="mb-2 font-mono text-[8px] uppercase tracking-wider text-stone-400">Identity</div>
      <div className="grid gap-1 sm:grid-cols-2">
        {data.runtime ? (
          <div className="flex justify-between gap-3 font-mono text-[10px]">
            <span className="text-stone-500">Runtime</span>
            <RuntimeBadge runtime={data.runtime} model={data.model} size="xs" compact variant="inline" className="max-w-[12rem]" />
          </div>
        ) : null}
        <InfoRow label="Model" value={data.model} />
        <InfoRow label="Profile" value={data.profile} />
        <InfoRow label="Spec" value={data.resolvedSpecName} />
        <InfoRow label="Version" value={data.resolvedSpecVersion} />
        <InfoRow label="CWD" value={data.cwd} />
      </div>
    </section>
  );
}

function EdgesSection({ data }: { data: NodeDetailData }) {
  const { outgoing, incoming } = data.edges;
  if (outgoing.length === 0 && incoming.length === 0) return null;
  return (
    <section data-testid="detail-edges" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Edges</div>
      <div className="space-y-0.5 font-mono text-[10px]">
        {outgoing.map((e, i) => (
          <div key={`out-${i}`} className="flex gap-1">
            <span className="text-stone-400">-&gt;</span>
            <span className="text-stone-500">{e.kind}</span>
            <span className="text-stone-900">{e.to?.logicalId ?? "?"}</span>
          </div>
        ))}
        {incoming.map((e, i) => (
          <div key={`in-${i}`} className="flex gap-1">
            <span className="text-stone-400">&lt;-</span>
            <span className="text-stone-500">{e.kind}</span>
            <span className="text-stone-900">{e.from?.logicalId ?? "?"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PeersSection({ data }: { data: NodeDetailData }) {
  if (data.peers.length === 0) return null;
  return (
    <section data-testid="detail-peers" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Peers</div>
      <div className="space-y-1 font-mono text-[10px]">
        {data.peers.map((p) => (
          <div key={p.logicalId} className="space-y-0">
            <div className="flex justify-between gap-3">
              <span className="text-stone-900">{p.logicalId}</span>
              <span className="text-stone-500">{p.runtime ?? "-"}</span>
            </div>
            {p.canonicalSessionName && (
              <div className="text-[9px] text-stone-400 truncate">{p.canonicalSessionName}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ContextUsageSection({ data }: { data: NodeDetailData }) {
  const contextUsage = data.contextUsage;
  return (
    <section data-testid="detail-context-usage" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Context</div>
      {contextUsage?.availability === "known" ? (
        <div className="space-y-0.5 font-mono text-[10px]">
          <InfoRow label="Used" value={contextUsage.usedPercentage != null ? `${contextUsage.usedPercentage}%` : null} />
          <InfoRow label="Remaining" value={contextUsage.remainingPercentage != null ? `${contextUsage.remainingPercentage}%` : null} />
          <InfoRow label="Window" value={contextUsage.contextWindowSize?.toLocaleString()} />
          <InfoRow label="Input tokens" value={contextUsage.totalInputTokens?.toLocaleString()} />
          <InfoRow label="Output tokens" value={contextUsage.totalOutputTokens?.toLocaleString()} />
          <InfoRow label="Sampled" value={contextUsage.sampledAt} />
          {contextUsage.fresh === false && (
            <div className="font-mono text-[9px] text-amber-600 mt-1">Stale sample</div>
          )}
        </div>
      ) : (
        <div className="font-mono text-[10px] text-stone-400">
          unknown{contextUsage?.reason ? ` (${contextUsage.reason})` : ""}
        </div>
      )}
    </section>
  );
}

function IdentityTab({ data }: { data: NodeDetailData }) {
  return (
    <div data-testid="live-identity-section" className="space-y-4">
      <IdentitySummary data={data} />
      <LiveNodeCurrentState data={data} />
      <RecentEventsSection data={data} />
      <EdgesSection data={data} />
      <PeersSection data={data} />
      <ContextUsageSection data={data} />
    </div>
  );
}

function StartupTab({ rigId, logicalId, data }: { rigId: string; logicalId: string; data: NodeDetailData }) {
  return (
    <div data-testid="live-startup-section" className="space-y-4">
      <StatusSection data={data} />

      {data.canonicalSessionName && (
        <section data-testid="live-node-preview" className={SECTION_CLASS}>
          <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400 mb-2">Preview</div>
          <PreviewPane
            rigId={rigId}
            rigName={data.rigName}
            logicalId={logicalId}
            testIdPrefix="detail-preview"
          />
        </section>
      )}

      {data.infrastructureStartupCommand && (
        <section data-testid="live-node-infra-startup" className={SECTION_CLASS}>
          <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400 mb-2">
            Startup Command
          </div>
          <code className="font-mono text-[9px] text-stone-700 bg-stone-100 px-2 py-1 block">
            {data.infrastructureStartupCommand}
          </code>
        </section>
      )}

      {data.startupActions.length > 0 && (
        <section data-testid="live-startup-actions" className={SECTION_CLASS}>
          <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400 mb-2">Startup Actions</div>
          <div className="space-y-1">
            {data.startupActions.map((action, index) => (
              <div key={`${action.type}-${action.value}-${index}`} className="font-mono text-[10px] text-stone-700">
                <span className="text-stone-500">{action.type}:</span> {action.value}
              </div>
            ))}
          </div>
        </section>
      )}

      {data.startupFiles.length > 0 ? (
        <section className="border border-outline-variant bg-white/30">
          <div className="px-3 py-2 border-b border-outline-variant font-mono text-xs font-bold">
            Startup Files
          </div>
          <ul className="divide-y divide-outline-variant">
            {data.startupFiles.map((f, i) => (
              <li
                key={`${f.path}-${i}`}
                data-testid={`live-startup-file-${f.path}`}
              >
                <FileReferenceTrigger
                  data={{ path: f.path, absolutePath: f.absolutePath }}
                  testId={`live-startup-file-trigger-${f.path}`}
                  className="block w-full px-3 py-2 text-left hover:bg-stone-100/60 transition-colors font-mono text-[10px]"
                >
                  <span className="font-bold underline decoration-dotted decoration-stone-400">
                    {f.path}
                  </span>
                  <span className="text-stone-400 ml-2">({f.deliveryHint})</span>
                  {f.required && (
                    <span className="text-red-500 text-[8px] ml-1">REQUIRED</span>
                  )}
                </FileReferenceTrigger>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="font-mono text-[10px] text-stone-400 p-4">
          No startup files declared
        </div>
      )}
    </div>
  );
}

function TranscriptTab({ data }: { data: NodeDetailData }) {
  if (!data.transcript.enabled) {
    return (
      <div data-testid="live-transcript-section" className="font-mono text-[10px] text-stone-400 p-4">
        Transcript capture not enabled
      </div>
    );
  }

  return (
    <div data-testid="live-transcript-section" className="space-y-4">
      <section data-testid="detail-transcript" className={SECTION_CLASS}>
        <div className="font-mono text-xs font-bold mb-2">Transcript</div>
        <div className="font-mono text-[10px] text-stone-700">{data.transcript.path ?? "enabled"}</div>
        {data.transcript.tailCommand && (
          <button
            type="button"
            onClick={() => copyText(data.transcript.tailCommand!)}
            className="mt-2 w-full border border-stone-300 bg-white/40 px-2 py-1 text-left font-mono text-[8px] uppercase text-stone-700 hover:bg-stone-100"
          >
            Copy tail command
          </button>
        )}
      </section>
    </div>
  );
}

function TerminalTab({ data }: { data: NodeDetailData }) {
  return (
    <div data-testid="live-terminal-section" className="space-y-4">
      {data.canonicalSessionName ? (
        <div data-testid="live-terminal-shell" className="bg-stone-950/65 p-2 text-stone-50 backdrop-blur-sm">
          <SessionPreviewPane
            sessionName={data.canonicalSessionName}
            lines={80}
            testIdPrefix="live-terminal-preview"
            variant="compact-terminal"
          />
        </div>
      ) : (
        <div className="font-mono text-[10px] text-stone-400 p-4">
          No canonical session name; terminal preview unavailable.
        </div>
      )}
    </div>
  );
}

function TabNav({
  tabs,
  activeTab,
  onSelect,
}: {
  tabs: Tab[];
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-outline-variant" role="tablist" data-testid="live-node-tabs">
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={activeTab === tab}
          data-testid={`live-tab-${tab}`}
          onClick={() => onSelect(tab)}
          className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
            activeTab === tab
              ? "border-b-2 border-stone-900 text-stone-900 font-bold -mb-px"
              : "text-stone-500 hover:text-stone-700"
          }`}
        >
          {tab.replace("-", " ")}
        </button>
      ))}
    </div>
  );
}

export function LiveNodeDetails({ rigId, logicalId }: LiveNodeDetailsProps) {
  const { data, isLoading, error } = useNodeDetail(rigId, logicalId);
  const [activeTab, setActiveTab] = useState<Tab>("identity");
  const isAgent = data ? data.nodeKind !== "infrastructure" : true;
  const tabs: Tab[] = isAgent
    ? ["identity", "agent-spec", "startup", "transcript", "terminal"]
    : ["identity", "startup", "transcript", "terminal"];

  return (
    <WorkspacePage>
      <div data-testid="live-node-details" className="space-y-4">
        <WorkflowHeader
          eyebrow="Live Node Details"
          title={data?.canonicalSessionName ?? logicalId}
          description={`${data?.rigName ?? rigId} / ${data?.podNamespace ?? inferPodName(logicalId) ?? displayPodName(data?.podId ?? null)} / ${logicalId}`}
        />

        {isLoading && <div className="font-mono text-[10px] text-stone-400">Loading...</div>}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">
            {(error as Error).message}
          </div>
        )}

        {data && (
          <>
            <ActionButtonsRow rigId={rigId} logicalId={logicalId} data={data} />
            <TabNav tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} />
            <div data-testid="live-node-tab-body" className="space-y-4">
              {activeTab === "identity" && <IdentityTab data={data} />}
              {activeTab === "agent-spec" && isAgent && <AgentSpecSection data={data} />}
              {activeTab === "startup" && <StartupTab rigId={rigId} logicalId={logicalId} data={data} />}
              {activeTab === "transcript" && <TranscriptTab data={data} />}
              {activeTab === "terminal" && <TerminalTab data={data} />}
            </div>
          </>
        )}
      </div>
    </WorkspacePage>
  );
}
