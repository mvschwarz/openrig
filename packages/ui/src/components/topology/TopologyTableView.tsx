// V1 attempt-3 Phase 3: Topology table view per topology-table-view.md + SC-25.
//
// Tanstack-backed table; row per agent across topology, scoped by URL.
//
// V1 attempt-3 Phase 5 P5-9 ship-gate bounce P0-1: rules-of-hooks fix.
// Previous shape used `scopedRigs.map((r) => useNodeInventory(r.id))` which
// calls hooks in a loop with variable count. When scopedRigs grew from 0
// (initial render before useRigSummary resolves) to N (after resolution),
// React detected the hook count change and threw "Cannot read properties
// of undefined (reading 'length')" downstream. This crashed /topology at
// 375x812 mobile because P5-9 mounts the table immediately at first
// render (graph view-mode degraded to table for narrow viewports) BEFORE
// rigs data is available. Switched to `useQueries` from React Query:
// single hook call regardless of array length.

import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useQueries } from "@tanstack/react-query";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import type { NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { VellumInput } from "../ui/vellum-input.js";
import { StatusPip } from "../ui/status-pip.js";
import { inferPodName } from "../../lib/display-name.js";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { useTopologyActivity } from "../../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import {
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
  type TopologyActivityVisual,
} from "../../lib/topology-activity.js";
import { ActivityRing } from "./ActivityRing.js";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";

async function fetchNodeInventory(rigId: string): Promise<NodeInventoryEntry[]> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface AgentRow {
  rigId: string;
  rigName: string;
  podName: string;
  logicalId: string;
  sessionName: string;
  runtime: string;
  status: string;
  startupStatus: string | null;
  agentActivity?: TopologyActivityBaseline["agentActivity"];
  currentQitems?: TopologyActivityBaseline["currentQitems"];
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
}

function statusToSemanticPip(s: string): "active" | "running" | "stopped" | "warning" | "error" | "info" {
  if (s === "running" || s === "ready") return "running";
  if (s === "active") return "active";
  if (s === "stopped") return "stopped";
  if (s === "attention_required" || s === "warning") return "warning";
  if (s === "failed" || s === "error") return "error";
  return "info";
}

function CmuxButton({ row }: { row: AgentRow }) {
  const cmuxLaunch = useCmuxLaunch();
  return (
    <button
      type="button"
      data-testid={`topology-table-cmux-${row.logicalId}`}
      onClick={(e) => {
        e.stopPropagation();
        cmuxLaunch.mutate({ rigId: row.rigId, logicalId: row.logicalId });
      }}
      aria-label={`Open ${row.logicalId} in cmux`}
      title="Open in cmux"
      className="inline-flex h-7 w-7 items-center justify-center border border-outline-variant bg-white/65 text-stone-700 opacity-0 shadow-[1px_1px_0_rgba(46,52,46,0.12)] transition-opacity hover:bg-stone-100 hover:text-stone-950 focus:!opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-stone-900/20 group-hover:!opacity-100 group-hover:opacity-100 group-focus-within:!opacity-100 group-focus-within:opacity-100"
    >
      <ToolMark tool="cmux" size="sm" />
      <span className="sr-only">CMUX</span>
    </button>
  );
}

