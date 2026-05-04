// UI Enhancement Pack v0 + Operator Surface Reconciliation v0 — Progress browse workspace.
//
// UEP v0: workspace-tree walk + checkbox pills + status filters + click-to-expand.
//
// OSR v0 item 2: per-level Priority Rail Rule typography (STEERING /
//   mission / lane / slice / intermediate) + "next pull" marker per
//   lane file (first non-done, non-blocked checkbox row).
// OSR v0 item 6: inline lint warning badges with rule citations
//   (workstream-continuity rules) + Show-lint toggle (default on).

import { useMemo, useState } from "react";
import { useProgressTree, type ProgressFileNode, type ProgressRow, type CheckboxStatus } from "../../hooks/useProgressTree.js";
import {
  classifyPriorityRailLevel,
  computeLintWarnings,
  computeNextPullLine,
  getPriorityRailLevelStyle,
  type LintWarning,
  type PriorityRailLevel,
} from "./priority-rail-rule.js";

type StatusFilter = "all" | "active" | "done" | "blocked";

const FILTERS: StatusFilter[] = ["all", "active", "done", "blocked"];

interface FileMeta {
  level: PriorityRailLevel;
  nextPullLine: number | null;
  lintWarnings: LintWarning[];
}

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

export function ProgressWorkspace() {
  const tree = useProgressTree();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<{ file: ProgressFileNode; row: ProgressRow } | null>(null);
  const [showLint, setShowLint] = useState<boolean>(true);

  // Pre-compute Priority Rail Rule level + lint warnings + next-pull
  // line per file so child sections render without recomputing on every
  // filter/search keystroke. Per item 6: "missing tree" rule needs to
  // know which files have child PROGRESS.md files (parents of other
  // files in the tree) — derived once from the file list.
  const fileMeta = useMemo(() => {
    if (!tree.data || isUnavailable(tree.data)) return new Map<string, FileMeta>();
    const meta = new Map<string, FileMeta>();
    const files = tree.data.files;
    // Set of directory paths that contain child PROGRESS.md files (other than themselves).
    const childDirs = new Set<string>();
    for (const f of files) {
      const parts = f.relPath.split("/");
      // Ancestor dirs (any prefix path) are "parents" if some other
      // file's relPath starts with them.
      for (let i = 0; i < parts.length - 1; i++) {
        childDirs.add(`${f.rootName}|${parts.slice(0, i + 1).join("/")}`);
      }
    }
    for (const f of files) {
      const level = classifyPriorityRailLevel(f);
      const segments = f.relPath.split("/");
      const fileDir = segments.slice(0, -1).join("/");
      const isParent = Array.from(childDirs).some((key) => key === `${f.rootName}|${fileDir}` && fileDir.length > 0)
        // A file at the root with descendants:
        || files.some((other) => other !== f && other.relPath !== f.relPath && other.relPath.startsWith(`${fileDir ? `${fileDir}/` : ""}`) && other.rootName === f.rootName);
      const hasChildFiles = isParent && files.some((other) =>
        other !== f &&
        other.rootName === f.rootName &&
        (fileDir === "" ? true : other.relPath.startsWith(`${fileDir}/`)),
      );
      meta.set(`${f.rootName}/${f.relPath}`, {
        level,
        nextPullLine: level === "lane" ? computeNextPullLine(f) : null,
        lintWarnings: computeLintWarnings(f, hasChildFiles),
      });
    }
    return meta;
  }, [tree.data]);

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
          <button
            type="button"
            data-testid="progress-show-lint-toggle"
            data-active={showLint}
            onClick={() => setShowLint((v) => !v)}
            className={`shrink-0 border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.10em] ${
              showLint
                ? "border-amber-500 bg-amber-50 text-amber-900"
                : "border-stone-300 text-stone-700 hover:bg-stone-100"
            }`}
            title="Toggle Operator Surface Reconciliation v0 lint warnings (item 6)"
          >
            lint {showLint ? "on" : "off"}
          </button>
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
              meta={fileMeta.get(`${file.rootName}/${file.relPath}`)}
              showLint={showLint}
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
  meta,
  showLint,
  statusFilter,
  search,
  onRowClick,
  selectedRow,
}: {
  file: ProgressFileNode;
  meta: FileMeta | undefined;
  showLint: boolean;
  statusFilter: StatusFilter;
  search: string;
  onRowClick: (row: ProgressRow) => void;
  selectedRow: { file: ProgressFileNode; row: ProgressRow } | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const filteredRows = useMemo(() => filterRows(file.rows, statusFilter, search), [file.rows, statusFilter, search]);
  if (filteredRows.length === 0 && (statusFilter !== "all" || search)) return null;
  // OSR v0 item 6: file-scope lint warnings (e.g., missing-tree) render
  // at the file header. Per-row warnings render inline next to their row.
  const lintWarnings = meta?.lintWarnings ?? [];
  const fileScopeLint = lintWarnings.filter((w) => w.line === null);
  const levelStyle = meta ? getPriorityRailLevelStyle(meta.level) : null;
  return (
    <section
      data-testid={`progress-file-${file.rootName}-${file.relPath}`}
      data-rail-level={meta?.level ?? "unknown"}
      className="border-b border-stone-100"
    >
      <button
        type="button"
        data-testid={`progress-file-${file.rootName}-${file.relPath}-toggle`}
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-baseline gap-2 bg-stone-50 px-3 py-2 text-left hover:bg-stone-100"
      >
        <span className="font-mono text-[10px] text-stone-500">{collapsed ? "▸" : "▾"}</span>
        {levelStyle && (
          <span
            data-testid={`progress-file-${file.rootName}-${file.relPath}-level`}
            data-level={meta?.level}
            className={`shrink-0 border px-1 font-mono text-[8px] uppercase tracking-[0.10em] ${levelStyle.chipClass}`}
          >
            {levelStyle.label}
          </span>
        )}
        <span className="font-mono text-[11px] font-bold text-stone-900">{file.title ?? file.relPath}</span>
        <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500">{file.rootName}</span>
        {showLint && lintWarnings.length > 0 && (
          <span
            data-testid={`progress-file-${file.rootName}-${file.relPath}-lint-count`}
            className="shrink-0 border border-amber-400 bg-amber-50 px-1 font-mono text-[8px] uppercase tracking-[0.10em] text-amber-900"
            title={`${lintWarnings.length} lint warning(s)`}
          >
            ⚠ {lintWarnings.length}
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-stone-500">
          {file.counts.done}/{file.counts.total}
        </span>
      </button>
      {!collapsed && showLint && fileScopeLint.length > 0 && (
        <ul data-testid={`progress-file-${file.rootName}-${file.relPath}-file-lint`} className="border-t border-amber-200 bg-amber-50 px-3 py-1">
          {fileScopeLint.map((w, idx) => (
            <li
              key={`file-lint-${idx}`}
              data-testid={`progress-lint-${w.ruleId}`}
              className="font-mono text-[9px] text-amber-900"
              title={w.citation}
            >
              ⚠ {w.message}
            </li>
          ))}
        </ul>
      )}
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
                    {meta?.nextPullLine === row.line && (
                      <span
                        data-testid={`progress-row-${file.rootName}-${row.line}-next-pull`}
                        className="border border-emerald-400 bg-emerald-100 px-1 font-mono text-[8px] uppercase tracking-[0.10em] text-emerald-900"
                        title="Priority Rail Rule: first non-done, non-blocked item on this lane"
                      >
                        next pull
                      </span>
                    )}
                    {showLint && lintWarnings
                      .filter((w) => w.line === row.line)
                      .map((w) => (
                        <span
                          key={w.ruleId}
                          data-testid={`progress-row-${file.rootName}-${row.line}-lint-${w.ruleId}`}
                          className="border border-amber-400 bg-amber-50 px-1 font-mono text-[8px] uppercase tracking-[0.10em] text-amber-900"
                          title={`${w.message} (${w.citation})`}
                        >
                          ⚠ {w.ruleId}
                        </span>
                      ))}
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
