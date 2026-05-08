import { useRef, useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { copyText } from "../lib/copy-text.js";
import { displayAgentName } from "../lib/display-name.js";
import { cn } from "../lib/utils.js";
import {
  getActivityState,
  getActivityLabel,
  getActivityBgClass,
  getActivityAnimationClass,
  isActivityStale,
  shortQitemTail,
} from "../lib/activity-visuals.js";
import type { AgentActivitySummary, CurrentQitemSummary } from "../hooks/useNodeInventory.js";
import { ContextUsageRing } from "./ContextUsageRing.js";
import { ActivityRing } from "./topology/ActivityRing.js";
import { getActivityCardClasses, getActivityCardSignal } from "./topology/activity-card-visuals.js";
import { TerminalPreviewPopover } from "./topology/TerminalPreviewPopover.js";
import type { TopologyActivityVisual } from "../lib/topology-activity.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../lib/token-format.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";

interface RigNodeData {
  logicalId: string;
  rigId?: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  packageRefs?: string[];
  nodeKind?: "agent" | "infrastructure";
  startupStatus?: "pending" | "ready" | "attention_required" | "failed" | null;
  canonicalSessionName?: string | null;
  podId?: string | null;
  restoreOutcome?: string;
  resumeToken?: string | null;
  resolvedSpecName?: string | null;
  profile?: string | null;
  edgeCount?: number;
  binding: {
    tmuxSession?: string | null;
    cmuxSurface?: string | null;
  } | null;
  contextUsedPercentage?: number | null;
  contextFresh?: boolean;
  contextAvailability?: string;
  contextTotalInputTokens?: number | null;
  contextTotalOutputTokens?: number | null;
  placementState?: "available" | "selected" | null;
  // PL-019: agent activity drives the node's primary "is this agent
  // working?" dot color (replacing the previous startup-status color).
  // currentQitems surfaces in the hover hint when the agent is running.
  agentActivity?: AgentActivitySummary | null;
  currentQitems?: CurrentQitemSummary[];
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
}

/** Core roles get dark header stripe, workers get light */
function isCore(role: string | null): boolean {
  return role === "architect" || role === "lead" || role === "orchestrator";
}

export function RigNode({ data }: { data: RigNodeData }) {
  const prevStatusRef = useRef(data.startupStatus);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusChanged, setStatusChanged] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<"attach" | "resume" | "cmux" | null>(null);
  const core = isCore(data.role);
  const isInfra = data.nodeKind === "infrastructure";

  useEffect(() => {
    if (prevStatusRef.current !== data.startupStatus && prevStatusRef.current !== null) {
      setStatusChanged(true);
      const timer = setTimeout(() => setStatusChanged(false), 600);
      prevStatusRef.current = data.startupStatus;
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = data.startupStatus;
  }, [data.startupStatus]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const runtimeModel = [data.runtime, data.model].filter(Boolean).join(" \u00B7 ");
  const agentName = displayAgentName(data.logicalId);

  // PL-019: dot color is now driven by agentActivity.state, not startupStatus.
  // startupStatus retains its independent surface via the ATTN/FAILED badges
  // below \u2014 activity answers "is this agent working?", startup answers "did
  // this agent boot?". Two different questions, two different surfaces.
  const activityState = getActivityState(data.agentActivity);
  const activityLabel = getActivityLabel(activityState);
  const activityBgClass = getActivityBgClass(activityState);
  const activityAnimClass = getActivityAnimationClass(activityState);
  const activityIsStale = isActivityStale(data.agentActivity);
  const activityCard = getActivityCardSignal({ activityRing: data.activityRing, activityState });
  const tokenTotal = sumTokenCounts(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const tokenLabel = formatCompactTokenCount(tokenTotal);
  const tokenTitle = formatTokenTotalTitle(data.contextTotalInputTokens, data.contextTotalOutputTokens);

  const placementChipLabel = data.placementState === "selected" ? "target" : data.placementState === "available" ? "avail" : null;

  // PL-019 item 5: include active-qitem summary in the hover hint when the
  // agent is currently running and the daemon attached one or more qitems.
  // Short ULID tail for hover; full id is in the drawer (separate surface).
  const currentQitems = data.currentQitems ?? [];
  const qitemHoverLines = currentQitems.length > 0
    ? currentQitems.map((q) => `On: ${shortQitemTail(q.qitemId)} \u2014 ${q.bodyExcerpt}`)
    : [];

  const hoverHintLines = [
    `Activity: ${activityLabel}${activityIsStale ? " (stale sample)" : ""}`,
    data.canonicalSessionName ? `Session: ${data.canonicalSessionName}` : null,
    runtimeModel ? `Runtime: ${runtimeModel}` : null,
    data.resolvedSpecName ? `Spec: ${data.resolvedSpecName}` : null,
    data.profile ? `Profile: ${data.profile}` : null,
    typeof data.edgeCount === "number" ? `Edges: ${data.edgeCount}` : null,
    tokenTitle,
    ...qitemHoverLines,
  ].filter((line): line is string => Boolean(line));
  const hoverHint = hoverHintLines.join("\n");

  const flashFeedback = (kind: "attach" | "resume" | "cmux") => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setActionFeedback(kind);
    feedbackTimerRef.current = setTimeout(() => {
      setActionFeedback((current) => (current === kind ? null : current));
      feedbackTimerRef.current = null;
    }, 900);
  };

  const handleCopyAttach = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const name = data.canonicalSessionName ?? data.binding?.tmuxSession;
    if (name) {
      await copyText(`tmux attach -t ${name}`);
      flashFeedback("attach");
    }
  };

  const handleOpenCmux = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!data.rigId) return;
    try {
      const res = await fetch(`/api/rigs/${encodeURIComponent(data.rigId)}/nodes/${encodeURIComponent(data.logicalId)}/open-cmux`, { method: "POST" });
      if (res.ok) {
        flashFeedback("cmux");
      }
    } catch { /* best-effort */ }
  };

  const handleCopyResume = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!data.resumeToken) return;
    if (data.runtime === "claude-code") {
      await copyText(`claude --resume ${data.resumeToken}`);
      flashFeedback("resume");
    } else if (data.runtime === "codex") {
      await copyText(`codex resume ${data.resumeToken}`);
      flashFeedback("resume");
    }
  };

  const buttonClass = (kind: "attach" | "resume" | "cmux") =>
    `inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[7px] uppercase transition-colors ${
      actionFeedback === kind
        ? "bg-stone-900 text-white border-stone-900"
        : "bg-white text-stone-900 border-stone-300 hover:bg-stone-100"
    }`;
  const toolbarIconButtonClass = "border font-mono text-[7px] uppercase transition-colors bg-white text-stone-900 border-stone-300 hover:bg-stone-100 inline-flex h-6 w-6 items-center justify-center px-0 py-0";
  const terminalSessionName = data.canonicalSessionName ?? data.binding?.tmuxSession ?? null;

  const card = (
    <div
      className={cn(
        "group relative min-w-[200px] border hard-shadow transition-[background-color,border-color,box-shadow] duration-300",
        getActivityCardClasses({
          state: activityCard.state,
          flash: activityCard.flash,
          reducedMotion: data.reducedMotion,
        }),
        data.placementState === "selected"
          ? "border-emerald-600 ring-2 ring-emerald-400/70 shadow-[0_0_0_3px_rgba(52,211,153,0.12)]"
          : data.placementState === "available"
            ? "border-emerald-500 ring-1 ring-emerald-300/70"
            : "border-stone-900",
      )}
      data-activity-card-state={activityCard.state}
      data-activity-card-flash={activityCard.flash ?? "none"}
      data-testid="rig-node"
      title={hoverHint || undefined}
    >
      <Handle type="target" position={Position.Top} />

      {/* Header stripe — dark for core, muted for infra, light for workers */}
      <div className={`px-3 py-1 font-mono text-[10px] flex justify-between items-center ${
        isInfra
          ? "bg-stone-500 text-white border-b border-stone-900"
          : core
            ? "bg-stone-900 text-white"
            : "bg-stone-200 text-stone-900 border-b border-stone-900"
      }`}>
        <span className="font-bold truncate">
          {agentName}
        </span>
        <span className="inline-flex items-center gap-1">
          {activityIsStale && (
            <span
              data-testid={`activity-staleness-${data.logicalId}`}
              className="font-mono text-[7px] uppercase tracking-[0.10em] text-stone-300"
              title={`Activity sample is older than threshold; daemon may not be probing this seat`}
            >
              stale
            </span>
          )}
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full border border-white/50 ${activityBgClass} ${activityAnimClass} ${statusChanged ? "status-changed" : ""}`}
            data-testid={`activity-dot-${data.logicalId}`}
            data-activity-state={activityState}
            aria-label={`activity: ${activityLabel}`}
            title={`activity: ${activityLabel}`}
          />
          {/* PL-012: context-usage tier ring parallel to PL-019 activity
              dot. Two signals at the same scale: "is this agent working?"
              (left dot, filled) vs "is this agent close to context
              exhaustion?" (right ring, hollow). */}
          <ContextUsageRing
            percent={data.contextUsedPercentage}
            fresh={data.contextFresh}
            availability={data.contextAvailability}
            testIdSuffix={data.logicalId}
          />
        </span>
      </div>

      {/* Body */}
      <div className="space-y-1 px-2 py-1.5">
        <div className="truncate font-mono text-[8px] leading-tight text-stone-500">
          {data.canonicalSessionName ?? data.logicalId}
        </div>

        <div className="min-w-0">
          <RuntimeBadge
            runtime={data.runtime}
            model={data.model}
            size="xs"
            compact
            variant="inline"
            className="max-w-full"
          />
          {!runtimeModel && data.profile ? (
            <span className="ml-1 font-mono text-[8px] uppercase tracking-[0.12em] text-stone-400">
              {data.profile}
            </span>
          ) : null}
        </div>

        {/* Spec hint */}
        {data.resolvedSpecName && (
          <div className="font-mono text-[8px] text-stone-400" data-testid="spec-hint">
            {data.resolvedSpecName}{data.profile ? ` · ${data.profile}` : ""}
          </div>
        )}

        {/* Context usage — prominent big number per founder directive */}
        <div className="flex items-end justify-between gap-3 pt-0.5">
          {data.contextAvailability === "known" && typeof data.contextUsedPercentage === "number" ? (
            <div
              className={`font-mono text-base font-bold leading-none ${
                data.contextUsedPercentage >= 80 ? "text-red-600" :
                data.contextUsedPercentage >= 60 ? "text-amber-600" :
                "text-green-700"
              }${!data.contextFresh ? " opacity-50" : ""}`}
              data-testid="context-badge"
              title={data.contextFresh ? "Context usage (fresh)" : "Context usage (stale sample)"}
            >
              {data.contextUsedPercentage}%
            </div>
          ) : (
            <div className="font-mono text-xs text-stone-400" data-testid="context-badge-unknown">
              ?
            </div>
          )}
          <div
            className={`font-mono text-base font-bold leading-none tracking-[0.02em] ${tokenLabel ? "text-stone-500" : "text-stone-300"}`}
            data-testid="token-total"
            title={tokenTitle ?? "Token sample unavailable"}
          >
            {tokenLabel ?? "--"}
          </div>
        </div>

        {/* Restore outcome */}
        {data.restoreOutcome && data.restoreOutcome !== "n-a" && (
          <div className="font-mono text-[8px] text-stone-500">
            RESTORE: {data.restoreOutcome}
          </div>
        )}

        {/* Package badge (legacy) */}
        {data.packageRefs && data.packageRefs.length > 0 && (
          <div
            data-testid="package-badge"
            title={data.packageRefs.join(", ")}
            className="font-mono text-[8px] text-stone-400"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            PKG {data.packageRefs.length}
          </div>
        )}

        {/* Alert state for blocked/failed startup */}
        {data.startupStatus === "attention_required" && (
          <div className="stamp-badge">
            <div className="w-2 h-2 rounded-full bg-orange-500" />
            <span className="text-orange-600">ATTN</span>
          </div>
        )}
        {data.startupStatus === "failed" && (
          <div className="stamp-badge">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-red-600">FAILED</span>
          </div>
        )}

        {(data.canonicalSessionName ?? data.binding?.tmuxSession ?? data.resumeToken ?? data.rigId) && (
          <div
            data-testid="node-toolbar"
            className="absolute right-2 top-8 z-20 flex flex-wrap justify-end gap-1 opacity-0 transition-opacity group-hover:!opacity-100 group-hover:opacity-100 group-focus-within:!opacity-100 group-focus-within:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {(data.canonicalSessionName ?? data.binding?.tmuxSession) && (
              <button
                onClick={handleCopyAttach}
                data-testid="toolbar-copy-attach"
                className={buttonClass("attach")}
                aria-label="Copy tmux attach command"
                title={`tmux attach -t ${data.canonicalSessionName ?? data.binding?.tmuxSession ?? "?"}`}
              >
                <ToolMark tool="tmux" size="xs" />
                <span>{actionFeedback === "attach" ? "copied" : "tmux"}</span>
              </button>
            )}
            {data.rigId && (
              <button
                onClick={handleOpenCmux}
                data-testid="toolbar-cmux-open"
                className={`${buttonClass("cmux")} inline-flex h-6 w-6 items-center justify-center px-0 py-0`}
                aria-label="Open in cmux"
                title="Open in cmux"
              >
                <ToolMark tool="cmux" size="sm" />
                <span className="sr-only">{actionFeedback === "cmux" ? "opened" : "cmux"}</span>
              </button>
            )}
            {data.rigId && terminalSessionName && (
              <TerminalPreviewPopover
                rigId={data.rigId}
                logicalId={data.logicalId}
                sessionName={terminalSessionName}
                reducedMotion={data.reducedMotion}
                testIdPrefix={`rig-node-${data.logicalId}`}
                buttonClassName={toolbarIconButtonClass}
              />
            )}
            {data.resumeToken && data.runtime && data.runtime !== "terminal" && (
              <button
                onClick={handleCopyResume}
                data-testid="toolbar-copy-resume"
                className={buttonClass("resume")}
              >
                {actionFeedback === "resume" ? "copied" : "resume"}
              </button>
            )}
          </div>
        )}

        {placementChipLabel && (
          <div className="pt-1">
            <span
              data-testid={`placement-chip-${data.logicalId}`}
              className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-[0.12em] ${
                data.placementState === "selected"
                  ? "border-emerald-700 bg-emerald-700 text-white"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800"
              }`}
            >
              {placementChipLabel}
            </span>
          </div>
        )}
      </div>

      {hoverHintLines.length > 0 && (
        <div
          data-testid="node-hover-hint"
          className="pointer-events-none absolute left-2 top-full z-20 mt-2 hidden min-w-[180px] border border-stone-900 bg-white px-2 py-1 font-mono text-[8px] text-stone-700 shadow-[4px_4px_0_rgba(28,25,23,0.14)] group-hover:block"
        >
          {hoverHintLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
  return (
    <ActivityRing
      state={data.activityRing?.state ?? "idle"}
      flash={data.activityRing?.flash ?? null}
      reducedMotion={data.reducedMotion}
      testId={`rig-node-activity-ring-${data.logicalId}`}
      className="rounded-none"
    >
      {card}
    </ActivityRing>
  );
}
