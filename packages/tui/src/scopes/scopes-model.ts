// SCOPES VIEW (sealed plan d64d2f5c; v4 mock ad8b64be = the render contract) — the pure
// model: explorer rows + content lines. STORE-DIRECT data only (the daemon projection);
// PROGRESS.md content renders ONLY in the `n` narrative panel, never in cards/counts.
import type { Action } from "../types.js";
import type { ContentLine } from "../detail.js";

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
): Array<{ label: string; action: Action; key: string }> {
  const rows: Array<{ label: string; action: Action; key: string }> = [];
  if (!scopes) return rows;
  for (const m of scopes) {
    const key = `scopes-mission:${m.mission}`;
    const open = expanded.has(key);
    rows.push({ label: `${indent}${open ? "▾" : "▸"} ${m.mission}`, action: { type: "toggle-expand", key }, key });
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

function box(title: string, suffix: string, width: number): string {
  const head = `┌─ ${title} `;
  const tail = suffix ? `${suffix} ─┐` : "─┐";
  const fill = Math.max(1, width - head.length - tail.length);
  return `${head}${"─".repeat(fill)} ${tail}`.slice(0, width + 8);
}

export function scopesContentLines(
  detail: SliceScopeSnap | null,
  mission: string | null,
  opts: { collapseReqs: boolean; narrative: boolean; width: number },
): ContentLine[] {
  const lines: ContentLine[] = [];
  if (!detail) {
    lines.push({ text: "select a slice from the SCOPES tree (missions → slices)" });
    return lines;
  }
  const w = Math.max(60, opts.width - 4);

  // Header card (mock line 1): ● name ── mission ── stage ── proof N/M[ 🔒] ── ...
  lines.push({ text: `┌─ ${sliceGlyph(detail)} ${detail.dirName} ── ${mission ?? "?"} ── stage: ${detail.stage ?? "?"} ── ${proofBadge(detail)} ─┐` });
  const specLock = detail.locks.spec
    ? `spec🔒 ${detail.locks.spec.at.slice(5, 10)} by ${detail.locks.spec.by.split("@")[0]}${detail.prdExists ? " · PRD: p" : ""}`
    : "spec: UNLOCKED (build-ahead; ratifies at PM recovery)";
  lines.push({ text: `│ ${specLock}` });
  lines.push({ text: `└${"─".repeat(Math.min(w, 78))}┘` });

  if (opts.narrative) {
    // The `n` panel: PROGRESS.md as the human LOG — display only, never a data source.
    lines.push({ text: box("PROGRESS (narrative — display only)", "n closes", w) });
    for (const l of (detail.narrative ?? "(no PROGRESS.md)").split("\n")) lines.push({ text: `│ ${l}` });
    lines.push({ text: `└${"─".repeat(Math.min(w, 78))}┘` });
    lines.push({ text: "  esc back · n narrative · m reqs · : command bar" });
    return lines;
  }

  lines.push({ text: box("INTENT (verbatim)", "", w) });
  for (const l of detail.intent.split("\n")) lines.push({ text: `│ ${l}` });
  lines.push({ text: `└${"─".repeat(Math.min(w, 78))}┘` });

  lines.push({ text: box(`MINI-REQUIREMENTS (${detail.miniRequirements.length})`, "m collapses", w) });
  if (!opts.collapseReqs) {
    detail.miniRequirements.forEach((r, i) => lines.push({ text: `│ ${i + 1} ${r}` }));
  } else {
    lines.push({ text: `│ (collapsed — m expands)` });
  }
  lines.push({ text: `└${"─".repeat(Math.min(w, 78))}┘` });

  lines.push({ text: box(`PROOF CONTRACT (${detail.proof.paired}/${detail.proof.total} paired)`, "", w) });
  for (const item of detail.proofContract) {
    lines.push({ text: `│ ${item.paired ? "✓" : "○"} ${item.index} ${item.text}` });
    for (const d of item.drops) {
      const media = d.media.length ? ` · ${d.media.join(" · ")}` : "";
      lines.push({ text: `│   └ C1 drop · ${d.artifactType ?? "?"} ${d.verdict ?? ""} · ${d.file}${media}` });
    }
  }
  lines.push({ text: `└${"─".repeat(Math.min(w, 78))}┘` });
  lines.push({ text: "  esc back · m collapse reqs · n narrative · : command bar" });
  return lines;
}
