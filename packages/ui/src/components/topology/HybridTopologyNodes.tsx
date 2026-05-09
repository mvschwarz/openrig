import { Handle, Position } from "@xyflow/react";
import { displayAgentName, inferPodName } from "../../lib/display-name.js";
import {
  getActivityAnimationClass,
  getActivityBgClass,
  getActivityLabel,
  getActivityState,
  isActivityStale,
} from "../../lib/activity-visuals.js";
import type { AgentActivitySummary } from "../../hooks/useNodeInventory.js";
import { cn } from "../../lib/utils.js";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { ActivityRing } from "./ActivityRing.js";
import { getActivityCardClasses, getActivityCardSignal } from "./activity-card-visuals.js";
import { TerminalPreviewPopover } from "./TerminalPreviewPopover.js";
import type { TopologyActivityVisual } from "../../lib/topology-activity.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { formatRuntimeModel } from "../../lib/runtime-brand.js";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";

interface HybridPodGroupNodeData {
  podDisplayName?: string | null;
  podNamespace?: string | null;
  podId?: string | null;
  logicalId?: string | null;
  agentCount?: number;
}

interface HybridAgentNodeData {
  logicalId: string;
  role?: string | null;
  runtime?: string | null;
  model?: string | null;
  status?: string | null;
  nodeKind?: "agent" | "infrastructure";
  startupStatus?: "pending" | "ready" | "attention_required" | "failed" | null;
  canonicalSessionName?: string | null;
  resolvedSpecName?: string | null;
  profile?: string | null;
  contextUsedPercentage?: number | null;
  contextFresh?: boolean;
  contextAvailability?: string | null;
  contextTotalInputTokens?: number | null;
  contextTotalOutputTokens?: number | null;
  agentActivity?: AgentActivitySummary | null;
  currentQitems?: unknown[];
  rigId?: string | null;
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
}

function isCoreRole(role: string | null | undefined): boolean {
  return role === "architect" || role === "lead" || role === "orchestrator";
}

function contextClass(percent: number | null | undefined, fresh: boolean | undefined): string {
  if (typeof percent !== "number") return "text-stone-300";
  const tone = percent >= 80
    ? "text-red-600"
    : percent >= 60
      ? "text-amber-600"
      : "text-green-700";
  return fresh === false ? `${tone} opacity-50` : tone;
}

export function HybridPodGroupNode({ data }: { data: HybridPodGroupNodeData }) {
  const label = data.podDisplayName
    ?? data.podNamespace
    ?? inferPodName(data.logicalId ?? null)
    ?? data.podId
    ?? "pod";
  return (
    <div
      data-testid="hybrid-pod-group-node"
      className="relative h-full w-full border border-dashed border-stone-400/55 bg-stone-50/25"
    >
      <div className="absolute left-2 top-2 flex items-center gap-2 font-mono text-[9px] lowercase tracking-[0.02em] text-stone-600">
        <span>{label}</span>
        {typeof data.agentCount === "number" ? (
          <span className="text-stone-400">{data.agentCount}</span>
        ) : null}
      </div>
      <Handle type="target" position={Position.Left} className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Right} className="opacity-0 pointer-events-none" />
    </div>
  );
}

