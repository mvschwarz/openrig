// UI Enhancement Pack v0 — Progress browse workspace.
//
// Top-level center-workspace surface for /progress route. Renders the
// workspace's PROGRESS.md hierarchy across operator-allowlisted scan
// roots in one tree.
//
// Two-pane shape:
//   - Left: filter row (status: All/Active/Done/Blocked) + free-text
//     search + per-file collapsible sections.
//   - Right: when a row is clicked, an inline detail panel shows
//     the source file:line citation + parent context.
//
// Per item 1B: read-only at v0; edit mode is item 4 (Files workspace).

import { useMemo, useState } from "react";
import { useProgressTree, type ProgressFileNode, type ProgressRow, type CheckboxStatus } from "../../hooks/useProgressTree.js";

type StatusFilter = "all" | "active" | "done" | "blocked";

const FILTERS: StatusFilter[] = ["all", "active", "done", "blocked"];

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

export function ProgressWorkspace() {
  const tree = useProgressTree();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<{ file: ProgressFileNode; row: ProgressRow } | null>(null);

  return (
    <div data-testid="progress-workspace" className="flex h-full flex-col lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
      <header className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">Workspace</div>
        <h1 className="font-headline text-xl font-bold tracking-tight text-stone-900">Progress</h1>
        {tree.data && !isUnavailable(tree.data) && (
          <div className="mt-1 font-mono text-[10px] text-stone-500" data-testid="progress-aggregate">
            {tree.data.aggregate.totalFiles} file{tree.data.aggregate.totalFiles === 1 ? "" : "s"}
            {" · "}{tree.data.aggregate.totalDone} done
            {" · "}{tree.data.aggregate.totalActive} active
            {" · "}{tree.data.aggregate.totalBlocked} blocked
            {" / "}{tree.data.aggregate.totalRows} total
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="progress-filter-row">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`progress-filter-${f}`}
              data-active={statusFilter === f}
              onClick={() => setStatusFilter(f)}
              className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.10em] ${
                statusFilter === f
                  ? "border-stone-700 bg-stone-700 text-white"
                  : "border-stone-300 text-stone-700 hover:bg-stone-100"
              }`}
            >
              {f}
            </button>
          ))}
          <input
            data-testid="progress-search"
            type="text"
            placeholder="search rows…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto min-w-32 flex-1 border border-stone-300 bg-white px-2 py-1 font-mono text-[10px]"
          />
        </div>
      </header>
      <div className="flex flex-1 min-h-0">
        <main data-testid="progress-tree-pane" className="flex-1 min-w-0 overflow-y-auto bg-white">
          {tree.isLoading && <div className="p-4 font-mono text-[10px] text-stone-400">Loading…</div>}
          {tree.isError && <div className="p-4 font-mono text-[10px] text-red-600">Error loading progress tree.</div>}
          {isUnavailable(tree.data) && (
            <div data-testid="progress-unavailable" className="p-4 font-mono text-[10px] text-stone-500">
              <div>Progress indexer unavailable.</div>
              {tree.data.hint && <div className="mt-1 text-stone-400">{tree.data.hint}</div>}
            </div>
          )}
          {tree.data && !isUnavailable(tree.data) && tree.data.files.length === 0 && (
            <div className="p-4 font-mono text-[10px] text-stone-400">
              No PROGRESS.md files found in scan roots: {tree.data.scannedRoots.map((r) => r.name).join(", ") || "(none)"}.
            </div>
          )}
          {tree.data && !isUnavailable(tree.data) && tree.data.files.map((file) => (
            <ProgressFileSection
              key={`${file.rootName}/${file.relPath}`}
              file={file}
              statusFilter={statusFilter}
              search={search}
              onRowClick={(row) => setSelectedRow({ file, row })}
              selectedRow={selectedRow}
            />
          ))}
        </main>
        {selectedRow && (
          <aside data-testid="progress-detail-pane" className="w-72 shrink-0 overflow-y-auto border-l border-stone-200 bg-stone-50 p-3">
            <button
              type="button"
              data-testid="progress-detail-close"
              onClick={() => setSelectedRow(null)}
              className="mb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500 hover:text-stone-900"
            >
              ✕ close
            </button>
            <div className="font-mono text-[10px] text-stone-500">
              <div className="font-bold text-stone-700">{selectedRow.file.title ?? selectedRow.file.relPath}</div>
              <div className="mt-1 text-[8px] uppercase tracking-[0.12em]">{selectedRow.file.rootName}</div>
              <div className="mt-1 text-[9px] text-stone-400 break-all">{selectedRow.file.relPath}:{selectedRow.row.line}</div>
            </div>
            <div className="mt-3">
              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500">Row</div>
              <div data-testid="progress-detail-text" className="mt-1 whitespace-pre-line font-mono text-[10px] text-stone-800">
                {selectedRow.row.text}
              </div>
            </div>
            <div className="mt-3">
              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500">Status</div>
              <div data-testid="progress-detail-status" className="mt-1 font-mono text-[10px] text-stone-700">
                {selectedRow.row.status}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ProgressFileSection({
  file,
  statusFilter,
  search,
  onRowClick,
  selectedRow,
}: {
  file: ProgressFileNode;
  statusFilter: StatusFilter;
  search: string;
  onRowClick: (row: ProgressRow) => void;
  selectedRow: { file: ProgressFileNode; row: ProgressRow } | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const filteredRows = useMemo(() => filterRows(file.rows, statusFilter, search), [file.rows, statusFilter, search]);
  if (filteredRows.length === 0 && (statusFilter !== "all" || search)) return null;
  return (
    <section
      data-testid={`progress-file-${file.rootName}-${file.relPath}`}
      className="border-b border-stone-100"
    >
      <button
        type="button"
        data-testid={`progress-file-${file.rootName}-${file.relPath}-toggle`}
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-baseline gap-2 bg-stone-50 px-3 py-2 text-left hover:bg-stone-100"
      >
        <span className="font-mono text-[10px] text-stone-500">{collapsed ? "▸" : "▾"}</span>
        <span className="font-mono text-[11px] font-bold text-stone-900">{file.title ?? file.relPath}</span>
        <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500">{file.rootName}</span>
        <span className="ml-auto font-mono text-[9px] text-stone-500">
          {file.counts.done}/{file.counts.total}
        </span>
      </button>
      {!collapsed && (
        <ul className="px-3 py-2">
          {filteredRows.map((row) => (
            <li
              key={`${file.relPath}:${row.line}`}
              data-testid={`progress-row-${file.rootName}-${row.line}`}
              data-status={row.status}
              data-kind={row.kind}
            >
              <button
                type="button"
                onClick={() => onRowClick(row)}
                style={{ paddingLeft: `${row.depth * 1.2}rem` }}
                className={`flex w-full items-baseline gap-2 py-0.5 text-left hover:bg-stone-100 ${
                  selectedRow?.row === row ? "bg-stone-200/80" : ""
                }`}
              >
                {row.kind === "heading" ? (
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-stone-700">
                    {row.text}
                  </span>
                ) : (
                  <>
                    <StatusPill status={row.status} />
                    <span className="font-mono text-[10px] text-stone-800">{row.text}</span>
                    <span className="ml-auto font-mono text-[8px] text-stone-400">L{row.line}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function filterRows(rows: ProgressRow[], filter: StatusFilter, search: string): ProgressRow[] {
  const lowerSearch = search.trim().toLowerCase();
  return rows.filter((r) => {
    // Always include headings (they provide context for filtered children).
    // When a search is active, also gate headings on the search term.
    if (r.kind === "heading") {
      if (lowerSearch && !r.text.toLowerCase().includes(lowerSearch)) return false;
      return true;
    }
    if (filter === "active" && r.status !== "active") return false;
    if (filter === "done" && r.status !== "done") return false;
    if (filter === "blocked" && r.status !== "blocked") return false;
    if (lowerSearch && !r.text.toLowerCase().includes(lowerSearch)) return false;
    return true;
  });
}

function StatusPill({ status }: { status: CheckboxStatus }) {
  const { className, icon, label } = pillStyle(status);
  return (
    <span
      data-testid={`progress-row-pill-${status}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0 font-mono text-[8px] uppercase tracking-[0.10em] ${className}`}
      aria-label={label}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </span>
  );
}

function pillStyle(status: CheckboxStatus): { className: string; icon: string; label: string } {
  switch (status) {
    case "done":    return { className: "border-emerald-400 bg-emerald-50 text-emerald-900", icon: "✓", label: "done" };
    case "blocked": return { className: "border-amber-400 bg-amber-50 text-amber-900", icon: "⚠", label: "blocked" };
    case "active":  return { className: "border-stone-400 bg-stone-50 text-stone-700", icon: "◯", label: "active" };
    default:        return { className: "border-stone-300 bg-stone-50 text-stone-500", icon: "·", label: "unknown" };
  }
}
