import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useRigSummary, type RigSummary } from "../hooks/useRigSummary.js";
import { usePsEntries, type PsEntry } from "../hooks/usePsEntries.js";
import { useNodeInventory, type NodeInventoryEntry } from "../hooks/useNodeInventory.js";
import { cn } from "../lib/utils.js";

import type { DrawerSelection } from "./SharedDetailDrawer.js";

interface ExplorerProps {
  open: boolean;
  onClose: () => void;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
}

function statusColor(startupStatus: string | null): string {
  switch (startupStatus) {
    case "ready": return "bg-green-500";
    case "pending": return "bg-amber-400";
    case "failed": return "bg-red-500";
    default: return "bg-stone-400";
  }
}

function rigStatusColor(status: string): string {
  switch (status) {
    case "running": return "bg-green-500";
    case "partial": return "bg-amber-400";
    case "stopped": return "bg-stone-400";
    default: return "bg-stone-400";
  }
}

function RigTree({ rig, ps, selection, onSelect, onClose }: {
  rig: RigSummary;
  ps: PsEntry | undefined;
  selection: ExplorerProps["selection"];
  onSelect: ExplorerProps["onSelect"];
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rigStatus = ps?.status ?? "stopped";

  return (
    <div data-testid={`rig-tree-${rig.name}`}>
      {/* Rig header */}
      <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-stone-200 cursor-pointer group">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-stone-400 w-3"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className={cn("w-2 h-2 rounded-full shrink-0", rigStatusColor(rigStatus))} />
        <Link
          to="/rigs/$rigId"
          params={{ rigId: rig.id }}
          onClick={() => {
            onSelect({ type: "rig", rigId: rig.id });
            onClose();
          }}
          className="font-mono text-xs font-bold text-stone-900 truncate flex-1"
        >
          {rig.name}
        </Link>
        <span className="font-mono text-[9px] text-stone-400 uppercase hidden group-hover:inline">
          {rigStatus}
        </span>
      </div>

      {/* Expanded: node inventory */}
      {expanded && (
        <RigNodes
          rigId={rig.id}
          rigStatus={rigStatus}
          selection={selection}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

function RigNodes({ rigId, rigStatus, selection, onSelect }: {
  rigId: string;
  rigStatus: string;
  selection: ExplorerProps["selection"];
  onSelect: ExplorerProps["onSelect"];
}) {
  const { data: nodes, isLoading } = useNodeInventory(rigId);

  if (isLoading) return <div className="px-8 py-1 font-mono text-[9px] text-stone-400">Loading...</div>;
  if (!nodes || nodes.length === 0) return <div className="px-8 py-1 font-mono text-[9px] text-stone-400">No nodes</div>;

  // Group by podId
  const pods = new Map<string, NodeInventoryEntry[]>();
  for (const node of nodes) {
    const key = node.podId ?? "__ungrouped__";
    if (!pods.has(key)) pods.set(key, []);
    pods.get(key)!.push(node);
  }

  // Turn On / Turn Off buttons
  const actionButton = rigStatus === "stopped" ? (
    <button
      onClick={async () => {
        try { await fetch(`/api/rigs/${encodeURIComponent(rigId)}/up`, { method: "POST" }); } catch { /* best-effort */ }
      }}
      className="mx-8 my-1 px-2 py-0.5 font-mono text-[8px] border border-stone-300 hover:bg-stone-200 uppercase"
      data-testid="turn-on"
    >
      Turn On
    </button>
  ) : rigStatus === "running" || rigStatus === "partial" ? (
    <button
      onClick={async () => {
        try { await fetch("/api/down", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rigId }) }); } catch { /* best-effort */ }
      }}
      className="mx-8 my-1 px-2 py-0.5 font-mono text-[8px] border border-stone-300 hover:bg-stone-200 uppercase"
      data-testid="turn-off"
    >
      Turn Off
    </button>
  ) : null;

  return (
    <div className="ml-3 border-l border-stone-200">
      {[...pods.entries()].map(([podId, podNodes]) => (
        <div key={podId}>
          {podId !== "__ungrouped__" && (
            <div className="px-5 py-0.5 font-mono text-[9px] text-stone-500 uppercase tracking-wider">
              {podId}
            </div>
          )}
          {podNodes.map((node) => {
            const isSelected = selection?.type === "node" && selection.rigId === node.rigId && selection.logicalId === node.logicalId;
            const memberName = node.logicalId.includes(".") ? node.logicalId.split(".").slice(1).join(".") : node.logicalId;

            return (
              <button
                key={node.logicalId}
                onClick={() => onSelect({ type: "node", rigId: node.rigId, logicalId: node.logicalId })}
                data-testid={`node-${node.logicalId}`}
                className={cn(
                  "flex items-center gap-2 w-full px-7 py-1 text-left hover:bg-stone-100 transition-colors",
                  isSelected && "bg-stone-200 border-l-2 border-l-stone-900",
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusColor(node.startupStatus))} />
                <span className="font-mono text-[10px] text-stone-700 truncate">{memberName}</span>
                <span className="font-mono text-[8px] text-stone-400 ml-auto shrink-0">
                  {node.nodeKind === "infrastructure" ? "INFRA" : (node.runtime ?? "").replace("claude-code", "claude")}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      {actionButton}
    </div>
  );
}

export function Explorer({ open, onClose, selection, onSelect }: ExplorerProps) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const psMap = new Map((psEntries ?? []).map((e) => [e.rigId, e]));

  return (
    <aside
      data-testid="explorer"
      className={cn(
        "w-64 bg-stone-50 border-r border-stone-300 flex flex-col shrink-0 z-20 overflow-y-auto",
        "fixed top-14 bottom-0 left-0 transition-transform duration-200 ease-tactical lg:relative lg:top-0 lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full"
      )}
    >
      {/* Local environment header */}
      <div className="px-3 py-2 border-b border-stone-200">
        <span className="font-mono text-[9px] text-stone-500 tracking-widest uppercase">Local</span>
      </div>

      {/* Rig tree */}
      <div className="flex-1 py-1">
        {(!rigs || rigs.length === 0) ? (
          <div className="px-3 py-4 font-mono text-[10px] text-stone-400 text-center">No rigs</div>
        ) : (
          rigs.map((rig) => (
            <RigTree
              key={rig.id}
              rig={rig}
              ps={psMap.get(rig.id)}
              selection={selection}
              onSelect={onSelect}
              onClose={onClose}
            />
          ))
        )}
      </div>

      {/* Footer actions */}
      <div className="border-t border-stone-200 p-2 flex gap-2">
        <Link to="/import" onClick={onClose} className="font-mono text-[8px] text-stone-500 hover:text-stone-900 uppercase">Import</Link>
        <Link to="/discovery" onClick={onClose} className="font-mono text-[8px] text-stone-500 hover:text-stone-900 uppercase">Discovery</Link>
      </div>
    </aside>
  );
}
