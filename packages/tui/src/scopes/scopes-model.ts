// SCOPES VIEW — pure explorer rows + content lines over STORE-DIRECT daemon data.
// Founder live-QA supersedes the original decorative prose boxes with a compact semantic
// header and responsive Intent / Requirements / Proof regions. PROGRESS.md still renders
// ONLY in the `n` narrative panel, never in status, proof, or lock facts.
import type { Action, ExplorerRow } from "../types.js";
import type { ContentLine } from "../detail.js";
import type { Token } from "../theme.js";

export interface ScopeDropRef { file: string; artifactType: string | null; verdict: string | null; media: string[] }
export interface ScopeContractItem { id?: string; source?: { file: string; line: number }; index: number; text: string; paired: boolean; drops: ScopeDropRef[] }
export interface ScopeLocksSnap { spec: { by: string; at: string } | null; delivery: { by: string; at: string } | null }
export interface ReadinessSnap {
  configured: boolean; state: string; revision: string;
  issues?: string[];
  history?: Array<{ ref: string; id: string; verdict: string; previous: string | null }>;
  items: Array<{ id: string; index: number; text: string; state: string; reason: string; judgment: {
    id: string; actor?: string; at?: string; verdict?: string; previous?: string | null;
    subject?: { kind: string; ref: string; comparison?: string };
    evidence?: Array<{ ref: string; sha256: string }>;
  } | null }>;
}
export interface SliceScopeSnap {
  error?: string;
  sourcePath?: string;
  readiness?: ReadinessSnap;
  dirName: string;
  id: string | null;
  displayName: string;
  status: string | null;
  stage: string | null;
  locks: ScopeLocksSnap;
  proof: { paired: number; total: number };
  intent: string;
  miniRequirements: string[];
  proofContract: ScopeContractItem[];
  narrative: string | null;
  specShaShort: string | null;
  prdExists: boolean;
}
export interface MissionScopesSnap { mission: string; slices: SliceScopeSnap[]; error?: string }

/** Slice state glyph (mock: ● building/spec · ✓ delivery-locked · ⊙ other/idle). */
export function sliceGlyph(s: SliceScopeSnap): string {
  if (s.error) return "!";
  if (s.readiness?.configured) return s.readiness.state === "ready" ? "✓" : "⊙";
  if (s.locks.delivery) return "✓";
  if (s.stage === "building" || s.status === "building" || s.status === "spec") return "●";
  return "⊙";
}

/** The founder lock-glyph form: `proof: N/M 🔒` ONLY when delivery-locked — no del token,
 *  no unproven suffix; the visible COUNT carries the honesty (4/6 🔒 shows partial). */
export function proofBadge(s: SliceScopeSnap): string {
  if (s.readiness?.configured) return `accepted: ${s.readiness.items.filter(i => i.state === "accepted").length}/${s.readiness.items.length} · ${s.readiness.state}`;
  const base = `proof: ${s.proof.paired}/${s.proof.total} paired`;
  return s.locks.delivery ? `${base} 🔒` : base;
}

export function scopesExplorerRows(
  scopes: readonly MissionScopesSnap[] | undefined,
  expanded: ReadonlySet<string>,
  indent: string,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  if (!scopes) return rows;
  for (const m of scopes) {
    const key = `scopes-mission:${m.mission}`;
    const open = expanded.has(key);
    rows.push({
      label: `${indent}${open ? "▾" : "▸"} ${m.mission}${m.error ? " · unavailable" : ""}`,
      action: { type: "scopes-mission-open", mission: m.mission },
      disclosureAction: { type: "toggle-expand", key },
      key,
    });
    if (!open) continue;
    for (const s of m.slices) {
      rows.push({
        label: `${indent}  ${sliceGlyph(s)} ${s.dirName}`,
        action: { type: "scopes-open", mission: m.mission, slice: s.dirName },
        key: `scopes-slice:${m.mission}/${s.dirName}`,
      });
    }
  }
  return rows;
}

type Seg = NonNullable<ContentLine["segs"]>[number];

function semantic(parts: Seg[], width: number, action?: Action): ContentLine {
  const segs: Seg[] = [];
  let room = Math.max(0, width);
  for (const part of parts) {
    if (room <= 0) break;
    if (part.text.length <= room) {
      segs.push(part);
      room -= part.text.length;
    } else {
      segs.push({ ...part, text: room === 1 ? "…" : `${part.text.slice(0, room - 1)}…` });
      room = 0;
    }
  }
  return { text: segs.map((part) => part.text).join(""), segs, ...(action ? { action } : {}) };
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  const limit = Math.max(1, width);
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const original of words) {
      let word = original;
      while (word.length > limit) {
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, limit));
        word = word.slice(limit);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

