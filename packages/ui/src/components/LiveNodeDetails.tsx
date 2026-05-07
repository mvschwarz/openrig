// V1 polish slice Phase 5.1 P5.1-1 + P5.1-1a — agent detail dedup + layout.
//
// Founder direction at V1 polish (verbatim):
//   "We have two competing UI elements for agent detail now... we need to
//   take everything that was in the right sidebar and move it into the
//   agent detail page... action buttons any kind of action you would put
//   like near the top so launching cmux copying tmux resuming all those...
//   then more informational stuff would load at the bottom"
//   "Startup files all of those files should really be clickable so that
//   when you click them it opens up the right hand content drawer"
//   "There's redundancy on the agent detail page. So there's tabs across
//   the top that say detail, transcript and terminal. And then below that
//   is another set of tabs called identity agent spec, start up and
//   transcript. So you have transcript kind of like twice... we should
//   pick where we want the tabs and put them there... probably makes
//   sense to put them down below"
//   "I don't want to lose any content"
//
// Resolution (per Phase 5.1 ACK §2 audit + §6 drift disclosures):
//   - Persistent header at TOP: WorkflowHeader + Action buttons +
//     Status/failure card (merged from retired NodeDetailPanel) + Preview
//     pane (merged) + LiveNodeCurrentState (Activity + Current Work) +
//     Recent Events (merged; founder ask "don't lose content") +
//     Infrastructure startup command card (merged; conditional).
//   - Single 5-tab BODY row: Identity / Agent Spec / Startup / Transcript
//     / Terminal. Replaces the prior outer SeatScopePage tabs +
//     LiveNodeDetails inner tabs nesting (= "transcript twice" perception).
//   - Startup tab: each file wrapped in FileReferenceTrigger — click
//     opens FileViewer in drawer per content-drawer.md L23-L34.
//   - Terminal tab: SessionPreviewPane mounts the live transcript-tail.
//   - DRIFT P5.1-D1: SC-11 seat-scope outer tabs (detail/transcript/
//     terminal) RETIRED at V1 polish per founder direction. SeatScopePage
//     drops outer tabs entirely; LiveNodeDetails owns the canonical
//     5-tab surface inline.

import { useState } from "react";
import { useNodeDetail, type NodeDetailData } from "../hooks/useNodeDetail.js";
import { useSpecLibrary, useLibraryReview } from "../hooks/useSpecLibrary.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { WorkflowHeader } from "./WorkflowScaffold.js";
import { LiveIdentityDisplay } from "./LiveIdentityDisplay.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";
import { PreviewPane } from "./preview/PreviewPane.js";
import { SessionPreviewPane } from "./preview/SessionPreviewPane.js";
import { FileReferenceTrigger } from "./drawer-triggers/FileReferenceTrigger.js";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { copyText } from "../lib/copy-text.js";
import { getActivityLabel, getActivityState, getActivityTextClass, isActivityStale } from "../lib/activity-visuals.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import type { AgentSpecReview } from "../hooks/useSpecReview.js";

type Tab = "identity" | "agent-spec" | "startup" | "transcript" | "terminal";

interface LiveNodeDetailsProps {
  rigId: string;
  logicalId: string;
}

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

/** Extract agent name from a local:agents/<name> ref. Returns null for unsupported forms. */
function resolveAgentName(agentRef: string | null): string | null {
  if (!agentRef) return null;
  const match = agentRef.match(/^local:agents\/([^/]+)$/);
  return match?.[1] ?? null;
}

function AgentSpecSection({ agentRef }: { agentRef: string | null }) {
  const agentName = resolveAgentName(agentRef);
  const { data: agentEntries = [], isLoading: entriesLoading } = useSpecLibrary("agent");

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

/** Action buttons — per founder direction, "action buttons any kind of
 *  action you would put like near the top". Cmux launch + copy tmux +
 *  copy resume. Migrated from retired NodeDetailPanel "Actions" section. */
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
    } catch { /* best-effort */ }
  };
  const handleCopyResume = async () => {
    if (data.resumeCommand) await copyText(data.resumeCommand);
  };
  return (
    <div data-testid="live-node-actions" className="flex flex-wrap gap-2">
      <button
        onClick={handleOpenCmux}
        data-testid="detail-cmux-open"
        className="px-3 py-1.5 border border-outline-variant bg-white/30 font-mono text-[10px] uppercase tracking-wide text-stone-900 hover:bg-stone-100/60"
      >
        Open CMUX
      </button>
      {data.tmuxAttachCommand && (
        <button
          onClick={handleCopyAttach}
          data-testid="detail-copy-attach"
          className="px-3 py-1.5 border border-outline-variant bg-white/30 font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:bg-stone-100/60"
        >
          Copy tmux attach
        </button>
      )}
      {data.resumeCommand && (
        <button
          onClick={handleCopyResume}
          data-testid="detail-copy-resume"
          className="px-3 py-1.5 border border-outline-variant bg-white/30 font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:bg-stone-100/60"
        >
          Copy resume command
        </button>
      )}
    </div>
  );
}

