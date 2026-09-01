// EXECUTION view — a pure presentation model over the daemon's derived
// projection. It never reads PROGRESS text, queue bodies, or transitions.
import type { Action } from "../types.js";
import type { ContentLine } from "../detail.js";
import type { MissionScopesSnap } from "../scopes/scopes-model.js";

export interface ExecutionViewSnap {
  view: "execution";
  mission: string;
  derived_at?: string;
  sources: Record<string, unknown>;
  q1_lanes: Array<Record<string, unknown>>;
  q2_sequencing: Array<Record<string, unknown>>;
  q4_ladder: Array<Record<string, unknown>>;
  q5_park: Array<Record<string, unknown>>;
}

const MAX_ROWS_PER_GROUP = 5;

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sourceAction(source: string): Action {
  return { type: "execution-source", source };
}

function row(text: string, source: string): ContentLine {
  return { text: `  ${text}  (open ▸)`, action: sourceAction(source) };
}

function bounded(title: string, rows: ContentLine[]): ContentLine[] {
  const shown = rows.slice(0, MAX_ROWS_PER_GROUP);
  const overflow = rows.length - shown.length;
  return [
    { text: `${title} (${rows.length})` },
    ...(shown.length ? shown : [{ text: "  (none)" }]),
    ...(overflow > 0 ? [{ text: `  +${overflow} more` }] : []),
  ];
}

function rung(value: unknown): string {
  if (value === true) return "✓";
  if (value === false) return "○";
  return "?";
}

function firstProofPath(ladder: Record<string, unknown>): string | null {
  const legs = record(ladder["reviewed"])["legs"];
  if (!Array.isArray(legs)) return null;
  for (const leg of legs) {
    const path = record(leg)["path"];
    if (typeof path === "string") return path;
  }
  return null;
}

function namedIndeterminate(view: ExecutionViewSnap): Array<{ label: string; basis: string }> {
  const out: Array<{ label: string; basis: string }> = [];
  const seen = new Set<string>();
  const add = (label: string, value: unknown, basis: unknown) => {
    if (value !== "INDETERMINATE" || typeof basis !== "string" || seen.has(basis)) return;
    seen.add(basis);
    out.push({ label, basis });
  };
  for (const lane of view.q1_lanes ?? []) {
    const activity = record(lane["activity"]);
    add(String(lane["slice"] ?? lane["qitem_id"] ?? "lane"), activity["activity"], activity["basis"]);
  }
  for (const item of view.q2_sequencing ?? []) {
    add(String(item["slice_id"] ?? item["dir"] ?? "sequence"), item["next_up"], item["next_up_basis"]);
  }
  for (const item of view.q4_ladder ?? []) {
    const label = String(item["slice_id"] ?? item["dir"] ?? "ladder");
    for (const key of ["locked", "reviewed", "folded", "adopted"]) {
      const cell = record(item[key]);
      add(label, cell["value"], cell["basis"]);
    }
    const built = record(item["built"]);
    add(label, built["candidate_sha"], built["basis"]);
  }
  for (const [name, raw] of Object.entries(view.sources ?? {})) {
    const cell = record(raw);
    add(`source ${name}`, cell["value"], cell["basis"]);
  }
  return out;
}

