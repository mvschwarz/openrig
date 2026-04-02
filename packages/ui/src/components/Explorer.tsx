import { useEffect, useMemo, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Boxes, ChevronLeft, ChevronRight, CircleDot, Globe, Layers3, Server } from "lucide-react";
import { useRigSummary, type RigSummary } from "../hooks/useRigSummary.js";
import { usePsEntries, type PsEntry } from "../hooks/usePsEntries.js";
import { useNodeInventory, type NodeInventoryEntry } from "../hooks/useNodeInventory.js";
import { cn } from "../lib/utils.js";
import { displayAgentName, displayPodName, inferPodName } from "../lib/display-name.js";

import type { DrawerSelection } from "./SharedDetailDrawer.js";

export type ExplorerDesktopMode = "full" | "hidden";

interface ExplorerProps {
  open: boolean;
  onClose: () => void;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  desktopMode?: ExplorerDesktopMode;
  onDesktopToggle?: () => void;
}

function statusColor(startupStatus: string | null): string {
  switch (startupStatus) {
    case "ready": return "text-green-600";
    case "pending": return "text-amber-500";
    case "failed": return "text-red-600";
    default: return "text-stone-400";
  }
}

function rigStatusColor(status: string): string {
  switch (status) {
    case "running": return "text-green-600";
    case "partial": return "text-amber-500";
    case "stopped": return "text-stone-400";
    default: return "text-stone-400";
  }
}

function aggregateStatus(nodes: NodeInventoryEntry[]): "ready" | "pending" | "failed" | null {
  if (nodes.some((node) => node.startupStatus === "failed")) return "failed";
  if (nodes.some((node) => node.startupStatus === "pending")) return "pending";
  if (nodes.some((node) => node.startupStatus === "ready")) return "ready";
  return null;
}

function parseCurrentRigId(pathname: string): string | null {
  const match = pathname.match(/^\/rigs\/([^/]+)/);
  return match?.[1] ?? null;
}

function TreeToggle({
  expanded,
  label,
  onClick,
}: {
  expanded: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      className="inline-flex h-5 w-5 items-center justify-center text-stone-500 transition-colors hover:text-stone-900"
    >
      <ChevronRight className={cn("h-4 w-4 transition-transform duration-150", expanded && "rotate-90")} />
    </button>
  );
}

function ExplorerKindIcon({
  kind,
  statusClass,
  testId,
}: {
  kind: "environment" | "rig" | "pod" | "agent" | "infrastructure";
  statusClass: string;
  testId?: string;
}) {
  const sizeClass = kind === "rig" ? "h-3.5 w-3.5" : "h-2.5 w-2.5";
  const sharedProps = {
    "data-testid": testId,
    className: cn(sizeClass, "shrink-0", statusClass),
    strokeWidth: 1.8,
  };

  switch (kind) {
    case "environment":
      return <Globe {...sharedProps} />;
    case "rig":
      return <Boxes {...sharedProps} />;
    case "pod":
      return <Layers3 {...sharedProps} />;
    case "infrastructure":
      return <Server {...sharedProps} />;
    default:
      return <CircleDot {...sharedProps} />;
  }
}

