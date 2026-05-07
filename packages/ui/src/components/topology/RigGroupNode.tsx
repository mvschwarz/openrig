// V1 polish slice Phase 5.2 P5.2-4: RigGroupNode renderer.
//
// Outermost container in the multi-rig single-canvas /topology graph.
// Each rig appears as a soft vellum frame on the canvas; click body to
// toggle collapse; use the arrow affordance on the rig tab to drill into
// /topology/rig/$rigId. When collapsed, the summary card shows counts.
// When expanded, the card acts as a bounding-box container; pod groups +
// agent nodes render inside via react-flow parent/child relationship.
//
// Visual: 1px outline-variant border (universal-shell.md L43-L48 doctrine)
// + RegistrationMarks at 4 corners + font-mono uppercase rig tab.

import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Handle, Position } from "@xyflow/react";
import { RegistrationMarks } from "../ui/registration-marks.js";
import { StatusPip } from "../ui/status-pip.js";
import { cn } from "../../lib/utils.js";

export interface RigGroupNodeData {
  rigId: string;
  rigName: string;
  /** When true, body shows the summary card and children render outside.
   *  When false, body acts as a bounding-box frame; children render inside
   *  via react-flow parent/child positioning. */
  collapsed: boolean;
  status: "running" | "partial" | "stopped";
  nodeCount: number;
  runningCount: number;
  podCount?: number; // optional; populated post-graph-fetch when expanded
  recentActivity?: boolean;
  /** Click handler: owner threads through to toggle expand state. */
  onToggle: (rigId: string) => void;
}

function statusToPip(s: RigGroupNodeData["status"]): React.ComponentProps<typeof StatusPip>["status"] {
  if (s === "running") return "running";
  if (s === "stopped") return "stopped";
  return "warning"; // partial
}

export function RigGroupNode({ data }: { data: RigGroupNodeData }) {
  const { rigId, rigName, collapsed, status, nodeCount, runningCount, podCount, recentActivity, onToggle } = data;
  return (
    <div
      data-testid={`rig-group-node-${rigId}`}
      data-collapsed={collapsed ? "true" : "false"}
      onClick={(e) => {
        // Body click toggles collapse. The drill-in Link inside stops
        // propagation so its click navigates without ALSO toggling.
        e.stopPropagation();
        onToggle(rigId);
      }}
      className={cn(
        "w-full h-full relative flex flex-col cursor-pointer select-none overflow-visible",
        collapsed
          ? "border border-outline-variant bg-white/40 backdrop-blur-[8px] hard-shadow hover:bg-white/60"
          : "border border-outline-variant/70 bg-white/[0.14] backdrop-blur-[2px] shadow-[0_0_0_1px_rgba(84,96,115,0.06)]",
        recentActivity && "rig-activity-frame-pulse",
      )}
    >
      <RegistrationMarks testIdPrefix={`rig-group-${rigId}`} />
      <header className="absolute -top-8 left-4 z-10 flex items-center gap-2 border border-outline-variant/70 bg-background px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.10em] text-stone-900 shadow-[2px_2px_0_rgba(46,52,46,0.10)]">
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight
            className={cn(
              "h-3 w-3 text-on-surface-variant shrink-0 transition-transform",
              collapsed ? "" : "rotate-90",
            )}
            aria-hidden="true"
          />
          <span
            data-testid={`rig-group-name-${rigId}`}
            className="font-mono text-[11px] font-bold uppercase tracking-[0.10em] text-stone-900 truncate"
          >
            {rigName}
          </span>
        </div>
        <StatusPip
          status={statusToPip(status)}
          label={status}
          variant="pill"
          testId={`rig-group-status-${rigId}`}
        />
        <Link
          to="/topology/rig/$rigId"
          params={{ rigId }}
          onClick={(e) => e.stopPropagation()}
          data-testid={`rig-group-drill-${rigId}`}
          className="shrink-0 p-0.5 text-on-surface-variant hover:text-stone-900 hover:bg-stone-200/60"
          aria-label={`Open ${rigName} rig page`}
        >
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </header>
      {collapsed ? (
        <div className="px-3 pt-8 pb-3 flex items-center justify-between gap-2 flex-1">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
              {podCount !== undefined ? `${podCount} pods / ` : ""}
              {nodeCount} agent{nodeCount === 1 ? "" : "s"}
            </div>
            <div className="font-mono text-[9px] text-on-surface-variant">
              {runningCount} active
            </div>
          </div>
        </div>
      ) : (
        <div
          className="absolute right-3 top-3 flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500"
          data-testid={`rig-group-expanded-counts-${rigId}`}
        >
          <span>{podCount !== undefined ? `${podCount} pods` : ""}</span>
          {podCount !== undefined ? <span>/</span> : null}
          <span>{nodeCount} agents</span>
          <span>/</span>
          <span>{runningCount} active</span>
        </div>
      )}
      {/* React-flow handles (invisible): rig groups are containers, not
          edge endpoints, but handles keep react-flow's NodeRenderer happy
          for nodes inside the rig group that may have edges crossing the
          group boundary in V1.5+. */}
      <Handle type="target" position={Position.Top} className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Bottom} className="opacity-0 pointer-events-none" />
    </div>
  );
}
