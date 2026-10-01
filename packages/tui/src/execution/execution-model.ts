import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { workflowOverview, workflowDetail } from "./workflow-model.js";
// MISSION EXECUTION STORY — a pure presentation model over two shipped projections:
// the scopes store (declared slice state, proof pairing) and the daemon's derived
// execution view (lanes, sequencing, ladder, parks). It never reads PROGRESS text,
// queue bodies, or transitions.
//
// Design (founder live-QA correction): a normal person reads the mission top to bottom.
//   - Identity/state leads; NOW, NEXT, and PROGRESS are compact scan targets.
//   - NEEDS HUMAN appears only when actionable and opens the affected slice.
//   - Provenance and any shared evidence gap stay subordinate and drillable.
//   - Waves remain the dominant body and include every slice; viewport scrolling, not
//     omission rows, provides access at narrow and short geometries.
//   - No positional glyph strings, bare abbreviations, or placeholder cells. The full
//     rung-by-rung ladder with bases lives on the slice page.
// Every row opens a page built from the projections' own values; `esc` returns.
import type { Action, SliceDetailSnap } from "../types.js";
import type { Token } from "../theme.js";
import { wrapDetailLines, detailPage, listItem, sectionRule, type ContentLine, type Section } from "../detail.js";
import { scopeContractLines, scopeIdentityLines, proofProvenanceLines, type ReadinessSnap, type MissionScopesSnap, type SliceScopeSnap } from "../scopes/scopes-model.js";

export interface ExecutionViewSnap {
  readiness?: { historicalStatus?: string | null; revision: string; state: string; slices: Array<{ scope: string; readiness: import("../scopes/scopes-model.js").ReadinessSnap }> };
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
  /** S06: existing workflow engine facts joined to the selected mission. */
  lifecycle_instances?: Array<Record<string, unknown>>;
  planning_guidance?: Array<{ label: string; text: string; source: string; wave?: string }>;
}

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

function clip(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text;
}

type SemanticSeg = NonNullable<ContentLine["segs"]>[number];

function fitSegs(parts: SemanticSeg[], width: number): SemanticSeg[] {
  const out: SemanticSeg[] = [];
  let room = Math.max(0, width);
  for (const part of parts) {
    if (room <= 0) break;
    if (part.text.length <= room) {
      out.push(part);
      room -= part.text.length;
      continue;
    }
    out.push({ ...part, text: room === 1 ? "…" : `${part.text.slice(0, room - 1)}…` });
    room = 0;
  }
  return out;
}

function semantic(parts: SemanticSeg[], width: number, action?: Action): ContentLine {
  const segs = fitSegs(parts, width);
  return { text: segs.map((part) => part.text).join(""), segs, ...(action ? { action } : {}) };
}

function semanticAction(parts: SemanticSeg[], action: Action, width: number): ContentLine {
  const suffix: SemanticSeg = { text: "  (open ▸)", token: "accent", bold: true };
  const body = fitSegs(parts, Math.max(0, width - suffix.text.length));
  return semantic([...body, suffix], width, action);
}

