// MISSION EXECUTION STORY — a pure presentation model over two shipped projections:
// the scopes store (declared slice state, proof pairing) and the daemon's derived
// execution view (lanes, sequencing, ladder, parks). It never reads PROGRESS text,
// queue bodies, or transitions.
//
// Design (founder journey repair): a normal person reads the mission top to bottom.
//   - The header says how many slices are DECLARED done/active (from the slice files)
//     and how many are LIVE right now (claimed lanes). Those are two different facts.
//   - One mission-level line names the shared EVIDENCE GAP when the daemon cannot reach a
//     repository: reviewed / merged / live cannot be confirmed for anyone. That gap never
//     relabels a declared-done slice as waiting work; it is stated once, with its basis one
//     drill away.
//   - Waves are the spine. Each slice appears once, as ordinary words: a state word
//     (working, needs input, blocked, parked, or the declared status), the slice name, and
//     the facts the projection actually holds — real assignee only when a lane exists,
//     the highest confirmed evidence rung, proof pairing, and what unlocks next.
//   - No positional glyph strings, no bare abbreviations, no placeholder cells. The full
//     rung-by-rung ladder with bases lives on the slice page.
// Every row opens a page built from the projections' own values; `esc` returns.
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

const MAX_ROWS_PER_WAVE = 5;
const INDETERMINATE = "INDETERMINATE";
const RUNGS = ["locked", "built", "reviewed", "folded", "adopted"] as const;
type Rung = (typeof RUNGS)[number];
/** Ordinary words for the ladder rungs. */
const RUNG_WORD: Record<Rung, string> = { locked: "spec locked", built: "built", reviewed: "reviewed", folded: "merged", adopted: "live" };

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

function clip(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text;
}

function open(key: string): Action {
  return { type: "execution-open", key };
}

/** A drillable row. The text is clamped so the open affordance always survives the pane
 *  width; the full facts live one drill away. */
function actionRow(text: string, action: Action, width = Number.MAX_SAFE_INTEGER): ContentLine {
  return { text: `  ${clip(text, Math.max(width - 13, 24))}  (open ▸)`, action };
}

function row(text: string, key: string, width = Number.MAX_SAFE_INTEGER): ContentLine {
  return actionRow(text, open(key), width);
}

// ---- facts per slice ----------------------------------------------------------

interface RungCell { value: unknown; basis: string; state: "yes" | "no" | "undetermined" }

function rungCell(ladder: Record<string, unknown>, rung: Rung): RungCell {
  const cell = record(ladder[rung]);
  const basis = str(cell["basis"], "basis unavailable");
  if (rung === "built") {
    const sha = cell["candidate_sha"];
    return { value: sha, basis, state: typeof sha === "string" && sha !== INDETERMINATE ? "yes" : "undetermined" };
  }
  const value = cell["value"];
  return { value, basis, state: value === true ? "yes" : value === false ? "no" : "undetermined" };
}

/** Highest rung actually confirmed (true / built sha), 0 = nothing confirmed. */
function reachedRank(cells: Record<Rung, RungCell>): number {
  for (let i = RUNGS.length - 1; i >= 0; i--) if (cells[RUNGS[i]!].state === "yes") return i + 1;
  return 0;
}

/** The evidence fact in words: the highest confirmed rung, or the reason nothing is. */
function evidenceText(cells: Record<Rung, RungCell>, rank: number): string {
  if (rank === 0) return cells.built.state === "undetermined" ? "no candidate recorded" : "nothing confirmed";
  const rung = RUNGS[rank - 1]!;
  return rung === "built" ? `built ${shortSha(cells.built.value)}` : RUNG_WORD[rung];
}

interface SliceFacts {
  id: string;
  dir: string;
  name: string;
  order: number;
  ladder: Record<string, unknown>;
  cells: Record<Rung, RungCell>;
  rank: number;
  sequencing: Record<string, unknown> | null;
  care: Record<string, unknown> | null;
  scope: SliceScopeSnap | null;
  lane: Record<string, unknown> | null;
  park: Record<string, unknown> | null;
}

