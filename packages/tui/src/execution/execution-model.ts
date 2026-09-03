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
import { detailPage, listItem, sectionRule, type ContentLine, type Section } from "../detail.js";
import { scopeContractLines, scopeIdentityLines, type MissionScopesSnap, type SliceScopeSnap } from "../scopes/scopes-model.js";

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
  /** S06: existing workflow engine facts joined to the selected mission. */
  lifecycle_instances?: Array<Record<string, unknown>>;
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

function clock(iso: unknown): string {
  return typeof iso === "string" && iso.length >= 19 ? `${iso.slice(11, 19)}Z` : "";
}

function clip(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text;
}

/** Keep lifecycle commands complete in the scrollable pane. Shell continuations make the
 * visual wrap usable as one command instead of turning the hidden suffix into guesswork. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      word += char;
      escaped = true;
    } else if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      word += char;
      quote = quote === char ? null : char;
    } else if (/\s/.test(char) && quote === null) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Split only words emitted by the daemon's shellQuote helper. A continuation directly
 * between adjacent quoted chunks is one shell argument; option-to-option continuations
 * retain a separating space. */
function splitQuotedWord(word: string, maxWidth: number): string[] | null {
  if (!word.startsWith("'") || !word.endsWith("'")) return null;
  const value = word.slice(1, -1).replaceAll(`'"'"'`, "'");
  if (quoteShell(value) !== word) return null;
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (chunk && quoteShell(chunk + char).length > maxWidth) {
      chunks.push(quoteShell(chunk));
      chunk = char;
    } else {
      chunk += char;
    }
  }
  chunks.push(quoteShell(chunk));
  return chunks;
}

function actionLines(action: string, width: number): ContentLine[] {
  const firstIndent = "      action ";
  const nextIndent = "        ";
  const room = Math.max(width, 24);
  const parts = shellWords(action);
  const lines: ContentLine[] = [];
  let current = `${firstIndent}${parts.shift() ?? ""}`;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const more = index < parts.length - 1;
    if (current && `${current} ${part}${more ? " \\" : ""}`.length <= room) {
      current += ` ${part}`;
      continue;
    }
    if (current) lines.push({ text: `${current} \\` });
    const chunks = splitQuotedWord(part, room - 2);
    if (chunks && `${nextIndent}${part}${more ? " \\" : ""}`.length > room) {
      for (let chunkIndex = 0; chunkIndex < chunks.length - 1; chunkIndex++) {
        lines.push({ text: `${chunks[chunkIndex]!}\\` });
      }
      const last = chunks[chunks.length - 1]!;
      if (more) {
        lines.push({ text: `${last} \\` });
        current = "";
      } else {
        current = last;
      }
    } else {
      current = `${nextIndent}${part}`;
    }
  }
  if (current) lines.push({ text: current });
  return lines;
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
  if (word === "working" || word === "done" || word === "active") return "ok";
  if (word === "needs input" || word === "blocked" || word === "parked") return "warn";
  if (word === "failed") return "error";
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

