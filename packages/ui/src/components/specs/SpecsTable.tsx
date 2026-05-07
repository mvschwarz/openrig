// V1 attempt-3 Phase 3 — Specs library tanstack table per specs-tree.md L82–L100 + SC-28.

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { VellumInput } from "../ui/vellum-input.js";

const COLUMNS: ColumnDef<SpecLibraryEntry>[] = [
  {
    accessorKey: "kind",
    header: "Kind",
    cell: ({ getValue }) => (
      <span className="font-mono text-[10px] uppercase tracking-wide">
        {String(getValue())}
      </span>
    ),
  },
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <Link
        to="/specs/library/$entryId"
        params={{ entryId: row.original.id }}
        className="font-mono text-xs text-stone-900 hover:underline"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "version",
    header: "Version",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs">{String(getValue())}</span>
    ),
  },
  {
    accessorKey: "sourceType",
    header: "Source",
    cell: ({ getValue }) => (
      <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">
        {String(getValue()).replace("_", " ")}
      </span>
    ),
  },
  {
    accessorKey: "updatedAt",
    header: "Updated",
    cell: ({ getValue }) => {
      const v = String(getValue() ?? "");
      return (
        <span className="font-mono text-[10px] text-on-surface-variant">
          {v ? v.slice(0, 10) : "—"}
        </span>
      );
    },
  },
];

export function SpecsTable() {
  const { data: library, isLoading } = useSpecLibrary();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState("");

  const data = useMemo(() => library ?? [], [library]);

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
      const e = row.original;
      return (
        e.name.toLowerCase().includes(q) ||
        e.kind.toLowerCase().includes(q) ||
        e.sourceType.toLowerCase().includes(q)
      );
    },
  });

  return (
    <div data-testid="specs-library-table" className="space-y-3">
      <div className="flex items-center gap-2">
        <VellumInput
          placeholder="Search library..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          testId="specs-search-input"
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
            {isLoading ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center font-mono text-xs text-on-surface-variant">
                  Loading…
                </td>
              </tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center font-mono text-xs text-on-surface-variant">
          No library entries match.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`specs-row-${row.original.id}`}
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
