// Slice Story View v0 — Decisions tab.
//
// Linear timeline of every operator-driven mission_control_actions row
// touching this slice's qitem chain. Filter controls: by verb, by
// actor, by free-text search across reason / verb / qitem.
// Operator drills into a row by clicking — expands the JSON before/
// after state snapshot for forensic reconstruction.

import { useMemo, useState } from "react";
import type { DecisionRow } from "../../../hooks/useSlices.js";

export function DecisionsTab({ rows }: { rows: DecisionRow[] }) {
  const [verbFilter, setVerbFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");

  const verbs = useMemo(() => {
    const set = new Set(rows.map((r) => r.verb));
    return ["all", ...Array.from(set).sort()];
  }, [rows]);

  const actors = useMemo(() => {
    const set = new Set(rows.map((r) => r.actor));
    return ["all", ...Array.from(set).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const lower = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (verbFilter !== "all" && r.verb !== verbFilter) return false;
      if (actorFilter !== "all" && r.actor !== actorFilter) return false;
      if (!lower) return true;
      return (
        r.verb.toLowerCase().includes(lower) ||
        r.qitemId.toLowerCase().includes(lower) ||
        (r.reason ?? "").toLowerCase().includes(lower)
      );
    });
  }, [rows, verbFilter, actorFilter, search]);

  if (rows.length === 0) {
    return <div className="p-4 font-mono text-[10px] text-on-surface-variant" data-testid="decisions-empty">No mission_control_actions rows found for this slice's qitem chain.</div>;
  }

  return (
    <div data-testid="decisions-tab" className="flex h-full flex-col">
      <div className="flex flex-wrap gap-2 border-b border-outline-variant bg-background p-3" data-testid="decisions-filters">
        <select
          data-testid="decisions-verb-filter"
          value={verbFilter}
          onChange={(e) => setVerbFilter(e.target.value)}
          className="border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[10px]"
        >
          {verbs.map((v) => (<option key={v} value={v}>{v}</option>))}
        </select>
        <select
          data-testid="decisions-actor-filter"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          className="border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[10px]"
        >
          {actors.map((a) => (<option key={a} value={a}>{a}</option>))}
        </select>
        <input
          data-testid="decisions-search"
          type="text"
          placeholder="search verb / qitem / reason"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-32 border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[10px]"
        />
        <span className="font-mono text-[10px] text-on-surface-variant" data-testid="decisions-result-count">
          {filtered.length} / {rows.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto" data-testid="decisions-list">
        {filtered.map((row) => (<DecisionRowItem key={row.actionId} row={row} />))}
      </div>
    </div>
  );
}

function DecisionRowItem({ row }: { row: DecisionRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-outline-variant px-4 py-2 hover:bg-background">
      <button
        type="button"
        data-testid={`decision-row-${row.actionId}`}
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-on-surface-variant shrink-0">{row.ts.slice(0, 19)}</span>
          <span className="font-mono text-[10px] font-bold text-on-surface shrink-0">{row.verb}</span>
          <span className="font-mono text-[9px] text-on-surface-variant shrink-0">{row.actor}</span>
          <span className="font-mono text-[9px] text-on-surface-variant truncate">{row.qitemId}</span>
        </div>
        {row.reason && (
          <div className="ml-[120px] font-mono text-[10px] text-on-surface">{row.reason}</div>
        )}
      </button>
      {expanded && (
        <div className="ml-[120px] mt-1 grid grid-cols-2 gap-2" data-testid={`decision-row-detail-${row.actionId}`}>
          <pre className="overflow-x-auto bg-background p-2 font-mono text-[9px] text-on-surface">
            <div className="text-on-surface-variant">before:</div>
            {row.beforeState ?? "null"}
          </pre>
          <pre className="overflow-x-auto bg-background p-2 font-mono text-[9px] text-on-surface">
            <div className="text-on-surface-variant">after:</div>
            {row.afterState ?? "null"}
          </pre>
        </div>
      )}
    </div>
  );
}