function rule(title: string, width: number): ContentLine {
  const head = `  ── ${title} `;
  return semantic([
    { text: "  ── ", token: "chrome" },
    { text: title, token: "bright", bold: true },
    { text: ` ${"─".repeat(Math.max(4, width - head.length))}`, token: "chrome" },
  ], width);
}

function wrapped(text: string, width: number, indent: string, token: Token = "bright"): ContentLine[] {
  return wrapText(text, Math.max(1, width - indent.length)).map((part) => semantic([
    { text: indent },
    { text: part, token },
  ], width));
}

/** Render the authoritative read model, including invalidated and corrected receipts.
 * Optional fields keep an older daemon's incomplete projection explicitly unknown. */
export function proofProvenanceLines(proof: ReadinessSnap | null | undefined, width: number): ContentLine[] {
  if (!proof?.configured) return [];
  const lines: ContentLine[] = [rule("PROOF JUDGMENTS · " + proof.state.toUpperCase(), width)];
  const add = (text: string, token: Token = "dim") => lines.push(...wrapped(text, width, "  ", token));
  add("Revision: " + proof.revision);
  add("Item acceptance does not establish code build, merge, runtime adoption or publication.");
  for (const issue of proof.issues ?? []) add(issue, "warn");
  if (!proof.items.length) add("No item judgments available; inspect the contract and issues above.", "warn");
  for (const item of proof.items) {
    lines.push({ text: "" });
    add("Item " + item.index + " · " + item.state.toUpperCase() + " · " + item.text, item.state === "accepted" ? "ok" : "warn");
    add(item.reason, item.state === "unknown" ? "warn" : "dim");
    const judgment = item.judgment;
    if (!judgment) { add("No current attributed judgment.", "warn"); continue; }
    add("Subject: " + (judgment.subject ? judgment.subject.kind + " · " + judgment.subject.ref : "unknown — subject not served"));
    if (judgment.subject?.comparison) add("Comparison: " + judgment.subject.comparison);
    add("Actor: " + (judgment.actor ?? "unknown — actor not served") + " · recorded " + (judgment.at ?? "unknown"));
    add("Receipt: " + judgment.id + " · recorded verdict " + (judgment.verdict ?? "unknown"));
    if (judgment.previous) add("Corrects: " + judgment.previous);
    for (const evidence of judgment.evidence ?? []) {
      add("Evidence: " + evidence.ref);
      add("SHA256: " + evidence.sha256);
    }
    if (!judgment.evidence?.length) add("Evidence references not served.", "warn");
  }
  if (proof.history?.length) {
    lines.push({ text: "" });
    add("Retained history (historical verdicts; current disposition is above):");
    for (const receipt of proof.history) add(receipt.verdict + " · " + receipt.id + " · " + receipt.ref);
  }
  return lines;
}

function itemState(detail: SliceScopeSnap, item: ScopeContractItem): string {
  return detail.readiness?.configured ? detail.readiness.items.find(i => item.id !== undefined && i.id === item.id)?.state.toUpperCase() ?? "UNKNOWN" : item.paired ? "PAIRED" : "OPEN";
}
/** Current evidence comes only from the served judgment; drops retain every round. */
function proofEvidence(detail: SliceScopeSnap, item: ScopeContractItem): Array<{ text: string; token: Token }> {
  const lines: Array<{ text: string; token: Token }> = [];
  const current = detail.readiness?.configured
    ? detail.readiness.items.find(i => item.id !== undefined && i.id === item.id) : undefined;
  const judgment = current?.judgment;
  if (judgment) {
    lines.push({ text: `Current judgment ${judgment.id}: ${current.reason}`, token: current.state === "accepted" ? "ok" : "warn" });
    if (judgment.previous) lines.push({ text: `Corrects: ${judgment.previous}`, token: "dim" });
    for (const evidence of judgment.evidence ?? []) {
      lines.push({ text: `Evidence: ${evidence.ref}`, token: "dim" });
      lines.push({ text: `SHA256: ${evidence.sha256}`, token: "dim" });
    }
    if (!judgment.evidence?.length) lines.push({ text: "Evidence references not served.", token: "warn" });
  } else if (detail.readiness?.configured) {
    lines.push({ text: "No current attributed judgment.", token: "warn" });
  } else if (!item.drops.length) {
    lines.push({ text: "not recorded", token: "warn" });
  }
  if (item.drops.length) lines.push({ text: "Retained proof drops — all rounds", token: "dim" });
  for (const drop of item.drops) {
    lines.push({ text: `↳ ${(drop.artifactType ?? "drop").toUpperCase()} ${drop.verdict ?? ""}`.trimEnd(), token: drop.verdict === "PASS" || drop.verdict === "CLEAR" ? "ok" : "dim" });
    lines.push({ text: drop.file, token: "dim" });
    for (const media of drop.media) lines.push({ text: `media ${media}`, token: "dim" });
  }
  return lines;
}

