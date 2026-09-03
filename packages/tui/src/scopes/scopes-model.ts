// SCOPES VIEW — pure explorer rows + content lines over STORE-DIRECT daemon data.
// Founder live-QA supersedes the original decorative prose boxes with a compact semantic
// header and responsive Intent / Requirements / Proof regions. PROGRESS.md still renders
// ONLY in the `n` narrative panel, never in status, proof, or lock facts.
import type { Action, ExplorerRow } from "../types.js";
import type { ContentLine } from "../detail.js";
import type { Token } from "../theme.js";

export interface ScopeDropRef { file: string; artifactType: string | null; verdict: string | null; media: string[] }
export interface ScopeContractItem { index: number; text: string; paired: boolean; drops: ScopeDropRef[] }
export interface ScopeLocksSnap { spec: { by: string; at: string } | null; delivery: { by: string; at: string } | null }
export interface SliceScopeSnap {
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
export interface MissionScopesSnap { mission: string; slices: SliceScopeSnap[] }

/** Slice state glyph (mock: ● building/spec · ✓ delivery-locked · ⊙ other/idle). */
export function sliceGlyph(s: SliceScopeSnap): string {
  if (s.locks.delivery) return "✓";
  if (s.stage === "building" || s.status === "building" || s.status === "spec") return "●";
  return "⊙";
}

/** The founder lock-glyph form: `proof: N/M 🔒` ONLY when delivery-locked — no del token,
 *  no unproven suffix; the visible COUNT carries the honesty (4/6 🔒 shows partial). */
export function proofBadge(s: SliceScopeSnap): string {
  const base = `proof: ${s.proof.paired}/${s.proof.total}`;
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
      label: `${indent}${open ? "▾" : "▸"} ${m.mission}`,
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
    const evidence: Array<{ text: string; token: Token }> = [];
    if (item.drops.length === 0) evidence.push({ text: "not recorded", token: "warn" });
    for (const drop of item.drops) {
      evidence.push({ text: `↳ ${(drop.artifactType ?? "drop").toUpperCase()} ${drop.verdict ?? ""}`.trimEnd(), token: drop.verdict === "PASS" || drop.verdict === "CLEAR" ? "ok" : "dim" });
      evidence.push(...wrapText(drop.file, evidenceW).map((text) => ({ text, token: "dim" as Token })));
      for (const media of drop.media) evidence.push(...wrapText(`media ${media}`, evidenceW).map((text) => ({ text, token: "dim" as Token })));
    }
    const count = Math.max(requirements.length, evidence.length, 1);
    for (let i = 0; i < count; i += 1) {
      lines.push(column(
        i === 0 ? (item.paired ? "PROVED" : "OPEN") : "",
        i === 0 ? String(item.index) : "",
        requirements[i] ?? "",
        evidence[i]?.text ?? "",
        item.paired ? "ok" : "warn",
        evidence[i]?.token ?? "dim",
      ));
    }
  }
  return lines;
}

function proofStack(detail: SliceScopeSnap, width: number): ContentLine[] {
  const lines: ContentLine[] = [];
  for (const item of detail.proofContract) {
    const status = item.paired ? "PROVED" : "OPEN";
    lines.push(semantic([
      { text: `  REQ ${item.index} · `, token: "accentBright", bold: true },
      { text: status, token: item.paired ? "ok" : "warn", bold: true },
    ], width));
    lines.push(...wrapped(item.text, width, "    "));
    if (item.drops.length === 0) {
      lines.push(semantic([{ text: "    EVIDENCE · ", token: "dim" }, { text: "not recorded", token: "warn" }], width));
      continue;
    }
    lines.push(semantic([{ text: "    EVIDENCE", token: "dim", bold: true }], width));
    for (const drop of item.drops) {
      lines.push(semantic([
        { text: "    ↳ ", token: "chrome" },
        { text: (drop.artifactType ?? "drop").toUpperCase(), token: "accentBright" },
        { text: ` ${drop.verdict ?? ""}`.trimEnd(), token: drop.verdict === "PASS" || drop.verdict === "CLEAR" ? "ok" : "dim" },
      ], width));
      lines.push(...wrapped(drop.file, width, "    ", "dim"));
      for (const media of drop.media) lines.push(...wrapped(`media ${media}`, width, "    ", "dim"));
    }
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
  const lines: ContentLine[] = [];
  const w = Math.max(24, width);
  const stage = detail.stage ?? detail.status ?? "unknown";
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
  const lines: ContentLine[] = [];
  const w = Math.max(24, opts.width);
  if (opts.narrative) {
    lines.push({ text: "" }, rule("PROGRESS · narrative only · n closes", w));
    for (const l of (detail.narrative ?? "(no PROGRESS.md)").split("\n")) lines.push(...wrapped(l, w, "  "));
    return lines;
  }

  lines.push({ text: "" }, rule("INTENT", w));
  lines.push(...wrapped(detail.intent, w, "  "));

  lines.push({ text: "" }, rule(`REQUIREMENTS (${detail.miniRequirements.length}) · m collapses`, w));
  if (!opts.collapseReqs) {
    detail.miniRequirements.forEach((requirement, i) => {
      const chunks = wrapText(requirement, Math.max(1, w - 5));
      chunks.forEach((chunk, j) => lines.push(semantic([
        { text: j === 0 ? `  ${i + 1}  ` : "     ", token: j === 0 ? "accentBright" : undefined, bold: j === 0 },
        { text: chunk, token: "bright" },
      ], w)));
    });
  } else {
    lines.push(semantic([{ text: "  collapsed · m expands", token: "dim" }], w));
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
  lines.push(...scopeContractLines(detail, opts));
  lines.push({ text: "" }, semantic([{
    text: opts.narrative ? "  esc back · n narrative · m reqs · : command bar" : "  esc back · m collapse reqs · n narrative · : command bar",
    token: "dim",
  }], w));
  return lines;
}