export function executionContentLines(
  execution: ExecutionViewSnap | null | undefined,
  scopes: readonly MissionScopesSnap[] | undefined,
  readErrors: readonly string[],
  selectedSource: string | null,
): ContentLine[] {
  if (selectedSource) return [{ text: "SOURCE" }, { text: `  ${selectedSource}` }];
  if (!execution) {
    const failure = readErrors.find((entry) => entry.startsWith("execution:"));
    return [
      { text: "ATTENTION (1)" },
      { text: `  execution projection unavailable — ${failure ?? "no data served"}` },
    ];
  }

  const missionScopes = scopes?.find((item) => item.mission === execution.mission);
  const done = (execution.q4_ladder ?? []).map((item) => {
    const id = String(item["slice_id"] ?? item["dir"] ?? "?");
    const scope = missionScopes?.slices.find((slice) => slice.id === id || slice.dirName === item["dir"]);
    const built = record(item["built"]);
    const proof = scope ? `proof ${scope.proof.paired}/${scope.proof.total}` : "proof ?/?";
    const text = `${id}  ${proof} · lock${rung(record(item["locked"])["value"])} build${rung(built["candidate_sha"] === "INDETERMINATE" ? "INDETERMINATE" : true)} review${rung(record(item["reviewed"])["value"])} fold${rung(record(item["folded"])["value"])} adopt${rung(record(item["adopted"])["value"])}`;
    const proofDrop = scope?.proofContract.flatMap((contract) => contract.drops).find((drop) => drop.file)?.file;
    const source = proofDrop
      ?? firstProofPath(item)
      ?? String(record(item["folded"])["basis"] ?? built["basis"] ?? `ladder for ${id}`);
    return row(text, source);
  });

  const now = (execution.q1_lanes ?? []).map((item) => {
    const activity = record(item["activity"]);
    const needs = record(activity["needs_input"]);
    const need = Number(needs["count"] ?? 0) > 0 ? ` · needs ${needs["count"]}: ${needs["reason"] ?? "input"}` : "";
    const decided = String(activity["decided_by"] ?? activity["basis"] ?? "basis unavailable");
    return row(
      `${String(item["slice"] ?? "?")} · ${String(item["seat"] ?? "?")} · ${String(activity["activity"] ?? "INDETERMINATE")} · decided_by ${decided}${need}`,
      `activity basis: ${decided}; qitem: ${String(item["qitem_id"] ?? "unknown")}`,
    );
  });

  const next = (execution.q2_sequencing ?? [])
    .filter((item) => item["next_up"] === true && Array.isArray(item["blocked_on_rows"]) && item["blocked_on_rows"].length === 0)
    .sort((a, b) => Number(a["next_up_rank"] ?? Number.MAX_SAFE_INTEGER) - Number(b["next_up_rank"] ?? Number.MAX_SAFE_INTEGER))
    .map((item) => {
      const source = record(item["source"]);
      return row(
        `${String(item["slice_id"] ?? item["dir"] ?? "?")} · order ${String(item["next_up_rank"] ?? "?")} · deps satisfied`,
        String(source["arrangement_path"] ?? source["spec_path"] ?? item["next_up_basis"] ?? "sequencing source unavailable"),
      );
    });

  const attentionByKey = new Map<string, { reasons: string[]; sources: string[] }>();
  const attention = (key: string, reason: string, source: string) => {
    const existing = attentionByKey.get(key) ?? { reasons: [], sources: [] };
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    if (!existing.sources.includes(source)) existing.sources.push(source);
    attentionByKey.set(key, existing);
  };
  for (const item of execution.q1_lanes ?? []) {
    const key = String(item["slice"] ?? item["qitem_id"] ?? "lane");
    const activity = record(item["activity"]);
    const needs = record(activity["needs_input"]);
    if (Number(needs["count"] ?? 0) > 0) attention(key, `needs input: ${String(needs["reason"] ?? needs["count"])}`, `qitem ${String(item["qitem_id"] ?? "unknown")}`);
    if (item["fragile_join"] === true) attention(key, "fragile join", String(item["join_basis"] ?? item["qitem_id"] ?? key));
  }
  for (const item of execution.q5_park ?? []) {
    if (item["pickup_state"] === "working") continue;
    const qitemId = String(item["qitem_id"] ?? "park");
    const lane = (execution.q1_lanes ?? []).find((candidate) => candidate["qitem_id"] === qitemId);
    const key = String(lane?.["slice"] ?? qitemId);
    attention(key, `pickup ${String(item["pickup_state"] ?? "INDETERMINATE")} · ${String(item["park_kind"] ?? "indeterminate")}`, String(item["park_kind_basis"] ?? key));
  }
  for (const item of namedIndeterminate(execution)) attention(item.label, "INDETERMINATE", item.basis);
  const attentionRows = [...attentionByKey.entries()].map(([key, item]) => row(`${key} · ${item.reasons.join(" · ")}`, item.sources.join("; ")));

  return [
    ...bounded("DONE · LADDER", done),
    ...bounded("NOW", now),
    ...bounded("NEXT", next),
    ...bounded("ATTENTION", attentionRows),
  ];
}