function sliceName(scope: SliceScopeSnap | null, dir: string): string {
  const raw = scope?.displayName ?? dir;
  // the id column already says which slice; "Slice 04 — " in front of the name is noise
  return raw.replace(/^slice\s+\d+\s*[—–-]\s*/i, "").trim() || dir;
}

function sliceFacts(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined): SliceFacts[] {
  const missionScopes = scopes?.find((item) => item.mission === execution.mission);
  const seq = execution.q2_sequencing ?? [];
  const care = execution.q3_care ?? [];
  const lanes = execution.q1_lanes ?? [];
  const parks = execution.q5_park ?? [];
  return (execution.q4_ladder ?? []).map((ladder, index) => {
    const id = str(ladder["slice_id"] ?? ladder["dir"]);
    const dir = str(ladder["dir"], id);
    const cells = Object.fromEntries(RUNGS.map((rung) => [rung, rungCell(ladder, rung)])) as Record<Rung, RungCell>;
    const seqIndex = seq.findIndex((item) => item["slice_id"] === id || item["dir"] === dir);
    const scope = missionScopes?.slices.find((slice) => slice.id === id || slice.dirName === dir) ?? null;
    const lane = lanes.find((candidate) => candidate["slice"] === id) ?? null;
    return {
      id,
      dir,
      name: sliceName(scope, dir),
      order: seqIndex >= 0 ? seqIndex : seq.length + index,
      ladder,
      cells,
      rank: reachedRank(cells),
      sequencing: seqIndex >= 0 ? seq[seqIndex]! : null,
      care: care.find((item) => item["slice_id"] === id) ?? null,
      scope,
      lane,
      park: lane ? parks.find((item) => item["qitem_id"] === lane["qitem_id"]) ?? null : null,
    };
  }).sort((a, b) => a.order - b.order);
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
      return lead === "blocker" ? `waits on ${blocker} · own row ${own}` : `${own} waits on ${blocker}`;
    })
    .join("; ");
}

/** Declared work state — the slice file's own status word, verbatim. */
function declaredText(slice: SliceFacts): string {
  return slice.scope?.status?.trim().toLowerCase() || "no declared status";
}

function seatShort(seat: unknown): string {
  const full = str(seat, "");
  return full.includes("@") ? full.slice(0, full.indexOf("@")) : full;
}

/** A live problem on the slice, in words, or null. Elapsed time alone is never a verdict. */
function problemText(slice: SliceFacts): string | null {
  const activity = record(slice.lane?.["activity"]);
  const needs = record(activity["needs_input"]);
  if (Number(needs["count"] ?? 0) > 0) return `needs input: ${str(needs["reason"], String(needs["count"]))}`;
  const blocked = blockerText(slice.sequencing?.["blocked_on_rows"], "blocker");
  if (blocked) return blocked.split(" · own row ")[0]!;
  const pickup = slice.park?.["pickup_state"];
  if (slice.park && pickup !== "working") {
    const age = slice.park["age_minutes"] != null ? ` ${String(slice.park["age_minutes"])} min` : "";
    return `${str(pickup, INDETERMINATE)}${age}`;
  }
  return null;
}

/** The one state word a person scans: a live problem, live activity, else the declared status. */
function stateWord(slice: SliceFacts): string {
  const problem = problemText(slice);
  if (problem) return problem.startsWith("needs input") ? "needs input" : problem.startsWith("waits on") ? "blocked" : problem.split(" ")[0]!;
  if (slice.lane) return str(record(slice.lane["activity"])["activity"], "claimed");
  return declaredText(slice);
}

function proofText(scope: SliceScopeSnap | null): string | null {
  if (!scope) return null;
  if (scope.proof.total === 0) return "no proof contract";
  return `proof ${scope.proof.paired} of ${scope.proof.total}`;
}

function assigneeText(slice: SliceFacts): string | null {
  if (!slice.lane) return null;
  const activity = record(slice.lane["activity"]);
  const by = str(activity["decided_by"], "");
  return `${seatShort(slice.lane["seat"])}${by ? ` (${by})` : ""}`;
}

