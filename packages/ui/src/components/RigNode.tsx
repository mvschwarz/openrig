import { useRef, useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { getStatusColorClass } from "@/lib/status-colors";

interface RigNodeData {
  logicalId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  binding: {
    tmuxSession?: string | null;
    cmuxSurface?: string | null;
  } | null;
}

function getStatusCssColor(status: string | null): string {
  switch (status) {
    case "running": return "hsl(var(--primary))";
    case "idle": return "hsl(var(--foreground-muted))";
    case "exited": return "hsl(var(--destructive))";
    case "detached": return "hsl(var(--warning))";
    default: return "hsl(var(--foreground-muted))";
  }
}

export function RigNode({ data }: { data: RigNodeData }) {
  const statusColor = getStatusColorClass(data.status);
  const statusCssColor = getStatusCssColor(data.status);
  const prevStatusRef = useRef(data.status);
  const [statusChanged, setStatusChanged] = useState(false);

  useEffect(() => {
    if (prevStatusRef.current !== data.status && prevStatusRef.current !== null) {
      setStatusChanged(true);
      const timer = setTimeout(() => setStatusChanged(false), 600);
      prevStatusRef.current = data.status;
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = data.status;
  }, [data.status]);

  const runtimeModel = [data.runtime, data.model].filter(Boolean).join(" \u00B7 ");
  const sessionName = data.binding?.tmuxSession;
  const isRunning = data.status === "running";

  return (
    <div
      className="min-w-[220px] relative transition-all duration-150 ease-tactical card-elevated cursor-pointer"
      data-testid="rig-node"
    >
      <Handle type="target" position={Position.Top} />

      {/* Left accent bar for running nodes */}
      {isRunning && (
        <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-primary opacity-60" />
      )}

      <div className="p-spacing-4">
        {/* Header: status dot + uppercase label */}
        <div className="flex items-center gap-spacing-2 mb-spacing-2">
          <span
            data-testid={`status-dot-${data.logicalId}`}
            className={`inline-block w-2 h-2 ${statusColor} ${statusChanged ? "status-changed" : ""} ${isRunning ? "status-dot-running" : ""}`}
            style={{ "--status-color": statusCssColor } as React.CSSProperties}
          />
          <span className="text-label-lg uppercase tracking-[0.03em] text-foreground font-inter">
            {data.logicalId}
          </span>
        </div>

        {/* Runtime + model */}
        {runtimeModel && (
          <div className="text-label-md text-foreground-muted mb-spacing-1 pl-spacing-4">
            {runtimeModel}
          </div>
        )}

        {/* Session name (mono) */}
        {sessionName && (
          <div className="text-label-sm font-mono text-foreground-muted opacity-60 mb-spacing-3 pl-spacing-4">
            {sessionName}
          </div>
        )}

        {/* Recessed telemetry block */}
        <div className="inset-surface p-spacing-3 mt-spacing-2">
          <div className="grid grid-cols-[auto_1fr] gap-x-spacing-3 gap-y-spacing-1 text-label-sm">
            <span className="text-foreground-muted uppercase tracking-[0.06em] opacity-60">STATUS</span>
            <span className={`font-mono ${data.status === "running" ? "text-primary" : data.status === "exited" ? "text-destructive" : data.status === "detached" ? "text-warning" : "text-foreground-muted"}`}>
              {data.status ?? "unknown"}
            </span>
            <span className="text-foreground-muted uppercase tracking-[0.06em] opacity-60">BOUND</span>
            <span className="font-mono text-foreground-muted">
              {data.binding ? `tmux:${data.binding.tmuxSession ?? "\u2014"}` : "unbound"}
            </span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
