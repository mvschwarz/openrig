// V1 attempt-3 Phase 3 — Topology table view per topology-table-view.md + SC-25.
//
// Tanstack-backed table; row per agent across topology, scoped by URL.

import { useMemo, useState } from "react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useNodeInventory, type NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { VellumInput } from "../ui/vellum-input.js";
import { StatusPip } from "../ui/status-pip.js";
import { inferPodName } from "../../lib/display-name.js";

interface AgentRow {
  rigId: string;
  rigName: string;
  podName: string;
  logicalId: string;
  sessionName: string;
  runtime: string;
  status: string;
  startupStatus: string | null;
}

function statusToSemanticPip(s: string): "active" | "running" | "stopped" | "warning" | "error" | "info" {
  if (s === "running" || s === "ready") return "running";
  if (s === "active") return "active";
  if (s === "stopped") return "stopped";
  if (s === "attention_required" || s === "warning") return "warning";
  if (s === "failed" || s === "error") return "error";
  return "info";
}

const COLUMNS: ColumnDef<AgentRow>[] = [
  { accessorKey: "rigName", header: "Rig", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
  { accessorKey: "podName", header: "Pod", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
  { accessorKey: "logicalId", header: "Agent", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
  { accessorKey: "runtime", header: "Runtime", cell: ({ getValue }) => <span className="font-mono text-[10px] uppercase tracking-wide">{String(getValue() ?? "—")}</span> },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => (
      <StatusPip status={statusToSemanticPip(String(getValue()))} label={String(getValue())} variant="pill" />
    ),
  },
];

export function TopologyTableView({ rigIdScope }: { rigIdScope?: string }) {
  const { data: rigs } = useRigSummary();
  const scopedRigs = rigIdScope
    ? rigs?.filter((r) => r.id === rigIdScope) ?? []
    : rigs ?? [];

  // Fetch node inventories per rig in scope.
  const inventoryQueries = scopedRigs.map((r) => ({
    rigId: r.id,
    rigName: r.name,
    inv: useNodeInventory(r.id),
  }));

  const data: AgentRow[] = useMemo(() => {
    const rows: AgentRow[] = [];
    for (const q of inventoryQueries) {
      const nodes: NodeInventoryEntry[] = q.inv.data ?? [];
      for (const n of nodes) {
        rows.push({
          rigId: q.rigId,
          rigName: q.rigName,
          podName: inferPodName(n.logicalId) ?? "default",
          logicalId: n.logicalId,
          sessionName: n.canonicalSessionName ?? n.logicalId,
          runtime: (n.runtime ?? "—") as string,
          status: (n.sessionStatus ?? "unknown") as string,
          startupStatus: (n.startupStatus ?? null) as string | null,
        });
      }
    }
    return rows;
  }, [JSON.stringify(inventoryQueries.map((q) => q.inv.data ?? []))]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState("");

  const table = useReactTable({
    data,
    columns: COLUMNS,
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
          {table.getFilteredRowModel().rows.length} of {data.length}
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
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center font-mono text-xs text-on-surface-variant">
                  No agents match.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`topology-table-row-${row.original.logicalId}`}
                  className="border-b border-outline-variant last:border-b-0 hover:bg-surface-low"
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