/** What unlocks next, only when the projection actually says so. */
function nextText(slice: SliceFacts): string | null {
  const seq = slice.sequencing;
  if (!seq) return null;
  if (seq["next_up"] === true) return "ready to start";
  if (blockerText(seq["blocked_on_rows"])) return null; // the problem column carries it
  if (slice.lane || slice.rank >= 4 || declaredText(slice) === "done") return null;
  const deps = seq["depends_on"];
  if (Array.isArray(deps) && deps.length > 0) return `after ${deps.map(String).join(", ")}`;
  return null;
}

function waveOf(slice: SliceFacts): string {
  const wave = slice.care?.["build_wave"];
  return typeof wave === "string" && wave !== INDETERMINATE ? wave : "no wave declared";
}

// ---- rows ----------------------------------------------------------------------

function sliceAction(execution: ExecutionViewSnap, slice: SliceFacts): Action {
  void execution;
  return open(`slice:${slice.id}`);
}

function countWords(slices: SliceFacts[]): string {
  const counts = new Map<string, number>();
  for (const slice of slices) counts.set(stateWord(slice), (counts.get(stateWord(slice)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word, n]) => `${n} ${word}`).join(", ");
}

function waveTitle(wave: string, members: SliceFacts[]): string {
  return `WAVE ${wave} · ${members.length} slice${members.length === 1 ? "" : "s"} · ${countWords(members)}`;
}

function stateMark(word: string): string {
  if (word === "working") return "●";
  if (word === "needs input") return "◐";
  if (word === "blocked") return "⚑";
  if (word === "done") return "✓";
  if (word === "failed") return "✕";
  return "○";
}

function padCell(text: string, width: number): string {
  const value = clip(text, width);
  return value + " ".repeat(Math.max(0, width - value.length));
}

function graphNode(slice: SliceFacts, width: number): string[] {
  const inside = width - 2;
  const title = ` ${slice.id} `;
  const top = `┌─${title}${"─".repeat(Math.max(0, inside - title.length - 1))}┐`;
  const name = `│${padCell(` ${slice.name}`, inside)}│`;
  const state = `${stateMark(stateWord(slice))} ${stateWord(slice)}`;
  const owner = assigneeText(slice);
  const status = `│${padCell(` ${state}${owner ? ` · ${owner}` : ""}`, inside)}│`;
  return [top, name, status, `└${"─".repeat(inside)}┘`];
}

function graphChunk(execution: ExecutionViewSnap, members: SliceFacts[], width: number): ContentLine[] {
  const gap = 2;
  const perRow = width >= 108 ? 3 : 2;
  const nodeWidth = Math.min(34, Math.max(18, Math.floor((width - gap * (Math.min(perRow, members.length) - 1)) / Math.min(perRow, members.length))));
  const out: ContentLine[] = [];
  for (let start = 0; start < members.length; start += perRow) {
    const chunk = members.slice(start, start + perRow);
    const boxes = chunk.map((slice) => graphNode(slice, nodeWidth));
    const zones = chunk.map((slice, index) => ({
      start: index * (nodeWidth + gap),
      end: index * (nodeWidth + gap) + nodeWidth,
      action: sliceAction(execution, slice),
    }));
    for (let line = 0; line < 4; line += 1) out.push({ text: boxes.map((box) => box[line]!).join(" ".repeat(gap)), zones });
    const centers = chunk.map((_, index) => index * (nodeWidth + gap) + Math.floor(nodeWidth / 2));
    const busWidth = Math.min(width, chunk.length * nodeWidth + Math.max(0, chunk.length - 1) * gap);
    const stubs = Array.from({ length: busWidth }, () => " ");
    for (const center of centers) if (center < stubs.length) stubs[center] = "│";
    out.push({ text: stubs.join("").trimEnd() });
    if (chunk.length === 1) {
      const arrow = Array.from({ length: busWidth }, () => " ");
      if (centers[0]! < arrow.length) arrow[centers[0]!] = "▼";
      out.push({ text: arrow.join("").trimEnd() });
      continue;
    }
    const bus = Array.from({ length: busWidth }, () => " ");
    const lo = centers[0] ?? 0;
    const hi = centers.at(-1) ?? lo;
    for (let x = lo; x <= hi && x < bus.length; x += 1) bus[x] = "━";
    for (const center of centers) if (center < bus.length) bus[center] = "┴";
    const mid = Math.floor((lo + hi) / 2);
    if (mid < bus.length) bus[mid] = centers.includes(mid) ? "┼" : "┬";
    out.push({ text: bus.join("").trimEnd() });
    const arrow = Array.from({ length: busWidth }, () => " ");
    if (mid < arrow.length) arrow[mid] = "▼";
    out.push({ text: arrow.join("").trimEnd() });
  }
  return out;
}