function graphNode(slice: SliceFacts, width: number): ContentLine[] {
  const inside = width - 2;
  const title = ` ${slice.id} `;
  const topTail = `${"─".repeat(Math.max(0, inside - title.length - 1))}┐`;
  const nameText = padCell(` ${slice.name}`, inside);
  const state = `${stateMark(stateWord(slice))} ${stateWord(slice)}`;
  const owner = assigneeText(slice);
  const ownerRoom = Math.max(0, inside - 1 - state.length);
  const rawOwner = owner ? ` · ${owner}` : "";
  const ownerText = ownerRoom > 0 ? clip(rawOwner, ownerRoom) : "";
  const statusPad = " ".repeat(Math.max(0, inside - 1 - state.length - ownerText.length));
  return [
    semantic([{ text: "┌─", token: "chrome" }, { text: title, token: "accentBright", bold: true }, { text: topTail, token: "chrome" }], width),
    semantic([{ text: "│", token: "chrome" }, { text: nameText, token: "bright" }, { text: "│", token: "chrome" }], width),
    semantic([
      { text: "│ ", token: "chrome" },
      { text: state, token: stateToken(stateWord(slice)), bold: true },
      { text: ownerText, token: "dim" },
      { text: statusPad },
      { text: "│", token: "chrome" },
    ], width),
    semantic([{ text: `└${"─".repeat(inside)}┘`, token: "chrome" }], width),
  ];
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
    for (let line = 0; line < 4; line += 1) {
      const segs = boxes.flatMap((box, index) => [
        ...(index > 0 ? [{ text: " ".repeat(gap) }] : []),
        ...(box[line]!.segs ?? [{ text: box[line]!.text }]),
      ]);
      out.push({ text: segs.map((seg) => seg.text).join(""), segs, zones });
    }
    const centers = chunk.map((_, index) => index * (nodeWidth + gap) + Math.floor(nodeWidth / 2));
    const busWidth = Math.min(width, chunk.length * nodeWidth + Math.max(0, chunk.length - 1) * gap);
    const stubs = Array.from({ length: busWidth }, () => " ");
    for (const center of centers) if (center < stubs.length) stubs[center] = "│";
    out.push({ text: stubs.join("").trimEnd() });
    if (chunk.length === 1) {
      const arrow = Array.from({ length: busWidth }, () => " ");
      if (centers[0]! < arrow.length) arrow[centers[0]!] = "▼";
      out.push(semantic([{ text: arrow.join("").trimEnd(), token: "chrome" }], width));
      continue;
    }
    const bus = Array.from({ length: busWidth }, () => " ");
    const lo = centers[0] ?? 0;
    const hi = centers.at(-1) ?? lo;
    for (let x = lo; x <= hi && x < bus.length; x += 1) bus[x] = "━";
    for (const center of centers) if (center < bus.length) bus[center] = "┴";
    const mid = Math.floor((lo + hi) / 2);
    if (mid < bus.length) bus[mid] = centers.includes(mid) ? "┼" : "┬";
    out.push(semantic([{ text: bus.join("").trimEnd(), token: "chrome" }], width));
    const arrow = Array.from({ length: busWidth }, () => " ");
    if (mid < arrow.length) arrow[mid] = "▼";
    out.push(semantic([{ text: arrow.join("").trimEnd(), token: "chrome" }], width));
  }
  return out;
}

