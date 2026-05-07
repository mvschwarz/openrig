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
  agentActivity?: AgentActivitySummary | null;
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
      className="relative h-full w-full border border-dashed border-stone-400/55 bg-stone-50/35"
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
  const core = isCoreRole(data.role);
  const isInfra = data.nodeKind === "infrastructure";
  const activityState = getActivityState(data.agentActivity);
  const activityLabel = getActivityLabel(activityState);
  const activityBgClass = getActivityBgClass(activityState);
  const activityAnimClass = getActivityAnimationClass(activityState);
  const activityStale = isActivityStale(data.agentActivity);
  const runtimeModel = [data.runtime, data.model].filter(Boolean).join(" / ");
  const contextKnown = data.contextAvailability === "known" && typeof data.contextUsedPercentage === "number";

  return (
    <div
      data-testid="hybrid-agent-node"
      title={[
        data.canonicalSessionName,
        `activity: ${activityLabel}${activityStale ? " (stale)" : ""}`,
        runtimeModel || null,
      ].filter(Boolean).join("\n")}
      className={cn(
        "group relative h-full w-full select-none border bg-white hard-shadow",
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
      <div className="space-y-1 px-2 py-1.5">
        <div className="truncate font-mono text-[7px] text-stone-500">
          {data.canonicalSessionName ?? data.logicalId}
        </div>
        <div className="truncate font-mono text-[7px] uppercase tracking-[0.08em] text-stone-400">
          {runtimeModel || data.resolvedSpecName || data.profile || "runtime unknown"}
        </div>
        <div className={cn("font-mono text-[12px] font-bold leading-none", contextClass(data.contextUsedPercentage, data.contextFresh))}>
          {contextKnown ? `${data.contextUsedPercentage}%` : "--"}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}