function agentColumns(): ColumnDef<AgentRow>[] {
  return [
    { accessorKey: "rigName", header: "Rig", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
    { accessorKey: "podName", header: "Pod", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
    {
      accessorKey: "logicalId",
      header: "Agent",
      cell: ({ row }) => (
        <ActivityRing
          as="span"
          state={row.original.activityRing?.state ?? "idle"}
          flash={row.original.activityRing?.flash ?? null}
          reducedMotion={row.original.reducedMotion}
          testId={`topology-table-activity-ring-${row.original.logicalId}`}
          className="inline-flex rounded-sm"
          ringClassName="-inset-1"
        >
          <span className="font-mono text-xs">{row.original.logicalId}</span>
        </ActivityRing>
      ),
    },
    {
      accessorKey: "runtime",
      header: "Runtime",
      cell: ({ getValue }) => (
        <RuntimeBadge runtime={String(getValue() ?? "")} size="xs" compact variant="inline" />
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue }) => (
        <StatusPip status={statusToSemanticPip(String(getValue()))} label={String(getValue())} variant="pill" />
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => <CmuxButton row={row.original} />,
    },
  ];
}

export function TopologyTableView({ rigIdScope }: { rigIdScope?: string }) {
  // V1 polish slice Phase 5.1 P5.1-7: row click navigates to seat-scope
  // center page (parity with graph node click + Explorer tree click +
  // Topology Tree details-icon-retired contract).
  const navigate = useNavigate();
  const { data: rigs } = useRigSummary();
  const reducedMotion = usePrefersReducedMotion();
  const scopedRigs = useMemo(
    () =>
      rigIdScope
        ? rigs?.filter((r) => r.id === rigIdScope) ?? []
        : rigs ?? [],
    [rigs, rigIdScope],
  );

  // P0-1 fix: useQueries replaces the .map(useNodeInventory) loop. Single
  // hook call regardless of scopedRigs length. React's hook order stays
  // stable across renders even when rigs grows from undefined to [N].
  const inventoryResults = useQueries({
    queries: scopedRigs.map((r) => ({
      queryKey: ["rig", r.id, "nodes"] as const,
      queryFn: () => fetchNodeInventory(r.id),
    })),
  });

  const data: AgentRow[] = useMemo(() => {
    const rows: AgentRow[] = [];
    for (let i = 0; i < scopedRigs.length; i++) {
      const rig = scopedRigs[i];
      const result = inventoryResults[i];
      if (!rig || !result) continue;
      const nodes: NodeInventoryEntry[] = result.data ?? [];
      for (const n of nodes) {
        rows.push({
          rigId: rig.id,
          rigName: rig.name,
          podName: inferPodName(n.logicalId) ?? "default",
          logicalId: n.logicalId,
          sessionName: n.canonicalSessionName ?? n.logicalId,
          runtime: (n.runtime ?? "-") as string,
          status: (n.sessionStatus ?? "unknown") as string,
          startupStatus: (n.startupStatus ?? null) as string | null,
          agentActivity: n.agentActivity ?? null,
          currentQitems: n.currentQitems ?? [],
        });
      }
    }
    return rows;
  }, [scopedRigs, inventoryResults]);

  const sessionIndex = useMemo(() => buildTopologySessionIndex(data.map((row) => ({
    nodeId: `${row.rigId}::${row.logicalId}`,
    rigId: row.rigId,
    rigName: row.rigName,
    logicalId: row.logicalId,
    canonicalSessionName: row.sessionName,
    agentActivity: row.agentActivity ?? null,
    currentQitems: row.currentQitems ?? null,
    startupStatus: row.startupStatus,
  }))), [data]);
  const topologyActivity = useTopologyActivity(sessionIndex);
  const activityData = useMemo(() => data.map((row) => ({
    ...row,
    activityRing: topologyActivity.getNodeActivity(`${row.rigId}::${row.logicalId}`, row),
    reducedMotion,
  })), [data, topologyActivity, reducedMotion]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState("");
  const columns = useMemo(() => agentColumns(), []);

  const table = useReactTable({
    data: activityData,
    columns,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue ?? "").toLowerCase();
      if (!q) return true;
      const r = row.original;
      return (
        r.rigName.toLowerCase().includes(q) ||
        r.podName.toLowerCase().includes(q) ||
        r.logicalId.toLowerCase().includes(q) ||
        r.runtime.toLowerCase().includes(q)
      );
    },
  });

  return (
    <div data-testid="topology-table-view" className="space-y-3 mt-4">
      <div className="flex items-center gap-2">
        <VellumInput
          placeholder="Filter agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          testId="topology-table-search"
        />
        <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant ml-auto">
          {table.getFilteredRowModel().rows.length} of {activityData.length}
        </span>
      </div>
      <div className="border border-outline-variant overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-stone-50 border-b border-outline-variant">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant cursor-pointer select-none"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? null}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center font-mono text-xs text-on-surface-variant">
                  No agents match.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`topology-table-row-${row.original.logicalId}`}
                  onClick={() =>
                    navigate({
                      to: "/topology/seat/$rigId/$logicalId",
                      params: {
                        rigId: row.original.rigId,
                        logicalId: encodeURIComponent(row.original.logicalId),
                      },
                    })
                  }
                  className="group border-b border-outline-variant last:border-b-0 hover:bg-surface-low focus-within:bg-surface-low cursor-pointer"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