function waveRows(execution: ExecutionViewSnap, wave: string, members: SliceFacts[], width: number, capped: boolean): ContentLine[] {
  const shown = capped ? members.slice(0, MAX_ROWS_PER_WAVE) : members;
  const overflow = members.length - shown.length;
  const header = clip(`━ ${waveTitle(wave, members)} ${"━".repeat(width)}`, width);
  if (width < 70) return [
    { text: "" }, { text: header },
    ...shown.map((slice) => actionRow(`${stateMark(stateWord(slice))} ${stateWord(slice).padEnd(11)} ${slice.id}  ${slice.name}`, sliceAction(execution, slice), width)),
    ...(overflow > 0 ? [row(`… ${overflow} below — scroll`, `group:wave:${wave}`, width)] : []),
  ];
  return [
    { text: "" }, { text: header }, ...graphChunk(execution, shown, width),
    ...(overflow > 0 ? [row(`+${overflow} more — open all ${members.length} rows in wave ${wave}`, `group:wave:${wave}`, width)] : []),
  ];
}

// ---- the evidence gap, stated once ----------------------------------------------

interface BasisGroup { basis: string; where: string; members: string[] }

function collectIndeterminate(execution: ExecutionViewSnap, slices: SliceFacts[]): BasisGroup[] {
  const groups = new Map<string, BasisGroup>();
  const add = (where: string, member: string, basis: unknown) => {
    if (typeof basis !== "string") return;
    const key = `${where}|${basis}`;
    const existing = groups.get(key) ?? { basis, where, members: [] };
    if (!existing.members.includes(member)) existing.members.push(member);
    groups.set(key, existing);
  };
  // Only the FIRST undetermined rung is a blind spot; every rung above it is undetermined
  // as a consequence and would repeat the same fact.
  for (const slice of slices) {
    const first = RUNGS.find((rung) => slice.cells[rung].state === "undetermined");
    if (first) add(RUNG_WORD[first], slice.id, slice.cells[first].basis);
  }
  for (const lane of execution.q1_lanes ?? []) {
    const activity = record(lane["activity"]);
    if (activity["activity"] === INDETERMINATE) add("activity", str(lane["slice"] ?? lane["qitem_id"], "lane"), activity["basis"]);
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
}

/** The mission-level gap, stated once as two short lines (the first is the drill), or
 *  nothing when every rung is determined for every slice. */
function evidenceGapLines(execution: ExecutionViewSnap, slices: SliceFacts[], width: number): ContentLine[] {
  const undetermined = slices.filter((slice) => RUNGS.some((rung) => slice.cells[rung].state === "undetermined"));
  if (undetermined.length === 0) return [];
  const gitBasis = str(record(execution.sources?.["git"])["basis"], "");
  const noRepo = /no reachable repo|no repo/i.test(gitBasis);
  const cause = noRepo ? "no repository reachable" : gitBasis || "evidence sources missing";
  return [
    row(`evidence gap — ${cause}; declared state shown`, "evidence", width),
    { text: clip(`    evidence unconfirmed for ${undetermined.length} of ${slices.length} slices (unknown, not waiting)`, width) },
  ];
}

function evidenceDetail(execution: ExecutionViewSnap, slices: SliceFacts[], width: number): ContentLine[] {
  const gitBasis = str(record(execution.sources?.["git"])["basis"], "(no git source cell)");
  const lines: ContentLine[] = [
    { text: `${execution.mission} · evidence gap · derived ${clock(execution.derived_at) || "?"}` },
    { text: "" },
    { text: "  Declared state comes from each slice file. Evidence rungs come from the daemon's" },
    { text: "  execution projection, which needs a reachable repository to confirm reviewed, merged" },
    { text: "  and live. Unconfirmed is not waiting work and not done; it is unknown." },
    { text: "" },
    sectionRule("repository source", width),
    { text: `  git:         ${gitBasis}` },
  ];
  for (const item of collectIndeterminate(execution, slices)) {
    lines.push({ text: "" }, sectionRule(`${item.where} unconfirmed for ${item.members.length} slice${item.members.length === 1 ? "" : "s"}`, width));
    lines.push({ text: `  basis:       ${item.basis}` });
    for (const member of item.members) lines.push(listItem(member, open(`slice:${member}`)));
  }
  lines.push({ text: "" }, row("projection sources and derivation bases", "sources", width), { text: "" }, back());
  return lines;
}

// ---- overview ----------------------------------------------------------------------

function overviewLines(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number): ContentLine[] {
  const slices = sliceFacts(execution, scopes);
  const declared = new Map<string, number>();
  for (const slice of slices) declared.set(declaredText(slice), (declared.get(declaredText(slice)) ?? 0) + 1);
  const declaredText_ = [...declared.entries()].sort((a, b) => b[1] - a[1]).map(([word, n]) => `${n} ${word}`).join(", ");
  const live = slices.filter((slice) => stateWord(slice) === "working").length;
  const problems = slices.filter((slice) => problemText(slice)).length;
  const build = shortSha(record(execution.sources?.["build_info"])["commit"]);
  const now = slices.filter((slice) => stateWord(slice) === "working").map((slice) => slice.id);
  const needsHuman = slices.filter((slice) => problemText(slice)).map((slice) => slice.id);
  const done = slices.filter((slice) => declaredText(slice) === "done").length;
  const next = slices.find((slice) => nextText(slice) === "ready to start");
  const summary = (label: string, value: string): ContentLine => ({ text: clip(`  ${label.padEnd(12)}${value}`, width) });
  const lines: ContentLine[] = [
    { text: clip(`  MISSION ${execution.mission} · ${slices.length} slice${slices.length === 1 ? "" : "s"}`, width) },
    summary("NOW", now.length ? now.join(", ") : "no live slice"),
    summary("NEEDS HUMAN", needsHuman.length ? needsHuman.join(", ") : "none"),
    summary("PROGRESS", `${done}/${slices.length} declared done · ${live} working${problems ? ` · ${problems} with a problem` : ""}`),
    summary("NEXT", next ? `${next.id} · ready to start` : "no sequenced next transition"),
    { text: clip(`  declared in slice files: ${declaredText_ || "none"} · live now: ${live} working${problems ? `, ${problems} with a problem` : ""}`, width) },
    row(`sources · derived ${clock(execution.derived_at) || "?"} · daemon build ${build}`, "sources", width),
    ...evidenceGapLines(execution, slices, width),
  ];

  const waves = new Map<string, SliceFacts[]>();
  for (const slice of slices) waves.set(waveOf(slice), [...(waves.get(waveOf(slice)) ?? []), slice]);
  for (const [wave, members] of waves) lines.push(...waveRows(execution, wave, members, width, true));
  if (slices.length === 0) lines.push({ text: "  (no slices on this mission)" });
  return lines;
}

function waveDetail(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number, key: string): ContentLine[] | null {
  const wave = key.slice("group:wave:".length);
  const slices = sliceFacts(execution, scopes);
  const members = slices.filter((slice) => waveOf(slice) === wave);
  if (members.length === 0) return null;
  return [
    { text: `${execution.mission} · wave ${wave} · all ${members.length} rows` },
    ...waveRows(execution, wave, members, width, false),
    { text: "" },
    back(),
  ];
}

// ---- drill pages -------------------------------------------------------------

function back(): ContentLine {
  return { text: "  esc back · ⏎ open · : command bar" };
}

function laneKey(lane: Record<string, unknown>): string {
  return `lane:${str(lane["qitem_id"], "unknown")}`;
}

function card(title: string, rows: ContentLine[], width: number): ContentLine[] {
  const w = Math.max(28, width);
  const label = ` ${title} `;
  const top = `┌─${label}${"─".repeat(Math.max(0, w - label.length - 3))}┐`;
  return [
    { text: clip(top, w) },
    ...rows.map((item) => {
      const suffix = item.action ? "  (open ▸)" : "";
      const value = clip(item.text.trim(), Math.max(1, w - 4 - suffix.length));
      return { ...item, text: `│ ${padCell(value + suffix, w - 4)} │` };
    }),
    { text: `└${"─".repeat(w - 2)}┘` },
  ];
}

function cardField(label: string, value: string, action?: Action): ContentLine {
  return { text: `${`${label}:`.padEnd(13)} ${value}`, ...(action ? { action } : {}) };
}

function sliceDetail(execution: ExecutionViewSnap, slices: SliceFacts[], id: string, width: number): ContentLine[] | null {
  const slice = slices.find((item) => item.id === id);
  if (!slice) return null;
  const activity = record(slice.lane?.["activity"]);
  const needs = problemText(slice);
  const deps = Array.isArray(slice.sequencing?.["depends_on"]) ? (slice.sequencing!["depends_on"] as unknown[]).map(String) : [];
  const unlocks = slices.filter((candidate) => {
    const candidateDeps = candidate.sequencing?.["depends_on"];
    return Array.isArray(candidateDeps) && candidateDeps.map(String).includes(slice.id);
  }).map((candidate) => candidate.id);
  const ownership: ContentLine[] = [
    cardField("seat", slice.lane ? str(slice.lane["seat"]) : "none — no claimed lane", slice.lane ? open(laneKey(slice.lane)) : undefined),
    cardField("activity", slice.lane ? str(activity["activity"], INDETERMINATE) : "not assigned"),
    cardField("decided by", slice.lane ? str(activity["decided_by"] ?? activity["basis"], "basis unavailable") : "—"),
    cardField("changed", slice.lane ? str(activity["changed_at"], "—") : "—"),
  ];
  const evidence: ContentLine[] = [];
  for (const rung of RUNGS) {
    const cell = slice.cells[rung];
    const value = rung === "built" ? (cell.state === "yes" ? shortSha(cell.value) : "undetermined") : cell.state;
    evidence.push(cardField(RUNG_WORD[rung], `${value} · ${cell.basis}`));
  }
  const legs = record(slice.ladder["reviewed"])["legs"];
  if (Array.isArray(legs)) for (const leg of legs) {
    const l = record(leg);
    evidence.push(cardField("review leg", `${str(l["verdict"], "?")} · ${str(l["artifact_type"], "?")} · ${str(l["path"])}`));
  }
  const typedRows: ContentLine[] = slice.lane ? [
    cardField("qitem", str(slice.lane["qitem_id"]), open(laneKey(slice.lane))),
    cardField("pickup", str(record(slice.lane["pickup"])["state"], str(slice.park?.["pickup_state"], INDETERMINATE))),
    cardField("needs input", Number(record(activity["needs_input"])["count"] ?? 0) > 0 ? str(record(activity["needs_input"])["reason"], "input") : "none"),
    cardField("repo join", `${str(slice.lane["worktree_path"], INDETERMINATE)} · ${str(slice.lane["branch"], INDETERMINATE)}`),
  ] : [cardField("rows", "none — no typed queue row for this slice")];
  if (slice.park) typedRows.push(cardField("park", `${str(slice.park["pickup_state"], INDETERMINATE)} · wake ${str(slice.park["wake_target"], "none armed")}`));

  const dependencies: ContentLine[] = [
    cardField("wave", waveOf(slice)),
    cardField("depends on", deps.join(", ") || "none"),
    cardField("unlocks", unlocks.join(", ") || "none"),
    cardField("next", nextText(slice) ?? "no next transition derived"),
    cardField("blocked on", blockerText(slice.sequencing?.["blocked_on_rows"]) || "none"),
  ];

  const proofRows: ContentLine[] = [];
  if (slice.scope) {
    const drops = slice.scope.proofContract.flatMap((contract) => contract.drops.map((drop) => `${drop.artifactType ?? "?"} ${drop.verdict ?? ""} · ${drop.file}`));
    proofRows.push(cardField("paired", `${slice.scope.proof.paired}/${slice.scope.proof.total}`));
    proofRows.push(...(drops.length ? drops.map((drop) => cardField("drop", drop)) : [cardField("drops", "none recorded")]));
  }
  const source = record(slice.sequencing?.["source"]);
  const sourceRows = [
    cardField("spec", str(source["spec_path"], "not named")),
    cardField("arrangement", str(source["arrangement_path"], "not named")),
    cardField("wave map", str(source["wave_map_row"], "not named")),
  ];
  return [
    { text: clip(`${slice.id} · ${slice.name} · ${stateMark(stateWord(slice))} ${stateWord(slice)} · wave ${waveOf(slice)}`, width) },
    { text: "" }, ...card("OWNERSHIP", ownership, width),
    { text: "" }, ...card(`EVIDENCE · declared ${declaredText(slice)} · ${evidenceText(slice.cells, slice.rank)}`, evidence, width),
    { text: "" }, ...card("NEEDS YOU", [cardField("state", needs ?? "none on current projection")], width),
    { text: "" }, ...card("TYPED ROWS", typedRows, width),
    { text: "" }, ...card("DEPENDENCIES", dependencies, width),
    ...(proofRows.length ? [{ text: "" }, ...card("PROOF", proofRows, width)] : []),
    { text: "" }, ...card("SOURCES", sourceRows, width),
    { text: "" }, back(),
  ];
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
      : opened === "evidence"
        ? evidenceDetail(execution, slices, width)
      : opened.startsWith("group:wave:")
        ? waveDetail(execution, scopes, width, opened)
      : opened.startsWith("slice:")
        ? sliceDetail(execution, slices, opened.slice("slice:".length), width)
        : opened.startsWith("lane:") || opened.startsWith("park:")
          ? laneDetail(execution, opened)
          : null;
    return page ?? [{ text: `  ${opened} is not in the current snapshot (it may have closed or been re-derived)` }, { text: "" }, back()];
  }
  return overviewLines(execution, scopes, width);
}

