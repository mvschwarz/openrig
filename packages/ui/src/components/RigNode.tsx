import { useRef, useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";

interface RigNodeData {
  logicalId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  packageRefs?: string[];
  binding: {
    tmuxSession?: string | null;
    cmuxSurface?: string | null;
  } | null;
}

function getStatusColor(status: string | null): string {
  switch (status) {
    case "running": return "bg-success";
    case "idle": return "bg-foreground-muted-on-dark";
    case "exited": return "bg-destructive";
    case "detached": return "bg-warning";
    default: return "bg-foreground-muted-on-dark";
  }
}

function getStatusCssColor(status: string | null): string {
  switch (status) {
    case "running": return "hsl(var(--success))";
    case "idle": return "hsl(var(--foreground-muted-on-dark))";
    case "exited": return "hsl(var(--destructive))";
    case "detached": return "hsl(var(--warning))";
    default: return "hsl(var(--foreground-muted-on-dark))";
  }
}

function getStatusTextClass(status: string | null): string {
  switch (status) {
    case "running": return "text-success";
    case "exited": return "text-destructive";
    case "detached": return "text-warning";
    default: return "text-foreground-muted-on-dark";
  }
}

export function RigNode({ data }: { data: RigNodeData }) {
  const statusColor = getStatusColor(data.status);
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
      className="card-dark min-w-[200px] cursor-pointer transition-all duration-150 ease-tactical hover:bg-surface-mid"
      data-testid="rig-node"
    >
      <Handle type="target" position={Position.Top} />

      <div className="p-spacing-3">
        {/* Header: status dot + uppercase label */}
        <div className="flex items-center gap-spacing-2 mb-spacing-2">
          <span
            data-testid={`status-dot-${data.logicalId}`}
            className={`inline-block w-2 h-2 ${statusColor} ${statusChanged ? "status-changed" : ""} ${isRunning ? "status-dot-running" : ""}`}
            style={{ "--status-color": statusCssColor } as React.CSSProperties}
          />
          <span className="text-label-lg uppercase tracking-[0.03em] text-foreground-on-dark">
            {data.logicalId}
          </span>
        </div>

        {/* Runtime + model */}
        {runtimeModel && (
          <div className="text-label-md text-foreground-muted-on-dark mb-spacing-1 pl-spacing-4">
            {runtimeModel}
          </div>
        )}

        {/* Session name */}
        {sessionName && (
          <div className="text-label-sm font-mono text-foreground-muted-on-dark/60 mb-spacing-2 pl-spacing-4">
            {sessionName}
          </div>
        )}

        {/* Telemetry block */}
        <div className="inset-dark p-spacing-2 mt-spacing-2">
          <div className="grid grid-cols-[auto_1fr] gap-x-spacing-3 gap-y-spacing-1 text-label-sm">
            <span className="text-foreground-muted-on-dark/60 uppercase tracking-[0.06em]">STATUS</span>
            <span className={`font-mono ${getStatusTextClass(data.status)}`}>
              {data.status ?? "unknown"}
            </span>
            <span className="text-foreground-muted-on-dark/60 uppercase tracking-[0.06em]">BOUND</span>
            <span className="font-mono text-foreground-muted-on-dark">
              {data.binding ? `tmux:${data.binding.tmuxSession ?? "\u2014"}` : "unbound"}
            </span>
          </div>
        </div>

        {/* Package badge — non-interactive until name->ID resolution exists */}
        {data.packageRefs && data.packageRefs.length > 0 && (
          <div
            data-testid="package-badge"
            title={data.packageRefs.join(", ")}
            className="mt-spacing-2 px-spacing-2 py-spacing-1 bg-primary/12 text-label-sm text-primary font-mono"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            PKG {data.packageRefs.length}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
