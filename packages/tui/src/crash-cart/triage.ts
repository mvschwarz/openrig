// Crash-cart C3 C4 — the post-run aggregate triage list (plan c015d9ed §C4). ONE keyboard-walkable
// list, never one blocking prompt per seat: each row = a seat + exactly what it needs (the failing
// restore-check's remediation). GREEN seats are omitted; red (needs action) before yellow (caveat).
// Sourced from the shipped restore-check CheckEntry evidence; the conductor aggregate (C1
// attention_required/resume_failed), the resolve→shipped-resume handoff, and the live restore-check
// fetch are seams (C1 excluded this wave). This is the model + render (no mock — a text list).
import type { Token } from "../theme.js";

export type TriageStatus = "red" | "yellow" | "green";

/** One seat's restore-check evidence (the tui-local view of the daemon's CheckEntry[] — parsed, so no
 *  @openrig/daemon dep; the light-TUI fence). */
export interface TriageCheckInput {
  seat: string;
  entries: Array<{
    check: string;
    status: TriageStatus;
    evidence: string;
    remediation: string;
    remediationSafe?: boolean;
  }>;
}

/** A triage row = a seat + the failing check it needs resolved. */
export interface TriageRow {
  seat: string;
  check: string;
  status: "red" | "yellow";
  /** What the seat needs (the remediation). */
  need: string;
  evidence: string;
  remediationSafe: boolean;
}

interface Seg {
  text: string;
  token?: Token;
  bold?: boolean;
}
interface Line {
  text: string;
  segs?: Seg[];
}
function line(segs: Seg[]): Line {
  return { text: segs.map((s) => s.text).join(""), segs };
}

/** Flatten per-seat failing checks into triage rows (green omitted); red before yellow. */
export function buildTriageModel(input: TriageCheckInput[]): TriageRow[] {
  const rows: TriageRow[] = [];
  for (const s of input) {
    for (const e of s.entries) {
      if (e.status === "green") continue;
      rows.push({
        seat: s.seat,
        check: e.check,
        status: e.status,
        need: e.remediation,
        evidence: e.evidence,
        remediationSafe: e.remediationSafe ?? false,
      });
    }
  }
  // Red (needs action) before yellow (caveat); JS sort is stable, so same-status order is preserved.
  return rows.sort((a, b) => (a.status === b.status ? 0 : a.status === "red" ? -1 : 1));
}

/** Render the triage list: a header + one row per need (seat + remediation, the check dim), or the
 *  all-clean line when nothing needs attention. */
export function renderTriage(rows: TriageRow[]): Line[] {
  if (rows.length === 0) {
    return [line([{ text: " ✓ ", token: "ok" }, { text: "all seats restored clean" }])];
  }
  const out: Line[] = [line([{ text: `NEEDS ATTENTION (${rows.length})`, token: "warn", bold: true }])];
  for (const r of rows) {
    const glyph = r.status === "red" ? "●" : "◌";
    const tok: Token = r.status === "red" ? "error" : "warn";
    out.push(
      line([
        { text: ` ${glyph} `, token: tok },
        { text: r.seat, token: "bright", bold: true },
        { text: ` — ${r.need}` },
        { text: ` (${r.check})`, token: "dim" },
      ]),
    );
  }
  return out;
}
