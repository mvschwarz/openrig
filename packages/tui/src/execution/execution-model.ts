// EXECUTION view — a pure presentation model over the daemon's derived
// projection. It never reads PROGRESS text, queue bodies, or transitions.
//
// Design (S4 UX pass): the human asks four questions and gets four groups.
//   DONE       the completion ladder per slice, highest rung first; slices with no rung
//              reached are summarised in one line instead of listed.
//   NOW        claimed lanes with the arbitrated activity verbatim and who decided it.
//   NEXT       dependency-eligible slices in arrangement order; when none are eligible,
//              the reasons the projection gives are grouped and counted, never hidden.
//   ATTENTION  needs-input, parked/stalled rows, fragile joins, and every named
//              INDETERMINATE basis — grouped by basis with the affected slices counted,
//              so one blind spot reads once instead of twenty times.
// Every row opens a detail page built from the projection's own bases (one drill from
// source); `esc` closes it. Nothing here invents an owner, a deadline, or a verdict.
import type { Action } from "../types.js";
import { detailPage, listItem, sectionRule, type ContentLine, type Section } from "../detail.js";
import type { MissionScopesSnap, SliceScopeSnap } from "../scopes/scopes-model.js";

export interface ExecutionViewSnap {
  view: "execution";
  mission: string;
  derived_at?: string;
  sources: Record<string, unknown>;
  q1_lanes: Array<Record<string, unknown>>;
  q2_sequencing: Array<Record<string, unknown>>;
  q3_care?: Array<Record<string, unknown>>;
  q4_ladder: Array<Record<string, unknown>>;
  q5_park: Array<Record<string, unknown>>;
  q6_parallelism?: Record<string, unknown>;
}

const MAX_ROWS_PER_GROUP = 5;
const INDETERMINATE = "INDETERMINATE";
const RUNGS = ["locked", "built", "reviewed", "folded", "adopted"] as const;
const RUNG_LABEL = "lock·build·review·fold·adopt";

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(value: unknown, fallback = "?"): string {
  return typeof value === "string" && value !== "" ? value : value == null ? fallback : String(value);
}

function shortSha(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 9) : "?";
}

function clock(iso: unknown): string {
  return typeof iso === "string" && iso.length >= 19 ? `${iso.slice(11, 19)}Z` : "";
}

function open(key: string): Action {
  return { type: "execution-open", key };
}

/** A drillable row. The text is clamped so the open affordance always survives the pane
 *  width; the full basis lives one drill away. */
function row(text: string, key: string, width = Number.MAX_SAFE_INTEGER): ContentLine {
  const room = Math.max(width - 13, 24);
  const shown = text.length > room ? `${text.slice(0, room - 1)}…` : text;
  return { text: `  ${shown}  (open ▸)`, action: open(key) };
}

function bounded(rows: ContentLine[], empty: string): ContentLine[] {
  const shown = rows.slice(0, MAX_ROWS_PER_GROUP);
  const overflow = rows.length - shown.length;
  return [
    ...(shown.length ? shown : [{ text: `  ${empty}` }]),
    ...(overflow > 0 ? [{ text: `  +${overflow} more` }] : []),
  ];
}

function group(title: string, width: number, rows: ContentLine[], empty: string): ContentLine[] {
  return [{ text: "" }, sectionRule(title, width), ...bounded(rows, empty)];
}

// ---- ladder ----------------------------------------------------------------

interface RungCell { value: unknown; basis: string; glyph: "✓" | "○" | "?" }

function rungCell(ladder: Record<string, unknown>, rung: (typeof RUNGS)[number]): RungCell {
  const cell = record(ladder[rung]);
  const basis = str(cell["basis"], "basis unavailable");
  if (rung === "built") {
    const sha = cell["candidate_sha"];
    return { value: sha, basis, glyph: typeof sha === "string" && sha !== INDETERMINATE ? "✓" : "?" };
  }
  const value = cell["value"];
  return { value, basis, glyph: value === true ? "✓" : value === false ? "○" : "?" };
}

