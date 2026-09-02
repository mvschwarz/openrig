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
  return slice.scope
    ? { type: "scopes-open", mission: execution.mission, slice: slice.scope.dirName }
    : open(`slice:${slice.id}`);
}

function sliceRow(execution: ExecutionViewSnap, slice: SliceFacts, width: number, stateWidth: number, idWidth: number): ContentLine {
  // facts in priority order; a narrow pane drops from the END (proof, evidence, next…) and
  // the assignee's decider before it ever clips a fact mid-word
  const facts = [
    assigneeText(slice),
    problemText(slice),
    slice.lane ? null : nextText(slice),
    evidenceText(slice.cells, slice.rank),
    proofText(slice.scope),
  ].filter((fact): fact is string => !!fact);
  const prefix = `${stateWord(slice).padEnd(stateWidth)}  ${slice.id.padEnd(idWidth)}  `;
  const budget = Math.max(width - 13, 24) - prefix.length;
  let shown = facts;
  while (shown.join(" · ").length > budget && shown.length > 1) {
    const decider = shown.findIndex((fact) => / \(.+\)$/.test(fact) && fact === assigneeText(slice));
    shown = decider >= 0 ? shown.map((fact, i) => (i === decider ? fact.replace(/ \(.+\)$/, "") : fact)) : shown.slice(0, -1);
  }
  const factsText = shown.join(" · ");
  const room = budget - factsText.length - 3;
  // the name gets whatever room the facts leave; below twelve cells it is dropped, not stubbed
  const name = room >= 12 ? `${clip(slice.name, room)} · ` : "";
  return actionRow(`${prefix}${name}${factsText}`, sliceAction(execution, slice), width);
}

function countWords(slices: SliceFacts[]): string {
  const counts = new Map<string, number>();
  for (const slice of slices) counts.set(stateWord(slice), (counts.get(stateWord(slice)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word, n]) => `${n} ${word}`).join(", ");
}

function waveTitle(wave: string, members: SliceFacts[]): string {
  return `wave ${wave} · ${members.length} slice${members.length === 1 ? "" : "s"} · ${countWords(members)}`;
}

function waveRows(execution: ExecutionViewSnap, wave: string, members: SliceFacts[], width: number, stateWidth: number, idWidth: number, capped: boolean): ContentLine[] {
  const shown = capped ? members.slice(0, MAX_ROWS_PER_WAVE) : members;
  const overflow = members.length - shown.length;
  return [
    { text: "" },
    sectionRule(waveTitle(wave, members), width),
    ...shown.map((slice) => sliceRow(execution, slice, width, stateWidth, idWidth)),
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
  const rungs = RUNGS.filter((rung) => undetermined.some((slice) => slice.cells[rung].state === "undetermined")).map((rung) => RUNG_WORD[rung]);
  const cause = noRepo ? "no repository reachable" : gitBasis || "evidence sources missing";
  return [
    row(`evidence gap — ${cause}; declared state shown`, "evidence", width),
    { text: `    ${rungs.join(" / ")} unconfirmed for ${undetermined.length} of ${slices.length} slices (unknown, not waiting)` },
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
  const lines: ContentLine[] = [
    { text: `  ${execution.mission} EXECUTION · ${slices.length} slice${slices.length === 1 ? "" : "s"}` },
    { text: `  declared in slice files: ${declaredText_ || "none"} · live now: ${live} working${problems ? `, ${problems} with a problem` : ""}` },
    row(`sources · derived ${clock(execution.derived_at) || "?"} · daemon build ${build}`, "sources", width),
    ...evidenceGapLines(execution, slices, width),
  ];

  const waves = new Map<string, SliceFacts[]>();
  for (const slice of slices) waves.set(waveOf(slice), [...(waves.get(waveOf(slice)) ?? []), slice]);
  const stateWidth = Math.max(...slices.map((slice) => stateWord(slice).length), 4);
  const idWidth = Math.max(...slices.map((slice) => slice.id.length), 1);
  for (const [wave, members] of waves) lines.push(...waveRows(execution, wave, members, width, stateWidth, idWidth, true));
  if (slices.length === 0) lines.push({ text: "  (no slices on this mission)" });
  return lines;
}

function waveDetail(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number, key: string): ContentLine[] | null {
  const wave = key.slice("group:wave:".length);
  const slices = sliceFacts(execution, scopes);
  const members = slices.filter((slice) => waveOf(slice) === wave);
  if (members.length === 0) return null;
  const stateWidth = Math.max(...members.map((slice) => stateWord(slice).length), 4);
  const idWidth = Math.max(...members.map((slice) => slice.id.length), 1);
  return [
    { text: `${execution.mission} · wave ${wave} · all ${members.length} rows` },
    ...waveRows(execution, wave, members, width, stateWidth, idWidth, false),
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

function sliceDetail(execution: ExecutionViewSnap, slices: SliceFacts[], id: string): ContentLine[] | null {
  const slice = slices.find((item) => item.id === id);
  if (!slice) return null;
  const sections: Section[] = [];
  const ladderLines: ContentLine[] = [];
  for (const rung of RUNGS) {
    const cell = slice.cells[rung];
    const value = rung === "built" ? (cell.state === "yes" ? shortSha(cell.value) : "undetermined") : cell.state;
    ladderLines.push({ text: `  ${RUNG_WORD[rung].padEnd(12)} ${value}` });
    ladderLines.push({ text: `               basis: ${cell.basis}` });
  }
  const legs = record(slice.ladder["reviewed"])["legs"];
  if (Array.isArray(legs)) for (const leg of legs) {
    const l = record(leg);
    ladderLines.push(listItem(`review leg ${str(l["verdict"], "?")} · ${str(l["artifact_type"], "?")} · ${str(l["path"])}`, undefined, 12));
  }
  sections.push({
    title: `declared ${declaredText(slice)} · evidence ${evidenceText(slice.cells, slice.rank)}`,
    lines: ladderLines,
  });

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
        { label: "wave", value: waveOf(slice) },
      ],
    });
  }
  if (slice.scope) {
    const drops = slice.scope.proofContract.flatMap((contract) => contract.drops.map((drop) => `${drop.artifactType ?? "?"} ${drop.verdict ?? ""} · ${drop.file}`));
    sections.push({
      title: `proof ${slice.scope.proof.paired} of ${slice.scope.proof.total} paired`,
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
  return [...detailPage({ text: `${slice.id} — ${slice.name}` }, sections), { text: "" }, back()];
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
        ? sliceDetail(execution, slices, opened.slice("slice:".length))
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