function proofColumns(detail: SliceScopeSnap, width: number): ContentLine[] {
  const stateW = 8;
  const indexW = 3;
  const evidenceW = Math.max(20, Math.floor(width * 0.28));
  const requirementW = Math.max(18, width - 17 - evidenceW);
  const column = (
    state: string,
    index: string,
    requirement: string,
    evidence: string,
    stateToken: Token = "dim",
    evidenceToken: Token = "dim",
  ): ContentLine => semantic([
    { text: "  " },
    { text: state.padEnd(stateW), token: stateToken, bold: !!state.trim() },
    { text: " " },
    { text: index.padEnd(indexW), token: "accentBright", bold: !!index.trim() },
    { text: " " },
    { text: requirement.padEnd(requirementW), token: requirement.trim() ? "bright" : undefined },
    { text: "  " },
    { text: evidence.padEnd(evidenceW), token: evidenceToken },
  ], width);
  const lines = [column("STATE", "#", "REQUIREMENT", "EVIDENCE", "accentBright", "accentBright")];
  for (const item of detail.proofContract) {
    const requirements = wrapText(item.text, requirementW);
    const evidence = proofEvidence(detail, item).flatMap(line =>
      wrapText(line.text, evidenceW).map(text => ({ text, token: line.token })));
    const count = Math.max(requirements.length, evidence.length, 1);
    for (let i = 0; i < count; i += 1) {
      lines.push(column(
        i === 0 ? itemState(detail, item) : "",
        i === 0 ? String(item.index) : "",
        requirements[i] ?? "",
        evidence[i]?.text ?? "",
        itemState(detail, item) === "ACCEPTED" ? "ok" : "warn",
        evidence[i]?.token ?? "dim",
      ));
    }
  }
  return lines;
}

function proofStack(detail: SliceScopeSnap, width: number): ContentLine[] {
  const lines: ContentLine[] = [];
  for (const item of detail.proofContract) {
    const status = itemState(detail, item);
    lines.push(semantic([
      { text: `  REQ ${item.index} · `, token: "accentBright", bold: true },
      { text: status, token: status === "ACCEPTED" ? "ok" : "warn", bold: true },
    ], width));
    lines.push(...wrapped(item.text, width, "    "));
    lines.push(semantic([{ text: "    EVIDENCE", token: "dim", bold: true }], width));
    for (const line of proofEvidence(detail, item)) lines.push(...wrapped(line.text, width, "    ", line.token));
  }
  return lines;
}

export interface ScopeContentOpts {
  collapseReqs: boolean;
  narrative: boolean;
  width: number;
  executionStrip?: ContentLine[];
}

/** Compact identity/status/provenance block shared by every route into the
 * canonical slice detail. Keeping it here prevents Explorer and mission-graph
 * navigation from growing separate slice pages again. */