function PodBranch({
  podId,
  nodes,
  selection,
  onSelect,
  autoExpand,
}: {
  podId: string;
  nodes: NodeInventoryEntry[];
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  autoExpand: boolean;
}) {
  const [expanded, setExpanded] = useState(autoExpand);
  const podName = inferPodName(nodes[0]?.logicalId) ?? displayPodName(podId);
  const podStatus = aggregateStatus(nodes);

  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);

  const sortedNodes = [...nodes].sort((a, b) => displayAgentName(a.logicalId).localeCompare(displayAgentName(b.logicalId)));

  return (
    <div data-testid={`pod-branch-${podName}`}>
      <div
        className="flex cursor-pointer items-center gap-2 rounded-sm px-4 py-1.5 hover:bg-stone-100"
        onClick={() => setExpanded((value) => !value)}
      >
        <TreeToggle expanded={expanded} label={`pod ${podName}`} onClick={() => setExpanded((value) => !value)} />
        <ExplorerKindIcon kind="pod" statusClass={statusColor(podStatus)} testId={`pod-icon-${podName}`} />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-600">
          {podName}
        </span>
      </div>

      {expanded && (
        <div className="ml-4 border-l border-stone-200">
          {sortedNodes.map((node) => {
            const isSelected = selection?.type === "node" && selection.rigId === node.rigId && selection.logicalId === node.logicalId;
            const memberName = displayAgentName(node.logicalId);

            return (
              <button
                key={node.logicalId}
                type="button"
                onClick={() => onSelect({ type: "node", rigId: node.rigId, logicalId: node.logicalId })}
                data-testid={`node-${node.logicalId}`}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-4 py-1.5 text-left transition-colors hover:bg-stone-100",
                  isSelected && "bg-stone-200/80"
                )}
              >
                <ExplorerKindIcon
                  kind={node.nodeKind === "infrastructure" ? "infrastructure" : "agent"}
                  statusClass={statusColor(node.startupStatus)}
                  testId={`node-icon-${node.logicalId}`}
                />
                <span className="font-mono text-[10px] text-stone-700 truncate">{memberName}</span>
                <span className="ml-auto shrink-0 font-mono text-[8px] uppercase text-stone-400">
                  {node.nodeKind === "infrastructure" ? "INFRA" : (node.runtime ?? "").replace("claude-code", "claude")}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RigBranch({
  rig,
  ps,
  selection,
  onSelect,
  onClose,
  autoExpand,
}: {
  rig: RigSummary;
  ps: PsEntry | undefined;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  onClose: () => void;
  autoExpand: boolean;
}) {
  const [expanded, setExpanded] = useState(autoExpand);
  const rigStatus = ps?.status ?? "stopped";
  const { data: nodes, isLoading } = useNodeInventory(expanded ? rig.id : null);
  const isSelected = selection?.type === "rig" && selection.rigId === rig.id;

  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);

  const podEntries = useMemo(() => {
    if (!nodes || nodes.length === 0) return [];
    const pods = new Map<string, NodeInventoryEntry[]>();
    for (const node of nodes) {
      const key = node.podId ?? "__ungrouped__";
      if (!pods.has(key)) pods.set(key, []);
      pods.get(key)!.push(node);
    }

    return [...pods.entries()].sort(([leftId, leftNodes], [rightId, rightNodes]) => {
      const leftName = leftId === "__ungrouped__" ? "ungrouped" : (inferPodName(leftNodes[0]?.logicalId) ?? displayPodName(leftId));
      const rightName = rightId === "__ungrouped__" ? "ungrouped" : (inferPodName(rightNodes[0]?.logicalId) ?? displayPodName(rightId));
      return leftName.localeCompare(rightName);
    });
  }, [nodes]);

  return (
    <div data-testid={`rig-tree-${rig.name}`}>
      <div
        className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-4 py-1.5 hover:bg-stone-100", isSelected && "bg-stone-200/70")}
        onClick={() => setExpanded((value) => !value)}
      >
        <TreeToggle expanded={expanded} label={`rig ${rig.name}`} onClick={() => setExpanded((value) => !value)} />
        <ExplorerKindIcon kind="rig" statusClass={rigStatusColor(rigStatus)} testId={`rig-icon-${rig.name}`} />
        <Link
          to="/rigs/$rigId"
          params={{ rigId: rig.id }}
          onClick={() => {
            if (selection?.type !== "discovery") {
              onSelect({ type: "rig", rigId: rig.id });
            }
            onClose();
          }}
          className={cn(
            "flex-1 truncate font-mono text-[11px] font-semibold text-stone-900",
            isSelected && "underline underline-offset-2"
          )}
        >
          {rig.name}
        </Link>
      </div>

      {expanded && (
        <div className="ml-4 border-l border-stone-200">
          {isLoading && (
            <div className="px-4 py-1.5 font-mono text-[9px] text-stone-400">Loading...</div>
          )}
          {!isLoading && podEntries.length === 0 && (
            <div className="px-4 py-1.5 font-mono text-[9px] text-stone-400">No nodes</div>
          )}
          {podEntries.map(([podId, podNodes]) => (
            podId === "__ungrouped__" ? (
              <div key={podId}>
                {podNodes.map((node) => {
                  const isNodeSelected = selection?.type === "node" && selection.rigId === node.rigId && selection.logicalId === node.logicalId;
                  const memberName = displayAgentName(node.logicalId);

                  return (
                    <button
                    key={node.logicalId}
                    type="button"
                    onClick={() => onSelect({ type: "node", rigId: node.rigId, logicalId: node.logicalId })}
                    data-testid={`node-${node.logicalId}`}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-4 py-1.5 text-left transition-colors hover:bg-stone-100",
                        isNodeSelected && "bg-stone-200/80"
                      )}
                    >
                      <ExplorerKindIcon
                        kind={node.nodeKind === "infrastructure" ? "infrastructure" : "agent"}
                        statusClass={statusColor(node.startupStatus)}
                        testId={`node-icon-${node.logicalId}`}
                      />
                      <span className="font-mono text-[10px] text-stone-700 truncate">{memberName}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <PodBranch
                key={podId}
                podId={podId}
                nodes={podNodes}
                selection={selection}
                onSelect={onSelect}
                autoExpand={
                  expanded || (
                    selection?.type === "node" &&
                    selection.rigId === rig.id &&
                    podNodes.some((node) => node.logicalId === selection.logicalId)
                  )
                }
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

function EnvironmentBranch({
  rigs,
  psMap,
  selection,
  onSelect,
  onClose,
  currentRigId,
}: {
  rigs: RigSummary[] | undefined;
  psMap: Map<string, PsEntry>;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  onClose: () => void;
  currentRigId: string | null;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div data-testid="environment-branch-local">
      <div
        className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-1.5 hover:bg-stone-100"
        onClick={() => setExpanded((value) => !value)}
      >
        <TreeToggle
          expanded={expanded}
          label="environment Local"
          onClick={() => setExpanded((value) => !value)}
        />
        <ExplorerKindIcon kind="environment" statusClass="text-stone-500" testId="environment-icon-local" />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-700">
          env: local
        </span>
      </div>

      {expanded && (
        <div className="ml-4 border-l border-stone-200">
          {!rigs || rigs.length === 0 ? (
            <div className="px-4 py-3 font-mono text-[10px] text-stone-400">No rigs</div>
          ) : (
            rigs.map((rig, index) => (
              <RigBranch
                key={rig.id}
                rig={rig}
                ps={psMap.get(rig.id)}
                selection={selection}
                onSelect={onSelect}
                onClose={onClose}
                autoExpand={rig.id === currentRigId}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FullExplorerContents({
  rigs,
  psMap,
  selection,
  onSelect,
  onClose,
  currentRigId,
}: {
  rigs: RigSummary[] | undefined;
  psMap: Map<string, PsEntry>;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  onClose: () => void;
  currentRigId: string | null;
}) {
  return (
    <>
      <div className="flex-1 overflow-y-auto py-2">
        <EnvironmentBranch
          rigs={rigs}
          psMap={psMap}
          selection={selection}
          onSelect={onSelect}
          onClose={onClose}
          currentRigId={currentRigId}
        />
      </div>
    </>
  );
}

export function Explorer({
  open,
  onClose,
  selection,
  onSelect,
  desktopMode = "full",
  onDesktopToggle = () => {},
}: ExplorerProps) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const currentRigId = parseCurrentRigId(currentPath);
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const psMap = new Map((psEntries ?? []).map((entry) => [entry.rigId, entry]));

  return (
    <aside
      data-testid="explorer"
      className={cn(
        "border-r border-stone-300/25 flex z-20 overflow-hidden",
        "bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[6px_0_14px_rgba(46,52,46,0.04)]",
        "fixed top-14 bottom-0 left-0 transition-transform duration-200 ease-tactical w-72 max-w-[80vw]",
        open ? "translate-x-0" : "-translate-x-full",
        desktopMode === "full" && "lg:absolute lg:top-0 lg:bottom-0 lg:left-0 lg:w-72 lg:max-w-none lg:translate-x-0",
        desktopMode === "hidden" && "lg:absolute lg:top-0 lg:bottom-0 lg:left-0 lg:w-12 lg:max-w-none lg:translate-x-0"
      )}
    >
      <div className="relative flex h-full w-full flex-col">
        <button
          type="button"
          data-testid="explorer-edge-toggle"
          aria-label={desktopMode === "full" ? "Collapse explorer" : "Expand explorer"}
          onClick={onDesktopToggle}
          className={cn(
            "hidden lg:flex absolute z-10 h-8 w-8 items-center justify-center rounded-full border border-stone-300 bg-background/90 text-stone-700",
            "shadow-[0_2px_8px_rgba(41,37,36,0.08)] backdrop-blur-sm transition-colors hover:bg-stone-100 hover:text-stone-900",
            desktopMode === "full" ? "right-2 top-3" : "left-1/2 top-3 -translate-x-1/2"
          )}
        >
          {desktopMode === "full" ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {desktopMode === "full" ? (
          <FullExplorerContents
            rigs={rigs}
            psMap={psMap}
            selection={selection}
            onSelect={onSelect}
            onClose={onClose}
            currentRigId={currentRigId}
          />
        ) : (
          <div className="hidden h-full w-full lg:block" />
        )}
      </div>
    </aside>
  );
}