function stateToken(word: string): Token {
  if (word === "working" || word === "done" || word === "outcome complete" || word === "active") return "ok";
  if (word === "needs input" || word === "blocked" || word === "parked") return "warn";
  if (word === "failed") return "error";
  if (word === "retired" || word === "deferred") return "dim";
  return "dim";
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
  readiness: ReadinessSnap | null;
  cells: Record<Rung, RungCell>;
  rank: number;
  sequencing: Record<string, unknown> | null;
  care: Record<string, unknown> | null;
  scope: SliceScopeSnap | null;
  lane: Record<string, unknown> | null;
  work: Array<Record<string, unknown>>;
  plannedOwners: Array<{ component: string; owner: string; source: string }>;
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
      readiness: execution.readiness?.slices.find(s => s.scope === dir)?.readiness ?? scope?.readiness ?? null,
      cells,
      rank: reachedRank(cells),
      sequencing: seqIndex >= 0 ? seq[seqIndex]! : null,
      care: care.find((item) => item["slice_id"] === id) ?? null,
      scope,
      lane,
      work: Array.isArray(seq[seqIndex]?.["work_rows"]) ? seq[seqIndex]!["work_rows"] as Array<Record<string, unknown>> : lane ? [lane] : [],
      plannedOwners: (seq[seqIndex]?.["planned_owners"] ?? []) as Array<{ component: string; owner: string; source: string }>,
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

function stageText(slice: SliceFacts): string {
  return slice.scope?.stage?.trim().toLowerCase() || "";
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

/** Outcome acceptance, live work and authored intent are separate inputs. */
function outcomeComplete(slice: SliceFacts): boolean {
  const r = slice.readiness;
  return !!r?.configured && r.state === "ready" && r.items.length > 0 && r.items.every(i => i.state === "accepted");
}
function stateWord(slice: SliceFacts): string {
  const problem = problemText(slice);
  if (problem) return problem.startsWith("needs input") ? "needs input" : problem.startsWith("waits on") ? "blocked" : "waiting";
  if (record(slice.lane?.["activity"])["activity"] === "working") return "working";
  if (slice.work.length) return slice.work.some(w => w["state"] === "blocked") ? "waiting" : "assigned";
  if (outcomeComplete(slice)) return "outcome complete";
  if (slice.readiness?.items.some(i => i.state === "withdrawn" || i.state === "rejected")) return "reopened";
  if (slice.readiness?.configured) return "outcomes pending";
  if (stageText(slice) === "retired" || declaredText(slice) === "retired") return "retired";
  if (declaredText(slice) === "deferred" || declaredText(slice) === "closed-deferred") return "deferred";
  return declaredText(slice) === "done" ? "declared done" : "planned";
}

function proofText(scope: SliceScopeSnap | null): string | null {
  if (!scope) return null;
  if (scope.proof.total === 0) return "no proof contract";
  return `proof ${scope.proof.paired} of ${scope.proof.total}`;
}

function assigneeText(slice: SliceFacts): string | null {
  const owners = [...new Set(slice.work.map(w => seatShort(w["seat"])).filter(Boolean))];
  return owners.length ? owners.join(", ") : null;
}
function plannedOwnerText(slice: SliceFacts): string {
  const build = slice.plannedOwners.filter(p => p.component === "build.minimal-gap");
  return [...new Set((build.length ? build : slice.plannedOwners).map(p => seatShort(p.owner)))].join(", ") || "unknown";
}

/** What unlocks next, only when the projection actually says so. */
function nextText(slice: SliceFacts): string | null {
  const seq = slice.sequencing;
  if (!seq) return null;
  if (outcomeComplete(slice) || slice.work.length) return null;
  if (seq["next_up"] === true) return "ready to start";
  if (blockerText(seq["blocked_on_rows"])) return null; // the problem column carries it

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
  if (word === "done" || word === "outcome complete") return "✓";
  if (word === "failed") return "✕";
  return "○";
}

function padCell(text: string, width: number): string {
  const value = clip(text, width);
  return value + " ".repeat(Math.max(0, width - value.length));
}

function graphNode(slice: SliceFacts, width: number): ContentLine[] {
  const inside = width - 2;
  const state = stateWord(slice);
  const owners = assigneeText(slice);
  const deps = slice.sequencing?.["depends_on"];
  const after = Array.isArray(deps) ? deps.map(String).join(", ") || "none declared" : "unknown";
  const cell = (text: string, token: Token): ContentLine => semantic([
    { text: "│", token: "chrome" }, { text: padCell(" " + text, inside), token }, { text: "│", token: "chrome" },
  ], width);
  return [
    semantic([{ text: "┌" + padCell(`─ ${slice.id} `, inside).replace(/ +$/, m => "─".repeat(m.length)) + "┐", token: "accentBright" }], width),
    cell(slice.name, "bright"), cell(`${stateMark(state)} ${state}`, stateToken(state)),
    cell(owners ? `Owner: ${owners}` : `Planned: ${plannedOwnerText(slice)}`, "dim"),
    cell(`After: ${after}`, "dim"),
    semantic([{ text: `└${"─".repeat(inside)}┘`, token: "chrome" }], width),
  ];
}

function graphChunk(execution: ExecutionViewSnap, members: SliceFacts[], width: number): ContentLine[] {
  const gap = 2;
  const perRow = width >= 108 ? 3 : width >= 70 ? 2 : 1;
  const nodeWidth = Math.floor((width - gap * (Math.min(perRow, members.length) - 1)) / Math.min(perRow, members.length));
  const out: ContentLine[] = [];
  for (let start = 0; start < members.length; start += perRow) {
    const chunk = members.slice(start, start + perRow);
    const boxes = chunk.map(slice => graphNode(slice, nodeWidth));
    const zones = chunk.map((slice, index) => ({ start: index * (nodeWidth + gap), end: index * (nodeWidth + gap) + nodeWidth, action: sliceAction(execution, slice) }));
    for (let line = 0; line < 6; line++) {
      const segs = boxes.flatMap((box, index) => [...(index ? [{ text: " ".repeat(gap) }] : []), ...box[line]!.segs!]);
      out.push({ text: segs.map(seg => seg.text).join(""), segs, zones });
    }
    if (start + perRow < members.length) out.push(semantic([{ text: "  ↓ next in plan order · dependencies above", token: "chrome" }], width));
  }
  return out;
}

function planningLines(execution: ExecutionViewSnap, width: number, wave?: string, expanded = false): ContentLine[] {
  const guidance = (execution.planning_guidance ?? []).filter(item => item.wave === wave &&
    (expanded || (wave ? item.label !== "Review" : item.label === "Integration decision")));
  if (!guidance.length) return [];
  return wrapDetailLines([
    sectionRule(`Authored guidance${wave ? " · " + wave : " · mission"}`, width),
    { text: "  Admission guides decisions. Executable dependencies, proof and custody are separate facts." },
    ...guidance.map(item => ({ text: `  ${item.label}: ${item.text}` })),
    { text: `  Source: ${guidance[0]!.source.split("#")[0]} · arrangement${wave ? ".waves" : ""}` },
  ], width);
}

function waveRows(execution: ExecutionViewSnap, wave: string, members: SliceFacts[], width: number, expanded = false): ContentLine[] {
  const title = waveTitle(wave, members);
  const header = semantic([
    { text: "━ ", token: "chrome" },
    { text: title, token: "bright", bold: true },
    { text: ` ${"━".repeat(width)}`, token: "chrome" },
  ], width);
  return [
    { text: "" }, { ...header, zones: [{ start: 0, end: width, action: open(`group:wave:${wave}`) }] }, ...graphChunk(execution, members, width),
    ...(expanded ? planningLines(execution, width, wave, true) : []),
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
    if (slice.readiness?.configured && slice.cells.built.state !== "yes") continue;
    const first = RUNGS.find((rung) => slice.cells[rung].state === "undetermined");
    if (first) add(RUNG_WORD[first], slice.id, slice.cells[first].basis);
  }
  for (const lane of execution.q1_lanes ?? []) {
    const activity = record(lane["activity"]);
    if (activity["activity"] === INDETERMINATE) add("activity", str(lane["slice"] ?? lane["qitem_id"], "lane"), activity["basis"]);
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
}

function evidenceDetail(execution: ExecutionViewSnap, slices: SliceFacts[], width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  const attributed = slices.filter(slice => slice.readiness?.configured);
  const gitBasis = str(record(execution.sources?.["git"])["basis"], "(no git source cell)");
  const lines: ContentLine[] = [
    { text: `${execution.mission} · ${attributed.length ? "proof provenance" : "evidence gap"} · derived ${displayTime(execution.derived_at, timeZone) || "?"}` },
    { text: "" },
  ];
  if (attributed.length) {
    lines.push(...wrapDetailLines([{ text: "  Mission proof revision: " + execution.readiness!.revision }], width));
    for (const slice of attributed) lines.push(
      { text: "" }, listItem(slice.id + " · " + slice.name, open(`slice:${slice.id}`)),
      ...proofProvenanceLines(slice.readiness, width),
    );
  } else {
    lines.push(...wrapDetailLines([{ text: "  Declared state comes from each slice file. Legacy code evidence uses candidate tags, review records and Git. Unconfirmed is unknown; it does not establish waiting work or completion." }], width));
  }
  lines.push({ text: "" }, sectionRule("code lineage · separate from item judgments", width),
    { text: `  git:         ${gitBasis}` },
    ...wrapDetailLines([{ text: "  Build, review, merge and live-runtime facts remain on each slice's code evidence. Artifact acceptance supplies none of these code facts." }], width));
  for (const item of collectIndeterminate(execution, slices)) {
    lines.push({ text: "" }, sectionRule(`${item.where} unconfirmed for ${item.members.length} slice${item.members.length === 1 ? "" : "s"}`, width));
    lines.push({ text: `  basis:       ${item.basis}` });
    for (const member of item.members) lines.push(listItem(member, open(`slice:${member}`)));
  }
  lines.push({ text: "" }, row("projection sources and derivation bases", "sources", width), { text: "" }, back());
  return lines;
}

// ---- overview ----------------------------------------------------------------------

function overviewLines(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  const slices = sliceFacts(execution, scopes);
  const live = slices.filter(slice => stateWord(slice) === "working").length;
  const problems = slices.filter(slice => problemText(slice)).length;
  const build = shortSha(record(execution.sources?.["build_info"])["commit"]);
  const active = slices.filter(slice => slice.work.length || problemText(slice));
  const needsHuman = slices.filter(slice => problemText(slice)?.startsWith("needs input"));
  const attributed = slices.some(slice => slice.readiness?.configured);
  const done = slices.filter(outcomeComplete).length;
  const allComplete = slices.length > 0 && done === slices.length;
  const next = slices.find(slice => nextText(slice) === "ready to start") ?? slices.find(slice => !outcomeComplete(slice) && !slice.work.length);
  const unknown = slices.filter(slice => !slice.readiness?.configured).length;
  const missionState = allComplete ? "OUTCOMES COMPLETE" : "OUTCOMES OPEN";
  const missionToken: Token = problems ? "warn" : allComplete ? "ok" : "dim";
  const nowText = active.length ? active.map(slice => `${slice.id} · ${assigneeText(slice) ?? "owner unknown"} · ${stateWord(slice)}`).join("; ") : "no open slice work in this read";
  const nextValue = next ? `${next.id} · ${nextText(next) ?? "dependency eligibility unknown"}`
    : allComplete ? "outcomes complete; release decision separate"
    : active.length ? "await current work; outcomes remain open"
    : "next eligibility unknown";
  const progress = `${done}/${slices.length} outcomes complete · ${live} working${problems ? ` · ${problems} waiting` : ""}${unknown ? ` · ${unknown} proof unknown` : ""}`;
  const fact = (label: string, value: string, token: Token): ContentLine => semantic([
    { text: `  ${label.padEnd(10)}`, token: "dim", bold: true },
    { text: value, token },
  ], width);
  const lines: ContentLine[] = [semantic([
    { text: execution.mission, token: "accentBright", bold: true },
    { text: " · ", token: "chrome" },
    { text: execution.lifecycle_instances?.length ? `Slices: ${missionState}` : missionState, token: missionToken, bold: true },
    { text: " · ", token: "chrome" },
    { text: `${slices.length} slice${slices.length === 1 ? "" : "s"}`, token: "bright" },
  ], width)];

  lines.push(fact("NOW", nowText, active.length ? "ok" : "dim"));
  if (active.length) {
    const first = active[0]!;
    const detail = problemText(first) ?? str(first.work[0]?.["summary"], "Open the slice for queue and activity evidence");
    lines.push(semanticAction([{ text: "  " + detail, token: problemText(first) ? "warn" : "bright" }], sliceAction(execution, first), width));
  }
  lines.push(fact("NEXT", nextValue, next ? "accentBright" : "dim"));
  lines.push(fact("PROGRESS", progress, "bright"));
  lines.push(fact("LIFECYCLE", `${execution.readiness?.historicalStatus ?? "unknown"} · separate from outcomes`, "dim"));
  if (needsHuman.length) {
    const first = needsHuman[0]!;
    lines.push(semanticAction([
      { text: "  ⚑ NEEDS HUMAN ", token: "warn", bold: true },
      { text: `${needsHuman.map((slice) => slice.id).join(", ")} · ${problemText(first)}`, token: "bright" },
    ], sliceAction(execution, first), width));
  }
  const waves = new Map<string, SliceFacts[]>();
  for (const slice of slices) waves.set(waveOf(slice), [...(waves.get(waveOf(slice)) ?? []), slice]);
  for (const [wave, members] of waves) lines.push(...waveRows(execution, wave, members, width));
  const provenanceAction = attributed || unknown > 0 ? open("evidence") : open("sources");
  const provenance: SemanticSeg[] = [
    { text: "  provenance · ", token: "dim" },
    { text: attributed ? `proof judgments · ${done}/${slices.length} ready${unknown ? ` · ${unknown} legacy unknown` : ""}` : unknown > 0 ? `evidence gap ${unknown}/${slices.length} unknown` : `build ${build}`, token: unknown > 0 || (attributed && execution.readiness!.state === "unknown") ? "warn" : "dim" },
  ];
  const localTime = displayTime(execution.derived_at, timeZone);
  if (provenance.reduce((n, s) => n + s.text.length, 0) + localTime.length + 3 <= width) {
    provenance.push({ text: ` · ${localTime}`, token: "dim" });
    lines.push(semanticAction(provenance, provenanceAction, width));
  } else {
    lines.push(semanticAction(provenance, provenanceAction, width));
    lines.push(...wrapDetailLines([{ text: `  derived ${localTime}` }], width));
  }
  lines.push(...lifecycleLines(execution, width));
  lines.push(...planningLines(execution, width));

  if (slices.length === 0) lines.push({ text: "  (no slices on this mission)" });
  return lines;
}

const lifecycleLines = workflowOverview;

function waveDetail(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number, key: string): ContentLine[] | null {
  const wave = key.slice("group:wave:".length);
  const slices = sliceFacts(execution, scopes);
  const members = slices.filter((slice) => waveOf(slice) === wave);
  if (members.length === 0) return null;
  return [
    { text: `${execution.mission} · wave ${wave} · all ${members.length} rows` },
    ...planningLines(execution, width),
    ...waveRows(execution, wave, members, width, true),
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

function wrapWords(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const out: string[] = [];
  let line = "";
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let word = raw;
    while (word.length > room) {
      if (line) { out.push(line); line = ""; }
      out.push(word.slice(0, room));
      word = word.slice(room);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + word.length + 1 <= room) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function wrappedCardField(label: string, value: string, width: number): ContentLine[] {
  const prefix = `${`${label}:`.padEnd(13)} `;
  const continuation = " ".repeat(prefix.length);
  const firstRoom = Math.max(8, width - 4 - prefix.length);
  const chunks = wrapWords(value, firstRoom);
  return chunks.map((chunk, index) => ({ text: `${index === 0 ? prefix : continuation}${chunk}` }));
}

function touchedRows(detail: SliceDetailSnap | null, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  if (!detail) return [cardField("served data", "slice detail not loaded for this selection")];
  const latest = new Map<string, SliceDetailSnap["story"]["events"][number]>();
  for (const event of detail.story.events) if (event.actorSession) latest.set(event.actorSession, event);
  if (latest.size === 0) return [cardField("actors", "none in the served slice event history")];
  const limit = width < 70 ? 1 : 3;
  const shown = [...latest.entries()].sort((a, b) => b[1].ts.localeCompare(a[1].ts)).slice(0, limit);
  return [
    ...shown.flatMap(([actor, event]) => [
      ...wrappedCardField("actor", actor, width),
      ...wrappedCardField("last change", `${displayTime(event.ts, timeZone) || event.ts} · ${event.kind}${event.qitemId ? ` · ${event.qitemId}` : ""}`, width),
    ]),
    cardField("history", `${latest.size} served actor${latest.size === 1 ? "" : "s"} · latest ${shown.length} shown`),
  ];
}

function rulingRows(detail: SliceDetailSnap | null, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  if (!detail) return [cardField("served data", "slice detail not loaded for this selection")];
  const latest = [...detail.decisions.rows].sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!latest) return [cardField("decision", "none in the served slice decision history")];
  return [
    ...wrappedCardField("actor", `${latest.actor} · ${displayTime(latest.ts, timeZone) || latest.ts} · ${latest.verb}`, width),
    ...wrappedCardField("qitem", latest.qitemId, width),
    ...wrappedCardField("decision", latest.reason ?? "no decision reason served", width),
    cardField("history", `${detail.decisions.rows.length} served decision${detail.decisions.rows.length === 1 ? "" : "s"} · latest shown`),
  ];
}

function sliceDetail(
  execution: ExecutionViewSnap,
  slices: SliceFacts[],
  id: string,
  width: number,
  richDetail?: SliceDetailSnap | null,
  scopeOpts: { collapseReqs: boolean; narrative: boolean } = { collapseReqs: false, narrative: false },
  timeZone = DEFAULT_TIME_ZONE,
): ContentLine[] | null {
  const slice = slices.find((item) => item.id === id || item.dir === id);
  if (!slice) return null;
  const detail = richDetail?.name === slice.dir ? richDetail : null;
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

  const source = record(slice.sequencing?.["source"]);
  const sourceRows = [
    cardField("spec", str(source["spec_path"], "not named")),
    cardField("arrangement", str(source["arrangement_path"], "not named")),
    cardField("wave map", str(source["wave_map_row"], "not named")),
  ];
  const identity = slice.scope
    ? scopeIdentityLines(slice.scope, execution.mission, width)
    : [
      { text: clip(`${slice.id} · ${slice.name} · ${stateMark(stateWord(slice))} ${stateWord(slice)} · wave ${waveOf(slice)}`, width) },
    ];
  const authored = slice.scope
    ? scopeContractLines(slice.scope, { ...scopeOpts, width })
    : [{ text: "" }, ...card("AUTHORED CONTRACT", [cardField("state", "scope detail not served")], width)];
  return [
    ...identity,
    { text: "" }, ...card("OWNERSHIP", ownership, width),
    { text: "" }, ...card("TOUCHED", touchedRows(detail, width, timeZone), width),
    { text: "" }, ...proofProvenanceLines(slice.readiness, width),
    { text: "" }, ...card(`${slice.readiness?.configured ? "CODE LINEAGE" : "EVIDENCE"} · declared ${declaredText(slice)} · ${evidenceText(slice.cells, slice.rank)}`, evidence, width),
    { text: "" }, ...card("RULING", rulingRows(detail, width, timeZone), width),
    { text: "" }, ...card("NEEDS YOU", [cardField("state", needs ?? "none on current projection")], width),
    ...wrapDetailLines([
      { text: `Outcome: ${outcomeComplete(slice) ? "complete — all current required judgments accepted" : "not complete / proof pending or unknown"}` },
      ...slice.work.map(w => ({ text: `Queue ${str(w["qitem_id"])} · ${str(w["state"], "assigned")} · owner ${str(w["seat"])} · ${str(w["summary"], "")}${w["blocked_on"] ? ` · waits on ${str(w["blocked_on"])}` : ""}` })),
      ...slice.plannedOwners.map(p => ({ text: `Planned ${p.component}: ${p.owner} · ${p.source}` })),
      { text: "Schedule: dependency order only; ETA unknown." },
    ], width),
    { text: "" }, ...card("TYPED ROWS", typedRows, width),
    { text: "" }, ...planningLines(execution, width), ...planningLines(execution, width, waveOf(slice), true),
    { text: "" }, ...card("DEPENDENCIES", dependencies, width),
    ...authored,
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

function sourcesDetail(execution: ExecutionViewSnap, timeZone = DEFAULT_TIME_ZONE, width = 96): ContentLine[] {
  const lines: ContentLine[] = [{ text: `sources behind ${execution.mission} · derived ${displayTime(execution.derived_at, timeZone) || "?"}` }];
  for (const [name, raw] of Object.entries(execution.sources ?? {})) {
    const cell = record(raw);
    lines.push({ text: "" });
    lines.push(sectionRule(name));
    for (const [field, value] of Object.entries(cell)) lines.push({ text: `  ${`${field}:`.padEnd(12)} ${str(value, "—")}` });
    if (Object.keys(cell).length === 0) lines.push({ text: `  ${str(raw, "—")}` });
  }
  lines.push({ text: "" });
  lines.push(...planningLines(execution, width, undefined, true));
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
  sliceDetailRead?: SliceDetailSnap | null,
  scopeOpts: { collapseReqs: boolean; narrative: boolean } = { collapseReqs: false, narrative: false },
  timeZone = DEFAULT_TIME_ZONE,
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
    const page = opened.startsWith("workflow:") || opened.startsWith("packet:")
      ? workflowDetail(execution, opened, width, timeZone)
      : opened === "sources"
      ? sourcesDetail(execution, timeZone, width)
      : opened === "evidence"
        ? evidenceDetail(execution, slices, width, timeZone)
      : opened.startsWith("group:wave:")
        ? waveDetail(execution, scopes, width, opened)
      : opened.startsWith("slice:")
        ? sliceDetail(execution, slices, opened.slice("slice:".length), width, sliceDetailRead, scopeOpts, timeZone)
        : opened.startsWith("lane:") || opened.startsWith("park:")
          ? laneDetail(execution, opened)
          : null;
    return page ?? [{ text: `  ${opened} is not in the current snapshot (it may have closed or been re-derived)` }, { text: "" }, back()];
  }
  return overviewLines(execution, scopes, width, timeZone);
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
  const next = (declaredWord === "done" || declaredWord === "retired" || declaredWord === "deferred" || declaredWord === "closed-deferred") && !slice.lane
    ? `none — declared ${declaredWord}`
    : nextText(slice) ?? (slice.lane ? "in progress on the lane above" : "nothing the projection can sequence");
  return [
    { text: "" },
    sectionRule(`EXECUTION · ${problem ? stateWord(slice) : liveWord} · wave ${waveOf(slice)}`, width),
    ...workflowOverview(execution, width),
    { text: `  declared    ${declaredWord} (slice file)` },
    actionRow(slice.readiness?.configured ? `proof ${slice.readiness.state} · inspect judgments and evidence` : `evidence    ${evidence}`, open("evidence"), width),
    { text: `  assignment  ${slice.lane ? `${str(slice.lane["seat"])} · ${str(activity["activity"], INDETERMINATE)} (${str(activity["decided_by"], "?")})` : "none — no claimed lane"}`, ...(slice.lane ? { action: open(laneKey(slice.lane)) } : {}) },
    { text: `  next        ${next}` },
    { text: `  problem     ${problem ?? "none on the projection's current surfaces"}` },
    ...planningLines(execution, width), ...planningLines(execution, width, waveOf(slice), true),
  ];
}