export function scopeIdentityLines(detail: SliceScopeSnap, mission: string | null, width: number): ContentLine[] {
  if (detail.error) return wrapped(`${mission}/${detail.dirName} · Source unavailable: ${detail.error}`, width, "", "warn");
  const lines: ContentLine[] = [];
  const w = Math.max(24, width);
  const stage = detail.readiness?.configured ? (detail.readiness.state === "ready" ? "outcome complete" : detail.readiness.items.some(i => i.state === "withdrawn" || i.state === "rejected") ? "reopened" : "outcomes pending") : detail.stage ?? detail.status ?? "unknown";
  const stateToken: Token = /done|established|building|active|spec/i.test(stage) ? "ok" : "dim";
  const proofToken: Token = detail.proof.total > 0 && detail.proof.paired === detail.proof.total ? "ok" : "warn";
  const locks = `${detail.locks.spec ? "spec locked" : "spec open"} · ${detail.locks.delivery ? "delivery locked" : "delivery open"}`;
  lines.push(semantic([
    { text: `${sliceGlyph(detail)} `, token: stateToken, bold: true },
    { text: detail.dirName, token: "accentBright", bold: true },
    { text: " · ", token: "chrome" },
    { text: detail.id ?? "unregistered", token: "bright" },
    { text: " · ", token: "chrome" },
    { text: mission ?? "unknown mission", token: "dim" },
  ], w));
  if (detail.displayName !== detail.dirName) {
    lines.push(semantic([
      { text: "  title  ", token: "dim" },
      { text: `${detail.id ?? "unregistered"} · ${detail.displayName}`, token: "bright" },
    ], w));
  }
  if (w < 70) {
    lines.push(semantic([{ text: "  STATE  ", token: "dim" }, { text: stage, token: stateToken, bold: true }], w));
    lines.push(semantic([{ text: "  PROOF  ", token: "dim" }, { text: `${detail.proof.paired}/${detail.proof.total}`, token: proofToken, bold: true }], w));
    lines.push(semantic([{ text: "  LOCKS  ", token: "dim" }, { text: locks, token: detail.locks.delivery ? "ok" : "bright" }], w));
  } else {
    lines.push(semantic([
      { text: "  STATE ", token: "dim" }, { text: stage, token: stateToken, bold: true },
      { text: " · ", token: "chrome" },
      { text: "PROOF ", token: "dim" }, { text: `${detail.proof.paired}/${detail.proof.total}`, token: proofToken, bold: true },
      { text: " · ", token: "chrome" },
      { text: "LOCKS ", token: "dim" }, { text: locks, token: detail.locks.delivery ? "ok" : "bright" },
    ], w));
  }
  if (detail.readiness?.configured) lines.push({ text: `  judgment basis ${detail.readiness.revision.slice(0, 12)} · publication is separate` });
  const provenance = [
    detail.specShaShort ? `spec ${detail.specShaShort}` : "spec sha unknown",
    detail.locks.spec ? `${detail.locks.spec.at.slice(5, 10)} ${detail.locks.spec.by.split("@")[0]}` : "unlocked",
    detail.prdExists ? "PRD" : "no PRD",
  ].join(" · ");
  // Narrow detail prioritizes identity, state, and the first proof relation in
  // the opening viewport. The complete provenance remains in SOURCES below.
  if (w >= 70) lines.push(semantic([{ text: `  ${provenance}`, token: "dim" }], w));
  return lines;
}

/** The authored half of canonical slice detail. Exported so both Explorer and
 * mission-graph routes can use one operational page without copying the
 * Intent/Requirements/Proof contract renderer. Navigation chrome stays with
 * the owning page. */
export function scopeContractLines(detail: SliceScopeSnap, opts: Pick<ScopeContentOpts, "collapseReqs" | "narrative" | "width">): ContentLine[] {
  if (detail.error) return [];
  const lines: ContentLine[] = [];
  const w = Math.max(24, opts.width);
  if (opts.narrative) {
    lines.push({ text: "" }, rule("PROGRESS · narrative only · N closes", w));
    for (const l of (detail.narrative ?? "(no PROGRESS.md)").split("\n")) lines.push(...wrapped(l, w, "  "));
    return lines;
  }

  lines.push({ text: "" }, rule("INTENT", w));
  lines.push(...wrapped(detail.intent, w, "  "));

  lines.push({ text: "" }, rule(`REQUIREMENTS (${detail.miniRequirements.length}) · M collapses`, w));
  if (!opts.collapseReqs) {
    detail.miniRequirements.forEach((requirement, i) => {
      const chunks = wrapText(requirement, Math.max(1, w - 5));
      chunks.forEach((chunk, j) => lines.push(semantic([
        { text: j === 0 ? `  ${i + 1}  ` : "     ", token: j === 0 ? "accentBright" : undefined, bold: j === 0 },
        { text: chunk, token: "bright" },
      ], w)));
    });
  } else {
    lines.push(semantic([{ text: "  collapsed · M expands", token: "dim" }], w));
  }

  lines.push({ text: "" }, rule(`PROOF · ${detail.proof.paired}/${detail.proof.total} paired`, w));
  lines.push(...(w < 70 ? proofStack(detail, w) : proofColumns(detail, w)));
  return lines;
}

export function scopesContentLines(
  detail: SliceScopeSnap | null,
  mission: string | null,
  opts: ScopeContentOpts,
): ContentLine[] {
  const lines: ContentLine[] = [];
  if (!detail) {
    lines.push({ text: "select a mission from the SCOPES tree to open its execution path" });
    return lines;
  }
  const w = Math.max(24, opts.width);
  lines.push(...scopeIdentityLines(detail, mission, w));

  if (opts.executionStrip?.length) lines.push(...opts.executionStrip);
  lines.push(...proofProvenanceLines(detail.readiness, w));
  lines.push(...scopeContractLines(detail, opts));
  lines.push({ text: "" }, semantic([{
    text: opts.narrative ? "  esc back · N narrative · M reqs · : command bar" : "  esc back · M collapse reqs · N narrative · : command bar",
    token: "dim",
  }], w));
  return lines;
}