/** Status section — startup status pip + restore outcome + failure
 *  banner with recovery guidance. Merged from retired NodeDetailPanel
 *  Status section. Surfaces in the persistent header. */
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

/** Recent Events — preserved per founder direction "don't want to lose
 *  any content" (P5.1 dispatch ask #3). Compact list of last 10 events.
 *  Migrated from retired NodeDetailPanel. */
function RecentEventsSection({ data }: { data: NodeDetailData }) {
  if (!data.recentEvents || data.recentEvents.length === 0) return null;
  return (
    <section data-testid="live-node-recent-events" className="border border-outline-variant bg-white/30 p-3">
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

export function LiveNodeDetails({ rigId, logicalId }: LiveNodeDetailsProps) {
  const { data, isLoading, error } = useNodeDetail(rigId, logicalId);
  const [activeTab, setActiveTab] = useState<Tab>("identity");
  const isAgent = data ? data.nodeKind !== "infrastructure" : true;
  // Single canonical 5-tab body row per DRIFT P5.1-D1. Terminal folds in
  // from the prior outer SeatScopePage tab; Transcript surfaces only
  // here (eliminates the "transcript twice" duplication).
  const tabs: Tab[] = isAgent
    ? ["identity", "agent-spec", "startup", "transcript", "terminal"]
    : ["identity", "startup", "transcript", "terminal"];

  return (
    <WorkspacePage>
      <div data-testid="live-node-details" className="space-y-4">
        {/* Persistent header — TOP. Action buttons → status → preview →
            current state → recent events → infra (conditional). */}
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

        {data && <ActionButtonsRow rigId={rigId} logicalId={logicalId} data={data} />}
        {data && <StatusSection data={data} />}
        {data?.canonicalSessionName && (
          <section data-testid="live-node-preview" className="border border-outline-variant bg-white/30 p-3">
            <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400 mb-2">Preview</div>
            <PreviewPane
              rigId={rigId}
              rigName={data.rigName}
              logicalId={logicalId}
              testIdPrefix="detail-preview"
            />
          </section>
        )}
        {data && <LiveNodeCurrentState data={data} />}
        {data && <RecentEventsSection data={data} />}
        {data?.nodeKind === "infrastructure" && data.infrastructureStartupCommand && (
          <section data-testid="live-node-infra-startup" className="border border-outline-variant bg-white/30 p-3">
            <div className="font-mono text-[8px] uppercase tracking-wider text-stone-400 mb-2">
              Startup Command
            </div>
            <code className="font-mono text-[9px] text-stone-700 bg-stone-100 px-2 py-1 block">
              {data.infrastructureStartupCommand}
            </code>
          </section>
        )}

        {/* Single tabs row at BOTTOM per founder direction "probably makes
            sense to put them down below". 5 tabs canonical body. */}
        <div className="flex gap-1 border-b border-outline-variant" role="tablist" data-testid="live-node-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              data-testid={`live-tab-${tab}`}
              onClick={() => setActiveTab(tab)}
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
            {data.startupFiles.length > 0 ? (
              <div className="border border-outline-variant bg-white/30">
                <div className="px-3 py-2 border-b border-outline-variant font-mono text-xs font-bold">
                  Startup Files
                </div>
                <ul className="divide-y divide-outline-variant">
                  {data.startupFiles.map((f, i) => (
                    <li
                      key={`${f.path}-${i}`}
                      data-testid={`live-startup-file-${f.path}`}
                    >
                      {/* P5.1-1a: each startup file wrapped in
                          FileReferenceTrigger per content-drawer.md L26 —
                          click opens FileViewer in drawer. */}
                      <FileReferenceTrigger
                        data={{ path: f.path }}
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
              </div>
            ) : (
              <div className="font-mono text-[10px] text-stone-400 p-4">
                No startup files declared
              </div>
            )}
          </div>
        )}

        {data && activeTab === "transcript" && (
          <div data-testid="live-transcript-section" className="space-y-4">
            {data.transcript.enabled ? (
              <div className="border border-outline-variant bg-white/30 p-3">
                <div className="font-mono text-xs font-bold mb-2">Transcript</div>
                <div className="font-mono text-[10px] text-stone-700">{data.transcript.path}</div>
                {data.transcript.tailCommand && (
                  <code className="block mt-1 font-mono text-[9px] text-stone-500 bg-stone-100 px-2 py-1">
                    {data.transcript.tailCommand}
                  </code>
                )}
              </div>
            ) : (
              <div className="font-mono text-[10px] text-stone-400 p-4">
                Transcript capture not enabled
              </div>
            )}
          </div>
        )}

        {data && activeTab === "terminal" && (
          <div data-testid="live-terminal-section" className="space-y-4">
            {data.canonicalSessionName ? (
              <SessionPreviewPane
                sessionName={data.canonicalSessionName}
                lines={50}
                testIdPrefix="live-terminal-preview"
              />
            ) : (
              <div className="font-mono text-[10px] text-stone-400 p-4">
                No canonical session name; terminal preview unavailable.
              </div>
            )}
          </div>
        )}
      </div>
    </WorkspacePage>
  );
}