export function HybridAgentNode({ data }: { data: HybridAgentNodeData }) {
  const cmuxLaunch = useCmuxLaunch();
  const core = isCoreRole(data.role);
  const isInfra = data.nodeKind === "infrastructure";
  const activityState = getActivityState(data.agentActivity);
  const activityLabel = getActivityLabel(activityState);
  const activityBgClass = getActivityBgClass(activityState);
  const activityAnimClass = getActivityAnimationClass(activityState);
  const activityStale = isActivityStale(data.agentActivity);
  const activityCard = getActivityCardSignal({ activityRing: data.activityRing, activityState });
  const runtimeTitle = data.runtime || data.model ? formatRuntimeModel(data.runtime, data.model) : null;
  const contextKnown = data.contextAvailability === "known" && typeof data.contextUsedPercentage === "number";
  const tokenTotal = sumTokenCounts(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const tokenLabel = formatCompactTokenCount(tokenTotal);
  const tokenTitle = formatTokenTotalTitle(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const hoverIconClass = "inline-flex h-6 w-6 items-center justify-center border border-outline-variant bg-white/90 text-stone-700 opacity-0 shadow-[1px_1px_0_rgba(46,52,46,0.14)] transition-opacity hover:bg-stone-100 hover:text-stone-950 focus:!opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-stone-900/20 group-hover:!opacity-100 group-hover:opacity-100 group-focus-within:!opacity-100 group-focus-within:opacity-100";

  const card = (
    <div
      data-testid="hybrid-agent-node"
      title={[
        data.canonicalSessionName,
        `activity: ${activityLabel}${activityStale ? " (stale)" : ""}`,
        runtimeTitle,
        tokenTitle,
      ].filter(Boolean).join("\n")}
      data-activity-card-state={activityCard.state}
      data-activity-card-flash={activityCard.flash ?? "none"}
      className={cn(
        "group relative h-full w-full select-none border bg-white/40 backdrop-blur-[8px] hard-shadow transition-[background-color,border-color,box-shadow] duration-300",
        getActivityCardClasses({
          state: activityCard.state,
          flash: activityCard.flash,
          reducedMotion: data.reducedMotion,
        }),
        data.startupStatus === "failed"
          ? "border-red-700"
          : data.startupStatus === "attention_required"
            ? "border-amber-700"
            : "border-stone-900",
      )}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div
        className={cn(
          "flex items-center justify-between gap-1 px-2 py-1 font-mono text-[8px]",
          isInfra
            ? "bg-stone-500 text-white border-b border-stone-900"
            : core
              ? "bg-stone-900 text-white"
              : "border-b border-stone-900 bg-stone-200 text-stone-900",
        )}
      >
        <span className="truncate font-bold">{displayAgentName(data.logicalId)}</span>
        <span
          className={cn(
            "inline-flex h-2 w-2 shrink-0 rounded-full border border-white/60",
            activityBgClass,
            activityAnimClass,
          )}
          data-testid={`hybrid-activity-dot-${data.logicalId}`}
          data-activity-state={activityState}
          aria-label={`activity: ${activityLabel}`}
        />
      </div>
      {data.rigId ? (
        <TerminalPreviewPopover
          rigId={data.rigId}
          logicalId={data.logicalId}
          sessionName={data.canonicalSessionName ?? null}
          reducedMotion={data.reducedMotion}
          testIdPrefix={`hybrid-${data.logicalId}`}
          wrapperClassName="absolute right-8 top-6 z-20"
          buttonClassName={hoverIconClass}
        />
      ) : null}
      {data.rigId ? (
        <button
          type="button"
          data-testid={`hybrid-cmux-open-${data.logicalId}`}
          aria-label={`Open ${data.logicalId} in cmux`}
          title="Open in cmux"
          onClick={(event) => {
            event.stopPropagation();
            cmuxLaunch.mutate({ rigId: data.rigId!, logicalId: data.logicalId });
          }}
          className={cn("absolute right-1.5 top-6 z-10", hoverIconClass)}
        >
          <ToolMark tool="cmux" size="sm" />
        </button>
      ) : null}
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
          {!runtimeTitle && (data.resolvedSpecName || data.profile) ? (
            <span className="ml-1 font-mono text-[7px] uppercase tracking-[0.12em] text-stone-400">
              {data.resolvedSpecName || data.profile}
            </span>
          ) : null}
        </div>
        <div className="flex items-end justify-between gap-2 pt-0.5">
          <div
            className={cn("font-mono text-[14px] font-bold leading-none", contextClass(data.contextUsedPercentage, data.contextFresh))}
            data-testid="hybrid-context-badge"
          >
            {contextKnown ? `${data.contextUsedPercentage}%` : "--"}
          </div>
          <div
            className={cn(
              "font-mono text-[13px] font-bold leading-none tracking-[0.02em]",
              tokenLabel ? "text-stone-500" : "text-stone-300",
            )}
            data-testid="hybrid-token-total"
            title={tokenTitle ?? "Token sample unavailable"}
          >
            {tokenLabel ?? "--"}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
  return (
    <ActivityRing
      state={data.activityRing?.state ?? "idle"}
      flash={data.activityRing?.flash ?? null}
      reducedMotion={data.reducedMotion}
      testId={`hybrid-activity-ring-${data.logicalId}`}
      className="h-full w-full rounded-none"
    >
      {card}
    </ActivityRing>
  );
}