/** Compact source-grounded execution strip embedded in the existing rich SCOPES
 * slice detail. Missing projection/slice data stays explicit instead of being inferred. */
export function executionSliceStripLines(
  execution: ExecutionViewSnap | null | undefined,
  sliceId: string,
  sliceDir: string,
  width = 96,
  declared?: string | null,
): ContentLine[] {
  if (!execution) return [{ text: "" }, sectionRule("EXECUTION · not loaded", width), { text: "  mission execution projection not loaded for this selection" }];
  const slice = sliceFacts(execution, undefined).find((item) => item.id === sliceId || item.dir === sliceDir);
  if (!slice) return [{ text: "" }, sectionRule("EXECUTION · not in projection", width), { text: "  slice absent from the mission execution projection" }];
  const activity = record(slice.lane?.["activity"]);
  const problem = problemText(slice);
  const unconfirmed = RUNGS.filter((rung) => slice.cells[rung].state === "undetermined").map((rung) => RUNG_WORD[rung]);
  const evidence = `${evidenceText(slice.cells, slice.rank)}${unconfirmed.length ? ` · ${unconfirmed.join(" / ")} unconfirmed (${slice.cells[RUNGS.find((rung) => slice.cells[rung].state === "undetermined")!].basis})` : ""}`;
  const liveWord = slice.lane ? str(activity["activity"], "claimed") : "no claimed lane";
  const declaredWord = declared?.trim().toLowerCase() || "no declared status";
  const next = declaredWord === "done" && !slice.lane
    ? "none — declared done"
    : nextText(slice) ?? (slice.lane ? "in progress on the lane above" : "nothing the projection can sequence");
  return [
    { text: "" },
    sectionRule(`EXECUTION · ${problem ? stateWord(slice) : liveWord} · wave ${waveOf(slice)}`, width),
    { text: `  declared    ${declaredWord} (slice file)` },
    actionRow(`evidence    ${evidence}`, open("evidence"), width),
    { text: `  assignment  ${slice.lane ? `${str(slice.lane["seat"])} · ${str(activity["activity"], INDETERMINATE)} (${str(activity["decided_by"], "?")})` : "none — no claimed lane"}`, ...(slice.lane ? { action: open(laneKey(slice.lane)) } : {}) },
    { text: `  next        ${next}` },
    { text: `  problem     ${problem ?? "none on the projection's current surfaces"}` },
  ];
}
