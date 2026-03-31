import { useRef, useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";

interface RigNodeData {
  logicalId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  packageRefs?: string[];
  nodeKind?: "agent" | "infrastructure";
  binding: {
    tmuxSession?: string | null;
    cmuxSurface?: string | null;
  } | null;
}

/** Core roles get dark header stripe, workers get light */
function isCore(role: string | null): boolean {
  return role === "architect" || role === "lead" || role === "orchestrator";
}

function getStatusLabel(status: string | null): string {
  switch (status) {
    case "running": return "ACTIVE";
    case "idle": return "IDLE";
    case "exited": return "EXITED";
    case "detached": return "DETACHED";
    default: return "UNKNOWN";
  }
}

function getStatusCssColor(status: string | null): string {
  switch (status) {
    case "running": return "hsl(var(--success))";
    case "idle": return "hsl(var(--on-surface-variant))";
    case "exited": return "hsl(var(--tertiary))";
    case "detached": return "hsl(var(--warning))";
    default: return "hsl(var(--on-surface-variant))";
  }
}

export function RigNode({ data }: { data: RigNodeData }) {
  const prevStatusRef = useRef(data.status);
  const [statusChanged, setStatusChanged] = useState(false);
  const core = isCore(data.role);
  const isInfra = data.nodeKind === "infrastructure";
  const statusCssColor = getStatusCssColor(data.status);

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

  return (
    <div
      className="bg-white border border-stone-900 min-w-[200px] hard-shadow"
      data-testid="rig-node"
    >
      <Handle type="target" position={Position.Top} />

      {/* Header stripe — dark for core, muted for infra, light for workers */}
      <div className={`px-3 py-1 font-mono text-[10px] flex justify-between items-center ${
        isInfra
          ? "bg-stone-400 text-stone-900 border-b border-stone-900"
          : core
            ? "bg-stone-900 text-white"
            : "bg-stone-200 text-stone-900 border-b border-stone-900"
      }`}>
        <span>NODE_TYPE: {isInfra ? "INFRA" : (data.role ?? "AGENT").toUpperCase()}</span>
        <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}>
          {core ? "settings" : "link"}
        </span>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        {/* Name + status badge */}
        <div className="flex justify-between items-end border-b border-stone-100 pb-2">
          <span className="font-headline font-bold text-sm tracking-tight uppercase">
            {data.logicalId}
          </span>
          <span className={`px-2 py-0.5 border font-mono text-[8px] uppercase ${
            data.status === "running"
              ? "border-stone-900 text-stone-900"
              : data.status === "exited"
                ? "border-tertiary text-tertiary"
                : "border-stone-400 text-stone-400"
          } ${statusChanged ? "status-changed" : ""}`}
            style={{ "--status-color": statusCssColor } as React.CSSProperties}
            data-testid={`status-dot-${data.logicalId}`}
          >
            {getStatusLabel(data.status)}
          </span>
        </div>

        {/* Runtime info */}
        {runtimeModel && (
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>RUNTIME</span>
            <span>{runtimeModel}</span>
          </div>
        )}

        {/* Alert state for exited/detached */}
        {(data.status === "exited" || data.status === "detached") && (
          <div className="stamp-badge">
            <div className="w-2 h-2 rounded-full bg-tertiary" />
            <span>{getStatusLabel(data.status)}</span>
          </div>
        )}

        {/* Package badge */}
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
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
