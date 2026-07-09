import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { displayAgentName, inferPodName } from "../../lib/display-name.js";
import {
  getActivityAnimationClass,
  getActivityBgClass,
  getActivityLabel,
  getActivityStateWithSource,
  isActivityStale,
  getTimeInState,
} from "../../lib/activity-visuals.js";
import type { AgentActivitySummary, SeatIdentityVerdictSummary } from "../../hooks/useNodeInventory.js";
import { cn } from "../../lib/utils.js";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { ActivityRing } from "./ActivityRing.js";
import { getActivityCardClasses, getActivityCardSignal } from "./activity-card-visuals.js";
import { TerminalPreviewPopover } from "./TerminalPreviewPopover.js";
import type { TopologyActivityVisual } from "../../lib/topology-activity.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { formatRuntimeModel } from "../../lib/runtime-brand.js";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";

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
  terminalActive?: boolean | null;
  // OPR.0.4.3.19 — liveness identity verdict; mismatch/pane_missing overrides
  // terminalActive so the dot never renders active/running green.
  identityVerdict?: SeatIdentityVerdictSummary | null;
  currentQitems?: unknown[];
  rigId?: string | null;
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
}

function isCoreRole(role: string | null | undefined): boolean {
  return role === "architect" || role === "lead" || role === "orchestrator";
}

function contextClass(percent: number | null | undefined, fresh: boolean | undefined): string {
  if (typeof percent !== "number") return "text-on-surface-variant";
  const tone = percent >= 80
    ? "text-red-600"
    : percent >= 60
      ? "text-amber-600"
      : "text-green-700";
  return fresh === false ? `${tone} opacity-50` : tone;
}

function HybridPodGroupNodeInner({ data }: { data: HybridPodGroupNodeData }) {
  const label = data.podDisplayName
    ?? data.podNamespace
    ?? inferPodName(data.logicalId ?? null)
    ?? data.podId
    ?? "pod";
  return (
    <div
      data-testid="hybrid-pod-group-node"
      className="relative h-full w-full border border-dashed border-outline/55 bg-background/25"
    >
      <div className="absolute left-2 top-2 flex items-center gap-2 font-mono text-[9px] lowercase tracking-[0.02em] text-on-surface-variant">
        <span>{label}</span>
        {typeof data.agentCount === "number" ? (
          <span className="text-on-surface-variant">{data.agentCount}</span>
        ) : null}
      </div>
      <Handle type="target" position={Position.Left} className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Right} className="opacity-0 pointer-events-none" />
    </div>
  );
}

/** V0.3.1 bug-fix slice topology-perf — graph CPU win. Pod-group node
 *  content depends only on label fields + agent count; data reference
 *  churns on every topology-activity bump but the visible content
 *  doesn't. Memoize on the fields the renderer reads. */
export const HybridPodGroupNode = memo(
  HybridPodGroupNodeInner,
  (prev, next) => {
    const a = prev.data;
    const b = next.data;
    return (
      a.podDisplayName === b.podDisplayName &&
      a.podNamespace === b.podNamespace &&
      a.podId === b.podId &&
      a.logicalId === b.logicalId &&
      a.agentCount === b.agentCount
    );
  },
);
HybridPodGroupNode.displayName = "HybridPodGroupNode";