/** Highest rung actually reached (true / built sha), 0 = nothing reached. */
function reachedRank(cells: Record<string, RungCell>): number {
  for (let i = RUNGS.length - 1; i >= 0; i--) if (cells[RUNGS[i]!]!.glyph === "✓") return i + 1;
  return 0;
}

function reachedText(cells: Record<string, RungCell>, rank: number): string {
  if (rank === 0) return "not started";
  const rung = RUNGS[rank - 1]!;
  if (rung === "built") return `built ${shortSha(cells["built"]!.value)}`;
  return rung;
}

interface SliceFacts {
  id: string;
  dir: string;
  order: number;
  ladder: Record<string, unknown>;
  cells: Record<string, RungCell>;
  rank: number;
  sequencing: Record<string, unknown> | null;
  care: Record<string, unknown> | null;
  scope: SliceScopeSnap | null;
  lane: Record<string, unknown> | null;
}

function sliceFacts(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined): SliceFacts[] {
  const missionScopes = scopes?.find((item) => item.mission === execution.mission);
  const seq = execution.q2_sequencing ?? [];
  const care = execution.q3_care ?? [];
  const lanes = execution.q1_lanes ?? [];
  return (execution.q4_ladder ?? []).map((ladder, index) => {
    const id = str(ladder["slice_id"] ?? ladder["dir"]);
    const dir = str(ladder["dir"], id);
    const cells = Object.fromEntries(RUNGS.map((rung) => [rung, rungCell(ladder, rung)])) as Record<string, RungCell>;
    const seqIndex = seq.findIndex((item) => item["slice_id"] === id || item["dir"] === dir);
    return {
      id,
      dir,
      order: seqIndex >= 0 ? seqIndex : seq.length + index,
      ladder,
      cells,
      rank: reachedRank(cells),
      sequencing: seqIndex >= 0 ? seq[seqIndex]! : null,
      care: care.find((item) => item["slice_id"] === id) ?? null,
      scope: missionScopes?.slices.find((slice) => slice.id === id || slice.dirName === dir) ?? null,
      lane: lanes.find((lane) => lane["slice"] === id) ?? null,
    };
  });
}

/** blocked_on_rows entries are `{ qitem_id, blocked_on }` — the slice's own row and the row it
 *  waits on. Render the relation, never the object. */
function blockerText(rows: unknown, lead: "blocker" | "row" = "row"): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return rows
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const r = record(entry);
      const own = str(r["qitem_id"], "?");
      const blocker = str(r["blocked_on"], "?");
      // the overview leads with the BLOCKER so it survives a narrow pane; the page has room for both
      return lead === "blocker" ? `waits on ${blocker} · own row ${own}` : `${own} waits on ${blocker}`;
    })
    .join("; ");
}

function proofText(scope: SliceScopeSnap | null): string {
  return scope ? `proof ${scope.proof.paired}/${scope.proof.total}` : "proof ?";
}

function waveText(care: Record<string, unknown> | null): string {
  const wave = care?.["build_wave"];
  return typeof wave === "string" && wave !== INDETERMINATE ? ` · wave ${wave}` : "";
}

// ---- INDETERMINATE bases, grouped -------------------------------------------

interface BasisGroup { basis: string; where: string; members: string[] }

