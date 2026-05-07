// V1 attempt-3 Phase 3 — Topology table view per topology-table-view.md + SC-25.
//
// Tanstack-backed table; row per agent across topology, scoped by URL.
//
// V1 attempt-3 Phase 5 P5-9 ship-gate bounce P0-1: rules-of-hooks fix.
// Previous shape used `scopedRigs.map((r) => useNodeInventory(r.id))` which
// calls hooks in a loop with variable count — when scopedRigs grew from 0
// (initial render before useRigSummary resolves) to N (after resolution),
// React detected the hook count change and threw "Cannot read properties
// of undefined (reading 'length')" downstream. This crashed /topology at
// 375x812 mobile because P5-9 mounts the table immediately at first
// render (graph view-mode degraded to table for narrow viewports) BEFORE
// rigs data is available. Switched to `useQueries` from React Query —
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
}

function statusToSemanticPip(s: string): "active" | "running" | "stopped" | "warning" | "error" | "info" {
  if (s === "running" || s === "ready") return "running";
  if (s === "active") return "active";
  if (s === "stopped") return "stopped";
  if (s === "attention_required" || s === "warning") return "warning";
  if (s === "failed" || s === "error") return "error";
  return "info";
}

// V1 polish slice Phase 5.1 P5.1-7: actions column with per-row cmux
// button. Cell stops click propagation so the row's navigate handler
// doesn't also fire (cmux button is the explicit action; row click is
// the implicit "open detail" navigation per row-click contract).
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
      className="px-2 py-1 border border-outline-variant bg-white/30 font-mono text-[9px] uppercase tracking-wide text-stone-700 hover:bg-stone-100/60 hover:text-stone-900"
    >
      CMUX
    </button>
  );
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
  // V1 polish slice Phase 5.1 P5.1-7: actions column with cmux launcher
  // per-row (founder-noted topology-table-view.md L54 column).
  {
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: ({ row }) => <CmuxButton row={row.original} />,
  },
];

export function TopologyTableView({ rigIdScope }: { rigIdScope?: string }) {
  // V1 polish slice Phase 5.1 P5.1-7: row click navigates to seat-scope
  // center page (parity with graph node click + Explorer tree click +
  // Topology Tree details-icon-retired contract).
  const navigate = useNavigate();
  const { data: rigs } = useRigSummary();
  const scopedRigs = useMemo(
    () =>
      rigIdScope
        ? rigs?.filter((r) => r.id === rigIdScope) ?? []
        : rigs ?? [],
    [rigs, rigIdScope],
  );

  // P0-1 fix: useQueries replaces the .map(useNodeInventory) loop. Single
  // hook call regardless of scopedRigs length — React's hook order stays
  // stable across renders even when rigs grows from undefined → [N].
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
          runtime: (n.runtime ?? "—") as string,
          status: (n.sessionStatus ?? "unknown") as string,
          startupStatus: (n.startupStatus ?? null) as string | null,
        });
      }
    }
    return rows;
  }, [scopedRigs, inventoryResults]);

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
                  onClick={() =>
                    navigate({
                      to: "/topology/seat/$rigId/$logicalId",
                      params: {
                        rigId: row.original.rigId,
                        logicalId: encodeURIComponent(row.original.logicalId),
                      },
                    })
                  }
                  className="border-b border-outline-variant last:border-b-0 hover:bg-surface-low cursor-pointer"
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
