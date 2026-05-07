// V1 polish slice Phase 5.2 P5.2-4 — RigGroupNode renderer.
//
// Outermost container in the multi-rig single-canvas /topology graph.
// Each rig appears as a vellum tactical card on the canvas; click body
// to toggle collapse; click "→" affordance on the rig name to drill
// into /topology/rig/$rigId. When collapsed, only the card body shows
// (name + status pip + counts). When expanded, the card acts as a
// bounding-box container; the rig's pod groups + agent nodes render
// inside via react-flow parent/child relationship (extent='parent').
//
// Visual: 1px outline-variant border (universal-shell.md L43-L48 doctrine)
// + RegistrationMarks at 4 corners + paper-press hard-shadow + font-mono
// uppercase rig name + counts subline. Collapsed elevation reads
// coherent with paper-grid backdrop (radial-gradient on body globals.css
// L73-L74).

import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
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
  /** Click handler — owner threads through to toggle expand state. */
  onToggle: (rigId: string) => void;
}

function statusToPip(s: RigGroupNodeData["status"]): React.ComponentProps<typeof StatusPip>["status"] {
  if (s === "running") return "running";
  if (s === "stopped") return "stopped";
  return "warning"; // partial
}

export function RigGroupNode({ data }: { data: RigGroupNodeData }) {
  const { rigId, rigName, collapsed, status, nodeCount, runningCount, podCount, onToggle } = data;
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
        "w-full h-full relative flex flex-col cursor-pointer select-none",
        "border border-outline-variant bg-white/40 backdrop-blur-[8px]",
        "hard-shadow",
        // Expanded state: the card acts as a frame; children render inside
        // via react-flow parent/child positioning. The body has a softer
        // fill so child nodes (pod groups + agents) read clearly inside.
        collapsed
          ? "hover:bg-white/60"
          : "bg-white/20",
      )}
    >
      <RegistrationMarks testIdPrefix={`rig-group-${rigId}`} />
      {/* Header: rig name + drill-in Link + collapse-state chevron */}
      <header className="flex items-center justify-between gap-2 px-3 pt-3 pb-2 border-b border-outline-variant">
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
        <Link
          to="/topology/rig/$rigId"
          params={{ rigId }}
          onClick={(e) => e.stopPropagation()}
          data-testid={`rig-group-drill-${rigId}`}
          className="shrink-0 p-0.5 rounded-sm text-on-surface-variant hover:text-stone-900 hover:bg-stone-200/60"
          aria-label={`Open ${rigName} rig page`}
        >
          <span className="font-mono text-[10px] uppercase tracking-wide">→</span>
        </Link>
      </header>
      {/* Body: counts + status pip when collapsed; bounding-box frame
          (no inner content; children render via parentNode) when expanded. */}
      {collapsed ? (
        <div className="px-3 py-3 flex items-center justify-between gap-2 flex-1">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
              {podCount !== undefined ? `${podCount} pods · ` : ""}
              {nodeCount} agent{nodeCount === 1 ? "" : "s"}
            </div>
            <div className="font-mono text-[9px] text-on-surface-variant">
              {runningCount} active
            </div>
          </div>
          <StatusPip
            status={statusToPip(status)}
            label={status}
            variant="pill"
            testId={`rig-group-status-${rigId}`}
          />
        </div>
      ) : (
        // Expanded: subtle counts strip at the top of the frame; children
        // (pod groups + agents) render absolutely within the bounding box
        // via react-flow parent/child + extent='parent'.
        <div
          className="px-3 py-1 flex items-center gap-2 font-mono text-[9px] text-on-surface-variant border-b border-outline-variant/60"
          data-testid={`rig-group-expanded-counts-${rigId}`}
        >
          <span>{podCount !== undefined ? `${podCount} pods` : ""}</span>
          {podCount !== undefined ? <span>·</span> : null}
          <span>{nodeCount} agents</span>
          <span>·</span>
          <span>{runningCount} active</span>
          <StatusPip
            status={statusToPip(status)}
            variant="dot"
            className="ml-auto"
            testId={`rig-group-status-${rigId}`}
          />
        </div>
      )}
      {/* React-flow handles (invisible) — rig groups are containers, not
          edge endpoints, but handles keep react-flow's NodeRenderer happy
          for nodes inside the rig group that may have edges crossing the
          group boundary in V1.5+. */}
      <Handle type="target" position={Position.Top} className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Bottom} className="opacity-0 pointer-events-none" />
    </div>
  );
}