function collectIndeterminate(execution: ExecutionViewSnap, slices: SliceFacts[]): BasisGroup[] {
  const groups = new Map<string, BasisGroup>();
  const add = (where: string, member: string, value: unknown, basis: unknown) => {
    if (value !== INDETERMINATE || typeof basis !== "string") return;
    const key = `${where}|${basis}`;
    const existing = groups.get(key) ?? { basis, where, members: [] };
    if (!existing.members.includes(member)) existing.members.push(member);
    groups.set(key, existing);
  };
  // Only the FIRST undetermined rung is a blind spot; every rung above it is undetermined
  // as a consequence and would repeat the same fact. NEXT reasons are grouped in NEXT.
  for (const slice of slices) {
    const first = RUNGS.find((rung) => slice.cells[rung]!.glyph === "?");
    if (first) add(first === "built" ? "build" : first, slice.id, INDETERMINATE, slice.cells[first]!.basis);
  }
  for (const lane of execution.q1_lanes ?? []) {
    const activity = record(lane["activity"]);
    add("activity", str(lane["slice"] ?? lane["qitem_id"], "lane"), activity["activity"], activity["basis"]);
  }
  for (const [name, raw] of Object.entries(execution.sources ?? {})) {
    const cell = record(raw);
    add(`source ${name}`, name, cell["value"], cell["basis"]);
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
}

function basisKey(kind: string, basis: string): string {
  return `basis:${kind}:${basis}`;
}

// ---- overview ----------------------------------------------------------------

function laneGlyph(activity: Record<string, unknown>): string {
  if (Number(record(activity["needs_input"])["count"] ?? 0) > 0) return "⚑";
  const state = activity["activity"];
  if (state === "working") return "●";
  if (state === "idle-at-prompt") return "○";
  return "·";
}

function laneText(lane: Record<string, unknown>, id: (value: string) => string): string {
  const activity = record(lane["activity"]);
  const needs = record(activity["needs_input"]);
  const count = Number(needs["count"] ?? 0);
  const need = count > 0 ? ` · needs input: ${str(needs["reason"], String(count))}` : "";
  const when = clock(activity["changed_at"]);
  return `${laneGlyph(activity)} ${id(str(lane["slice"]))}  ${str(lane["seat"])}  ${str(activity["activity"], INDETERMINATE)} · by ${str(activity["decided_by"] ?? activity["basis"], "basis unavailable")}${when ? ` ${when}` : ""}${need}`;
}

function laneKey(lane: Record<string, unknown>): string {
  return `lane:${str(lane["qitem_id"], "unknown")}`;
}

function overviewLines(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number): ContentLine[] {
  const slices = sliceFacts(execution, scopes);
  const lanes = execution.q1_lanes ?? [];
  const q6 = record(execution.q6_parallelism);
  const build = shortSha(record(execution.sources?.["build_info"])["commit"]);
  const derived = clock(execution.derived_at);
  const lines: ContentLine[] = [];
  const idWidth = Math.max(...slices.map((slice) => slice.id.length), ...lanes.map((lane) => str(lane["slice"]).length), 1);
  const id = (value: string) => value.padEnd(idWidth);

  // header — the mission, when the projection was derived, and where it came from
  lines.push({ text: `  ${execution.mission} · derived ${derived || "?"} · daemon build ${build} · ${slices.length} slices` });
  const sourceCount = Object.keys(execution.sources ?? {}).length;
  const gitBasis = str(record(execution.sources?.["git"])["basis"], "");
  lines.push(row(`sources: ${sourceCount} named${gitBasis ? ` · git: ${gitBasis}` : ""}`, "sources", width));

  // DONE — highest rung first, then arrangement order; nothing-reached slices summarised
  const counts = Object.fromEntries(RUNGS.map((rung) => [rung, slices.filter((slice) => slice.cells[rung]!.glyph === "✓").length]));
  const reached = slices.filter((slice) => slice.rank > 0).sort((a, b) => b.rank - a.rank || a.order - b.order);
  const notStarted = slices.filter((slice) => slice.rank === 0);
  const doneRows = reached.map((slice) => {
    const ladder = RUNGS.map((rung) => slice.cells[rung]!.glyph).join("");
    return row(`${id(slice.id)}  ${ladder}  ${reachedText(slice.cells, slice.rank)} · ${proofText(slice.scope)}${waveText(slice.care)}`, `slice:${slice.id}`, width);
  });
  const doneTitle = `DONE  ${RUNGS.map((rung) => `${rung} ${counts[rung]}`).join(" · ")}`;
  lines.push({ text: "" }, sectionRule(doneTitle, width), { text: `  ladder ${RUNG_LABEL} · ✓ yes ○ no ? undetermined` });
  lines.push(...bounded(doneRows, slices.length ? "(no slice has reached a rung)" : "(no slices on this mission)"));
  // always visible, never behind the overflow: the slices this ladder says nothing about yet
  if (notStarted.length) lines.push(row(`${notStarted.length} slice${notStarted.length === 1 ? "" : "s"} with no rung reached`, basisKey("not-started", "no rung reached"), width));

  // NOW — claimed lanes, activity verbatim
  const idle = record(q6["idle_seats_with_capacity"])["value"];
  const nowTitle = `NOW  ${lanes.length} lane${lanes.length === 1 ? "" : "s"} live · idle seats with capacity ${idle === INDETERMINATE || idle == null ? "?" : String(idle)}`;
  lines.push(...group(nowTitle, width, lanes.map((lane) => row(laneText(lane, id), laneKey(lane), width)), "(no claimed lanes)"));

  // NEXT — eligible in rank order; otherwise the projection's reasons, grouped and counted
  const eligible = slices
    .filter((slice) => slice.sequencing?.["next_up"] === true && Array.isArray(slice.sequencing["blocked_on_rows"]) && slice.sequencing["blocked_on_rows"].length === 0)
    .sort((a, b) => Number(a.sequencing!["next_up_rank"] ?? Number.MAX_SAFE_INTEGER) - Number(b.sequencing!["next_up_rank"] ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
  const nextRows = eligible.map((slice) => {
    const deps = slice.sequencing!["depends_on"];
    const after = Array.isArray(deps) && deps.length ? `after ${deps.map(String).join(", ")} (met)` : "no dependencies";
    return row(`→ ${id(slice.id)}  ${after}${waveText(slice.care)}`, `slice:${slice.id}`, width);
  });
  const blockedRows = slices
    .filter((slice) => Array.isArray(slice.sequencing?.["blocked_on_rows"]) && (slice.sequencing!["blocked_on_rows"] as unknown[]).length > 0)
    .map((slice) => row(`⧗ ${id(slice.id)}  ${blockerText(slice.sequencing!["blocked_on_rows"], "blocker")}`, `slice:${slice.id}`, width));
  const reasons = new Map<string, { label: string; members: string[] }>();
  for (const slice of slices) {
    const seq = slice.sequencing;
    if (!seq || seq["next_up"] === true) continue;
    if (Array.isArray(seq["blocked_on_rows"]) && seq["blocked_on_rows"].length > 0) continue;
    const basis = str(seq["next_up_basis"], "no basis given");
    const label = seq["next_up"] === INDETERMINATE ? `? undetermined — ${basis}` : `· ${basis}`;
    const entry = reasons.get(label) ?? { label, members: [] };
    entry.members.push(slice.id);
    reasons.set(label, entry);
  }
  const reasonRows = [...reasons.values()]
    .sort((a, b) => b.members.length - a.members.length)
    .map((entry) => row(`${entry.members.length} ${entry.label}`, basisKey("next", entry.label), width));
  const nextTitle = `NEXT  ${eligible.length} eligible${blockedRows.length ? ` · ${blockedRows.length} blocked` : ""}${reasons.size ? ` · ${[...reasons.values()].reduce((n, e) => n + e.members.length, 0)} not eligible` : ""}`;
  lines.push(...group(nextTitle, width, [...nextRows, ...blockedRows, ...reasonRows], "(nothing sequenced)"));

  // ATTENTION — needs-input first, then parked/stalled, fragile joins, then grouped INDETERMINATE
  const attention: ContentLine[] = [];
  for (const lane of lanes) {
    const needs = record(record(lane["activity"])["needs_input"]);
    if (Number(needs["count"] ?? 0) > 0) attention.push(row(`⚑ ${id(str(lane["slice"]))}  ${str(lane["seat"])}  needs input: ${str(needs["reason"], String(needs["count"]))}`, laneKey(lane), width));
  }
  for (const park of execution.q5_park ?? []) {
    if (park["pickup_state"] === "working") continue;
    const qitemId = str(park["qitem_id"], "park");
    const lane = lanes.find((candidate) => candidate["qitem_id"] === qitemId);
    const age = park["age_minutes"] != null ? ` · ${String(park["age_minutes"])}m since claim` : "";
    attention.push(row(`⚑ ${id(str(lane?.["slice"], qitemId))}  pickup ${str(park["pickup_state"], INDETERMINATE)} · ${str(park["park_kind"], "indeterminate")}${age}`, lane ? laneKey(lane) : `park:${qitemId}`, width));
  }
  const fragile = new Map<string, string[]>();
  for (const lane of lanes) {
    if (lane["fragile_join"] !== true) continue;
    const basis = str(lane["join_basis"], "join basis unavailable");
    fragile.set(basis, [...(fragile.get(basis) ?? []), str(lane["slice"] ?? lane["qitem_id"])]);
  }
  for (const [basis, members] of fragile) attention.push(row(`△ ${members.length} lane${members.length === 1 ? "" : "s"} on a fragile join — ${basis} · ${members.join(", ")}`, basisKey("fragile", basis), width));
  for (const item of collectIndeterminate(execution, slices)) {
    const what = item.where.startsWith("source") ? item.where : `${item.members.length} slice${item.members.length === 1 ? "" : "s"} ${item.where} undetermined`;
    attention.push(row(`? ${what} — ${item.basis}`, basisKey(item.where, item.basis), width));
  }
  lines.push(...group(`ATTENTION  ${attention.length}`, width, attention, "(nothing needs a person right now — on the surfaces this view reads)"));
  return lines;
}

// ---- drill pages -------------------------------------------------------------

function back(): ContentLine {
  return { text: "  esc back · ⏎ open · : command bar" };
}

function sliceDetail(execution: ExecutionViewSnap, slices: SliceFacts[], id: string): ContentLine[] | null {
  const slice = slices.find((item) => item.id === id);
  if (!slice) return null;
  const sections: Section[] = [];
  const ladderLines: ContentLine[] = [];
  for (const rung of RUNGS) {
    const cell = slice.cells[rung]!;
    const value = rung === "built" ? (cell.glyph === "✓" ? shortSha(cell.value) : INDETERMINATE) : str(cell.value, INDETERMINATE);
    ladderLines.push({ text: `  ${rung.padEnd(9)} ${cell.glyph} ${value}` });
    ladderLines.push({ text: `            basis: ${cell.basis}` });
  }
  const legs = record(slice.ladder["reviewed"])["legs"];
  if (Array.isArray(legs)) for (const leg of legs) {
    const l = record(leg);
    ladderLines.push(listItem(`review leg ${str(l["verdict"], "?")} · ${str(l["artifact_type"], "?")} · ${str(l["path"])}`, undefined, 12));
  }
  sections.push({ title: `ladder · reached: ${reachedText(slice.cells, slice.rank)}`, lines: ladderLines });

  const seq = slice.sequencing;
  if (seq) {
    const deps = Array.isArray(seq["depends_on"]) ? seq["depends_on"].map(String) : [];
    const blocked = blockerText(seq["blocked_on_rows"]);
    sections.push({
      title: "sequencing",
      fields: [
        { label: "depends on", value: deps.join(", ") || "(none)" },
        { label: "next up", value: `${str(seq["next_up"], INDETERMINATE)} — ${str(seq["next_up_basis"], "no basis given")}` },
        { label: "rank", value: str(seq["next_up_rank"], "—") },
        { label: "blocked on", value: blocked || "(no rows)" },
        ...(slice.care ? [{ label: "wave", value: str(slice.care["build_wave"], INDETERMINATE) }] : []),
      ],
    });
  }
  if (slice.scope) {
    const drops = slice.scope.proofContract.flatMap((contract) => contract.drops.map((drop) => `${drop.artifactType ?? "?"} ${drop.verdict ?? ""} · ${drop.file}`));
    sections.push({
      title: `proof ${slice.scope.proof.paired}/${slice.scope.proof.total} paired`,
      lines: drops.length ? drops.map((drop) => listItem(drop)) : [{ text: "  (no proof drops recorded)" }],
    });
  }
  if (slice.lane) {
    const activity = record(slice.lane["activity"]);
    sections.push({
      title: "lane",
      fields: [
        { label: "seat", value: str(slice.lane["seat"]) },
        { label: "activity", value: `${str(activity["activity"], INDETERMINATE)} · by ${str(activity["decided_by"], "?")} ${clock(activity["changed_at"])}`.trim(), link: open(laneKey(slice.lane)) },
      ],
    });
  }
  const source = record(seq?.["source"]);
  sections.push({
    title: "sources",
    fields: [
      { label: "spec", value: str(source["spec_path"], "(not named)") },
      { label: "arrangement", value: str(source["arrangement_path"], "(not named)") },
      { label: "wave map", value: str(source["wave_map_row"], "(not named)") },
    ],
  });
  return [...detailPage({ text: `${slice.id} — ${slice.dir}` }, sections), { text: "" }, back()];
}

function laneDetail(execution: ExecutionViewSnap, key: string): ContentLine[] | null {
  const lane = (execution.q1_lanes ?? []).find((item) => laneKey(item) === key);
  const park = (execution.q5_park ?? []).find((item) => `lane:${str(item["qitem_id"])}` === key || `park:${str(item["qitem_id"])}` === key);
  if (!lane && !park) return null;
  const activity = record(lane?.["activity"]);
  const needs = record(activity["needs_input"]);
  const sections: Section[] = [];
  if (lane) {
    sections.push({
      title: "lane",
      fields: [
        { label: "qitem", value: str(lane["qitem_id"]) },
        { label: "slice", value: str(lane["slice"]), link: open(`slice:${str(lane["slice"])}`) },
        { label: "seat", value: str(lane["seat"]) },
        { label: "activity", value: str(activity["activity"], INDETERMINATE) },
        { label: "decided by", value: str(activity["decided_by"] ?? activity["basis"], "basis unavailable") },
        { label: "changed", value: str(activity["changed_at"], "—") },
        { label: "needs input", value: Number(needs["count"] ?? 0) > 0 ? `${str(needs["count"])} · ${str(needs["reason"], "input")}` : "none" },
        { label: "pickup", value: str(record(lane["pickup"])["state"], INDETERMINATE) },
        { label: "oracle", value: str(activity["source"], "(not named)") },
      ],
    });
    sections.push({
      title: `repo join${lane["fragile_join"] === true ? " · FRAGILE" : ""}`,
      fields: [
        { label: "worktree", value: str(lane["worktree_path"], INDETERMINATE) },
        { label: "branch", value: str(lane["branch"], INDETERMINATE) },
        { label: "head", value: str(lane["head_sha"], INDETERMINATE) },
        { label: "join basis", value: str(lane["join_basis"], "(not named)") },
      ],
    });
  }
  if (park) {
    sections.push({
      title: "pickup · park row",
      fields: [
        { label: "qitem", value: str(park["qitem_id"]) },
        { label: "pickup", value: str(park["pickup_state"], INDETERMINATE) },
        { label: "kind", value: str(park["park_kind"], "indeterminate") },
        { label: "basis", value: str(park["park_kind_basis"], "(not named)") },
        { label: "wake", value: str(park["wake_target"], "none armed") },
        { label: "age", value: park["age_minutes"] != null ? `${String(park["age_minutes"])} min since claim` : "—" },
        ...(park["pickup_evidence"] ? [{ label: "evidence", value: str(park["pickup_evidence"]) }] : []),
      ],
    });
  }
  const heading = lane ? `lane ${str(lane["slice"])} · ${str(lane["seat"])}` : `row ${str(park?.["qitem_id"])}`;
  return [...detailPage({ text: heading }, sections), { text: "" }, back()];
}

function basisDetail(execution: ExecutionViewSnap, slices: SliceFacts[], key: string): ContentLine[] | null {
  const m = key.match(/^basis:([^:]+):(.*)$/s);
  if (!m) return null;
  const [, kind, basis] = m as [string, string, string];
  let members: string[] = [];
  let heading = basis;
  if (kind === "not-started") {
    members = slices.filter((slice) => slice.rank === 0).map((slice) => slice.id);
    heading = "slices with no rung reached (not locked, no candidate recorded)";
  } else if (kind === "next") {
    members = slices
      .filter((slice) => {
        const seq = slice.sequencing;
        if (!seq || seq["next_up"] === true) return false;
        const b = str(seq["next_up_basis"], "no basis given");
        return (seq["next_up"] === INDETERMINATE ? `? undetermined — ${b}` : `· ${b}`) === basis;
      })
      .map((slice) => slice.id);
  } else if (kind === "fragile") {
    members = (execution.q1_lanes ?? []).filter((lane) => lane["fragile_join"] === true && str(lane["join_basis"], "join basis unavailable") === basis).map((lane) => str(lane["slice"] ?? lane["qitem_id"]));
    heading = `fragile join — ${basis}`;
  } else {
    const found = collectIndeterminate(execution, slices).find((item) => item.where === kind && item.basis === basis);
    if (!found) return null;
    members = found.members;
    heading = `${kind} undetermined — ${basis}`;
  }
  const items = members.map((member) => {
    const slice = slices.find((s) => s.id === member);
    const lane = (execution.q1_lanes ?? []).find((l) => str(l["slice"]) === member);
    return listItem(member, slice ? open(`slice:${member}`) : lane ? open(laneKey(lane)) : undefined);
  });
  return [{ text: heading }, { text: "" }, sectionRule(`affected (${members.length})`), ...(items.length ? items : [{ text: "  (none)" }]), { text: "" }, back()];
}

function sourcesDetail(execution: ExecutionViewSnap): ContentLine[] {
  const lines: ContentLine[] = [{ text: `sources behind ${execution.mission} · derived ${clock(execution.derived_at) || "?"}` }];
  for (const [name, raw] of Object.entries(execution.sources ?? {})) {
    const cell = record(raw);
    lines.push({ text: "" });
    lines.push(sectionRule(name));
    for (const [field, value] of Object.entries(cell)) lines.push({ text: `  ${`${field}:`.padEnd(12)} ${str(value, "—")}` });
    if (Object.keys(cell).length === 0) lines.push({ text: `  ${str(raw, "—")}` });
  }
  lines.push({ text: "" });
  lines.push(back());
  return lines;
}

export function executionContentLines(
  execution: ExecutionViewSnap | null | undefined,
  scopes: readonly MissionScopesSnap[] | undefined,
  readErrors: readonly string[],
  opened: string | null,
  width = 96,
  pending = false,
): ContentLine[] {
  if (!execution) {
    const failure = readErrors.find((entry) => entry.startsWith("execution:"));
    // three different truths, never one message: the read failed (named), the read has
    // not answered yet (pending), or it answered with no execution row at all.
    if (failure) return [sectionRule("ATTENTION  1", width), { text: `  execution projection unavailable — ${failure}` }];
    if (pending) return [{ text: "  execution projection: read pending — the first daemon read has not answered yet (honest-empty, not fabricated)" }];
    return [sectionRule("ATTENTION  1", width), { text: "  execution projection served no row — no active mission resolved on the daemon" }];
  }
  if (opened) {
    const slices = sliceFacts(execution, scopes);
    const page = opened === "sources"
      ? sourcesDetail(execution)
      : opened.startsWith("slice:")
        ? sliceDetail(execution, slices, opened.slice("slice:".length))
        : opened.startsWith("lane:") || opened.startsWith("park:")
          ? laneDetail(execution, opened)
          : basisDetail(execution, slices, opened);
    return page ?? [{ text: `  ${opened} is not in the current snapshot (it may have closed or been re-derived)` }, { text: "" }, back()];
  }
  return overviewLines(execution, scopes, width);
}