function waveRows(execution: ExecutionViewSnap, wave: string, members: SliceFacts[], width: number): ContentLine[] {
  const title = waveTitle(wave, members);
  const header = semantic([
    { text: "━ ", token: "chrome" },
    { text: title, token: "bright", bold: true },
    { text: ` ${"━".repeat(width)}`, token: "chrome" },
  ], width);
  if (width < 70) return [
    { text: "" }, header,
    ...members.map((slice) => semanticAction([
      { text: `${stateMark(stateWord(slice))} ${stateWord(slice).padEnd(11)}`, token: stateToken(stateWord(slice)), bold: true },
      { text: `${slice.id}  `, token: "accentBright" },
      { text: slice.name, token: "bright" },
    ], sliceAction(execution, slice), width)),
  ];
  return [
    { text: "" }, header, ...graphChunk(execution, members, width),
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
  const live = slices.filter((slice) => stateWord(slice) === "working").length;
  const problems = slices.filter((slice) => problemText(slice)).length;
  const build = shortSha(record(execution.sources?.["build_info"])["commit"]);
  const now = slices.filter((slice) => stateWord(slice) === "working").map((slice) => slice.id);
  const needsHuman = slices.filter((slice) => problemText(slice));
  const done = slices.filter((slice) => declaredText(slice) === "done").length;
  const next = slices.find((slice) => nextText(slice) === "ready to start");
  const unknown = slices.filter((slice) => RUNGS.some((rung) => slice.cells[rung].state === "undetermined")).length;
  const missionState = problems > 0 ? "NEEDS ATTENTION" : live > 0 ? "ACTIVE" : done === slices.length && slices.length > 0 ? "COMPLETE" : "QUIET";
  const missionToken: Token = problems > 0 ? "warn" : live > 0 || missionState === "COMPLETE" ? "ok" : "dim";
  const nowText = now.length ? now.join(", ") : "no live slice";
  const nextValue = next ? `${next.id} · ready to start` : "no sequenced next transition";
  const progress = `${done}/${slices.length} declared done · ${live} working${problems ? ` · ${problems} with a problem` : ""}`;
  const fact = (label: string, value: string, token: Token): ContentLine => semantic([
    { text: `  ${label.padEnd(10)}`, token: "dim", bold: true },
    { text: value, token },
  ], width);
  const narrowFact = (label: string, value: string, token: Token): ContentLine[] => [
    semantic([{ text: `  ${label}`, token: "dim", bold: true }], width),
    semantic([{ text: `    ${value}`, token }], width),
  ];
  const lines: ContentLine[] = [semantic([
    { text: execution.mission, token: "accentBright", bold: true },
    { text: " · ", token: "chrome" },
    { text: missionState, token: missionToken, bold: true },
    { text: " · ", token: "chrome" },
    { text: `${slices.length} slice${slices.length === 1 ? "" : "s"}`, token: "bright" },
  ], width)];

  if (width < 70) {
    lines.push(...narrowFact("NOW", nowText, now.length ? "ok" : "dim"));
    lines.push(...narrowFact("NEXT", nextValue, next ? "accentBright" : "dim"));
    lines.push(...narrowFact("PROGRESS", progress, "bright"));
  } else {
    lines.push(fact("NOW", nowText, now.length ? "ok" : "dim"));
    lines.push(fact("NEXT", nextValue, next ? "accentBright" : "dim"));
    lines.push(fact("PROGRESS", progress, "bright"));
  }
  if (needsHuman.length) {
    const first = needsHuman[0]!;
    lines.push(semanticAction([
      { text: "  ⚑ NEEDS HUMAN ", token: "warn", bold: true },
      { text: `${needsHuman.map((slice) => slice.id).join(", ")} · ${problemText(first)}`, token: "bright" },
    ], sliceAction(execution, first), width));
  }
  const provenanceAction = unknown > 0 ? open("evidence") : open("sources");
  const provenance: SemanticSeg[] = width < 70 && unknown > 0
    ? [{ text: "  provenance · ", token: "dim" }, { text: `evidence gap ${unknown}/${slices.length}`, token: "warn" }]
    : [
        { text: "  provenance ", token: "dim" },
        { text: "·", token: "chrome" },
        { text: ` ${clock(execution.derived_at) || "?"} · build ${build}`, token: "dim" },
        ...(unknown > 0 ? [
          { text: " · ", token: "chrome" as Token },
          { text: `evidence gap ${unknown}/${slices.length} unknown`, token: "warn" as Token },
        ] : []),
      ];
  lines.push(semanticAction(provenance, provenanceAction, width));
  lines.push(...lifecycleLines(execution, width));

  const waves = new Map<string, SliceFacts[]>();
  for (const slice of slices) waves.set(waveOf(slice), [...(waves.get(waveOf(slice)) ?? []), slice]);
  for (const [wave, members] of waves) lines.push(...waveRows(execution, wave, members, width));
  if (slices.length === 0) lines.push({ text: "  (no slices on this mission)" });
  return lines;
}

function lifecycleLines(execution: ExecutionViewSnap, width: number): ContentLine[] {
  const instances = execution.lifecycle_instances ?? [];
  if (instances.length === 0) return [];
  const lines: ContentLine[] = [{ text: "" }, sectionRule(`LIFECYCLE · ${instances.length} instance${instances.length === 1 ? "" : "s"}`, width)];
  for (const raw of instances) {
    const instance = record(raw);
    const instanceId = str(instance["instance_id"], INDETERMINATE);
    lines.push({ text: `  ${instanceId} · ${str(instance["status"], INDETERMINATE)} · key ${str(instance["operation_key"], INDETERMINATE)}` });
    const packets = Array.isArray(instance["frontier_packets"]) ? instance["frontier_packets"] as unknown[] : [];
    for (const rawPacket of packets) {
      const packet = record(rawPacket);
      lines.push({ text: clip(`    ▸ ${str(packet["step_id"], INDETERMINATE)} · ${str(packet["owner"], INDETERMINATE)} · ${str(packet["queue_state"], INDETERMINATE)} · packet ${str(packet["packet_id"], INDETERMINATE)}`, width) });
      if (packet["blocked_on"]) lines.push({ text: clip(`      blocked on ${str(packet["blocked_on"])}`, width) });
      lines.push(...actionLines(str(packet["targeted_action"], INDETERMINATE), width));
    }
    const failures = Array.isArray(instance["failure_occurrences"]) ? instance["failure_occurrences"] as unknown[] : [];
    for (const rawFailure of failures) {
      const failure = record(rawFailure);
      if (failure["status"] !== "unresolved") continue;
      lines.push({ text: clip(`    ▲ ${str(failure["step_id"], INDETERMINATE)} · occurrence ${str(failure["occurrence_id"], INDETERMINATE)}${failure["failure_reason"] ? ` · ${str(failure["failure_reason"])}` : ""}`, width) });
      lines.push(...actionLines(str(failure["targeted_action"], INDETERMINATE), width));
    }
    const unknowns = Array.isArray(instance["unknowns"]) ? instance["unknowns"] as unknown[] : [];
    for (const unknown of unknowns) lines.push({ text: clip(`    ? ${str(unknown, INDETERMINATE)}`, width) });
  }
  return lines;
}

function waveDetail(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number, key: string): ContentLine[] | null {
  const wave = key.slice("group:wave:".length);
  const slices = sliceFacts(execution, scopes);
  const members = slices.filter((slice) => waveOf(slice) === wave);
  if (members.length === 0) return null;
  return [
    { text: `${execution.mission} · wave ${wave} · all ${members.length} rows` },
    ...waveRows(execution, wave, members, width),
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

function touchedRows(detail: SliceDetailSnap | null, width: number): ContentLine[] {
  if (!detail) return [cardField("served data", "slice detail not loaded for this selection")];
  const latest = new Map<string, SliceDetailSnap["story"]["events"][number]>();
  for (const event of detail.story.events) if (event.actorSession) latest.set(event.actorSession, event);
  if (latest.size === 0) return [cardField("actors", "none in the served slice event history")];
  const limit = width < 70 ? 1 : 3;
  const shown = [...latest.entries()].sort((a, b) => b[1].ts.localeCompare(a[1].ts)).slice(0, limit);
  return [
    ...shown.flatMap(([actor, event]) => [
      ...wrappedCardField("actor", actor, width),
      ...wrappedCardField("last change", `${clock(event.ts) || event.ts} · ${event.kind}${event.qitemId ? ` · ${event.qitemId}` : ""}`, width),
    ]),
    cardField("history", `${latest.size} served actor${latest.size === 1 ? "" : "s"} · latest ${shown.length} shown`),
  ];
}

function rulingRows(detail: SliceDetailSnap | null, width: number): ContentLine[] {
  if (!detail) return [cardField("served data", "slice detail not loaded for this selection")];
  const latest = [...detail.decisions.rows].sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!latest) return [cardField("decision", "none in the served slice decision history")];
  return [
    ...wrappedCardField("actor", `${latest.actor} · ${clock(latest.ts) || latest.ts} · ${latest.verb}`, width),
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
    { text: "" }, ...card("TOUCHED", touchedRows(detail, width), width),
    { text: "" }, ...card(`EVIDENCE · declared ${declaredText(slice)} · ${evidenceText(slice.cells, slice.rank)}`, evidence, width),
    { text: "" }, ...card("RULING", rulingRows(detail, width), width),
    { text: "" }, ...card("NEEDS YOU", [cardField("state", needs ?? "none on current projection")], width),
    { text: "" }, ...card("TYPED ROWS", typedRows, width),
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
  sliceDetailRead?: SliceDetailSnap | null,
  scopeOpts: { collapseReqs: boolean; narrative: boolean } = { collapseReqs: false, narrative: false },
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
        ? sliceDetail(execution, slices, opened.slice("slice:".length), width, sliceDetailRead, scopeOpts)
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