function HybridAgentNodeInner({ data }: { data: HybridAgentNodeData }) {
  // OPR.0.4.6.MH2 rev1-r2 B1 — terminal preview + cmux-open are LOCAL
  // affordances (local session reads / bare local POST); gated off when a
  // remote host's data is on the canvas (FR-7 read-only remote views).
  const nodeIsRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  const cmuxLaunch = useCmuxLaunch();
  const core = isCoreRole(data.role);
  const isInfra = data.nodeKind === "infrastructure";
  const { state: activityState, source: activitySource } = getActivityStateWithSource(data.agentActivity, data.terminalActive, data.identityVerdict);
  const activityLabel = getActivityLabel(activityState);
  const activityBgClass = getActivityBgClass(activityState);
  const activityAnimClass = getActivityAnimationClass(activityState);
  const activityStale = isActivityStale(data.agentActivity);
  const timeInState = getTimeInState(data.agentActivity);
  const activityCard = getActivityCardSignal({ activityRing: data.activityRing, activityState });
  const runtimeTitle = data.runtime || data.model ? formatRuntimeModel(data.runtime, data.model) : null;
  const contextKnown = data.contextAvailability === "known" && typeof data.contextUsedPercentage === "number";
  const tokenTotal = sumTokenCounts(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const tokenLabel = formatCompactTokenCount(tokenTotal);
  const tokenTitle = formatTokenTotalTitle(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const hoverIconClass = "inline-flex h-6 w-6 items-center justify-center border border-outline-variant bg-surface-lowest/90 text-on-surface opacity-0 shadow-[1px_1px_0_rgba(46,52,46,0.14)] transition-opacity hover:bg-surface-low hover:text-on-surface focus:!opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-on-surface/20 group-hover:!opacity-100 group-hover:opacity-100 group-focus-within:!opacity-100 group-focus-within:opacity-100";

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
        "group relative h-full w-full select-none border bg-surface-lowest/40 backdrop-blur-[8px] hard-shadow transition-[background-color,border-color,box-shadow] duration-300",
        getActivityCardClasses({
          state: activityCard.state,
          flash: activityCard.flash,
          reducedMotion: data.reducedMotion,
        }),
        data.startupStatus === "failed"
          ? "border-red-700"
          : data.startupStatus === "attention_required"
            ? "border-amber-700"
            : "border-on-surface",
      )}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div
        className={cn(
          "flex items-center justify-between gap-1 px-2 py-1 font-mono text-[8px]",
          isInfra
            ? "bg-outline text-white border-b border-on-surface"
            : core
              ? "bg-inverse-surface text-background"
              : "border-b border-on-surface bg-surface-high text-on-surface",
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
          data-activity-source={activitySource}
          aria-label={`activity: ${activityLabel}${timeInState ? ` ${timeInState.label}` : ""}${activitySource !== "hook" && activitySource !== "none" ? " (activity-grade)" : ""}`}
        />
      </div>
      {data.rigId && !nodeIsRemote ? (
        <TerminalPreviewPopover
          rigId={data.rigId}
          logicalId={data.logicalId}
          sessionName={data.canonicalSessionName ?? null}
          reducedMotion={data.reducedMotion}
          testIdPrefix={`hybrid-${data.logicalId}`}
          wrapperClassName="absolute right-8 top-6 z-20"
          buttonClassName={hoverIconClass}
          progressive
        />
      ) : null}
      {data.rigId && !nodeIsRemote ? (
        <>
        <button
          type="button"
          data-testid={`hybrid-cmux-open-${data.logicalId}`}
          aria-busy={cmuxLaunch.isPending || undefined}
          aria-label={
            cmuxLaunch.isPending
              ? `Opening ${data.logicalId} in cmux`
              : cmuxLaunch.isError
                ? `Open ${data.logicalId} in cmux failed: ${cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error)}. Click to retry.`
                : `Open ${data.logicalId} in cmux`
          }
          title={
            cmuxLaunch.isPending
              ? "Opening in cmux"
              : cmuxLaunch.isError
                ? `Failed: ${cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error)} — click to retry`
                : "Open in cmux"
          }
          disabled={cmuxLaunch.isPending || !data.logicalId}
          data-error={cmuxLaunch.isError || undefined}
          onClick={(event) => {
            event.stopPropagation();
            // OPR.0.4.1.31 part D (rev1-r2) — symmetric to the table guard: never
            // POST open-cmux for a malformed node (a null/empty logicalId would
            // build /nodes/"null"/open-cmux). The button is also disabled above.
            if (!data.logicalId) return;
            // part B — reset a prior error then retry; the failure is no longer
            // silent (data-error + title/aria carry the message).
            if (cmuxLaunch.isError) cmuxLaunch.reset();
            cmuxLaunch.mutate({ rigId: data.rigId!, logicalId: data.logicalId });
          }}
          className={cn("absolute right-1.5 top-6 z-10 disabled:cursor-wait disabled:opacity-60", cmuxLaunch.isError ? "text-rose-700" : "", hoverIconClass)}
        >
          <ToolMark tool="cmux" size="sm" />
        </button>
        {cmuxLaunch.isError ? (
          // OPR.0.4.1.31 B2 (dev1-guard) — a stable, VISIBLE error message (not
          // just title/aria/color): a persistent role=alert chip near the button
          // carrying the daemon message so a failed open-cmux is readable, not a
          // dead-looking button.
          <span
            data-testid={`hybrid-cmux-error-${data.logicalId}`}
            role="alert"
            className="absolute right-1.5 top-14 z-20 max-w-[180px] border border-rose-300 bg-rose-50 px-1.5 py-1 font-mono text-[8px] leading-tight text-rose-700 whitespace-normal break-words shadow-sm"
          >
            {cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error)}
          </span>
        ) : null}
        </>
      ) : null}
      <div className="space-y-1 px-2 py-1.5">
        <div className="truncate font-mono text-[8px] leading-tight text-on-surface-variant">
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
            <span className="ml-1 font-mono text-[7px] uppercase tracking-[0.12em] text-on-surface-variant">
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
              tokenLabel ? "text-on-surface-variant" : "text-on-surface-variant",
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

/** V0.3.1 bug-fix slice topology-perf — graph CPU win.
 *
 * HybridAgentNode is the per-seat card on the workspace topology graph.
 * Its `data` prop reference changes on every `useTopologyActivity` bump
 * (1s interval + per-stream-event in HostMultiRigGraph.activeNodes) but
 * most fields are stable across bumps for any given seat. Without
 * memoization we re-render the full card — including `useCmuxLaunch`,
 * `TerminalPreviewPopover`, multiple format calls, ActivityRing — on
 * every tick for every visible seat. Slice 12.5 made this acute by
 * mounting the graph at workspace scope (many rigs × many seats).
 *
 * Custom equality compares all fields the renderer reads (visible
 * content + activity-ring shape + flash). The `currentQitems` array is
 * compared by length (sufficient signal; deep-equal would re-introduce
 * work). */
export const HybridAgentNode = memo(HybridAgentNodeInner, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  return (
    a.logicalId === b.logicalId &&
    a.role === b.role &&
    a.runtime === b.runtime &&
    a.model === b.model &&
    a.status === b.status &&
    a.nodeKind === b.nodeKind &&
    a.startupStatus === b.startupStatus &&
    a.canonicalSessionName === b.canonicalSessionName &&
    a.resolvedSpecName === b.resolvedSpecName &&
    a.profile === b.profile &&
    a.contextUsedPercentage === b.contextUsedPercentage &&
    a.contextFresh === b.contextFresh &&
    a.contextAvailability === b.contextAvailability &&
    a.contextTotalInputTokens === b.contextTotalInputTokens &&
    a.contextTotalOutputTokens === b.contextTotalOutputTokens &&
    a.agentActivity === b.agentActivity &&
    (a.currentQitems?.length ?? 0) === (b.currentQitems?.length ?? 0) &&
    a.rigId === b.rigId &&
    a.activityRing?.state === b.activityRing?.state &&
    a.activityRing?.flash === b.activityRing?.flash &&
    a.reducedMotion === b.reducedMotion
  );
});
HybridAgentNode.displayName = "HybridAgentNode";
