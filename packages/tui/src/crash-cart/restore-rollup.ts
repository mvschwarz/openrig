// B1 (H4) — parse the `rig crash-cart restore-fleet --json` rollup and summarize it for the
// operator. The ⏎ RESTORE EVERYTHING drive returns this JSON; main.ts MUST surface it (the prior
// wave discarded it — the built-but-not-connected defect). After a restore the daemon is UP and the
// cockpit is gone, so the summary rides the persistent notice line (survives the refresh to normal TUI).
// The verdict + counts + attention needs + not_attempted reason/remediation all reach the operator.

/** The daemon rollup shape (mirrors the conductor's FleetRollup + derived verdict). */
export interface RestoreRollupModel {
  verdict: string;
  counts: { fully_restored: number; partially_restored: number; failed: number; not_attempted: number };
  attention: Array<{ rigId: string; seat: string; need: string }>;
  /** not_attempted rigs carry WHY + the fix (R3) — never a blank skip. */
  notAttempted: Array<{ rigId: string; reason?: string; remediation?: string }>;
}

interface RawRollupPayload {
  verdict?: unknown;
  rollup?: {
    counts?: Record<string, unknown>;
    sequence?: Array<{ rigId?: unknown; outcome?: unknown; reason?: unknown; remediation?: unknown }>;
    attention_required?: Array<{ rigId?: unknown; seat?: unknown; need?: unknown }>;
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parse the drive's JSON stdout into a rollup model, or null if it isn't a rollup payload
 *  (empty stdout, an error object, or malformed JSON) — the caller then stays honest-silent. */
export function parseRestoreRollup(json: string): RestoreRollupModel | null {
  let raw: RawRollupPayload;
  try {
    raw = JSON.parse(json) as RawRollupPayload;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !raw.rollup || typeof raw.verdict !== "string") return null;
  const counts = raw.rollup.counts ?? {};
  const attention = (raw.rollup.attention_required ?? [])
    .filter((a) => typeof a?.rigId === "string" && typeof a?.seat === "string" && typeof a?.need === "string")
    .map((a) => ({ rigId: a.rigId as string, seat: a.seat as string, need: a.need as string }));
  const notAttempted = (raw.rollup.sequence ?? [])
    .filter((r) => r?.outcome === "not_attempted")
    .map((r) => ({
      rigId: String(r.rigId ?? "?"),
      reason: typeof r.reason === "string" ? r.reason : undefined,
      remediation: typeof r.remediation === "string" ? r.remediation : undefined,
    }));
  return {
    verdict: raw.verdict,
    counts: {
      fully_restored: num(counts.fully_restored),
      partially_restored: num(counts.partially_restored),
      failed: num(counts.failed),
      not_attempted: num(counts.not_attempted),
    },
    attention,
    notAttempted,
  };
}

/** One honest line for the notice channel: verdict + counts, then the attention needs (seat@rig — need)
 *  and the not_attempted reasons (rig — reason: remediation). Complete, not truncated at the source. */
export function summarizeRestoreRollup(m: RestoreRollupModel): string {
  const c = m.counts;
  const parts = [
    `Fleet restore: ${m.verdict} — ${c.fully_restored} restored`,
    c.partially_restored ? `${c.partially_restored} partial` : null,
    c.failed ? `${c.failed} failed` : null,
    c.not_attempted ? `${c.not_attempted} not-attempted` : null,
  ].filter(Boolean);
  let line = parts.join(" / ");
  if (m.attention.length > 0) {
    line += " · attention: " + m.attention.map((a) => `${a.seat}@${a.rigId} — ${a.need}`).join("; ");
  }
  const withReason = m.notAttempted.filter((r) => r.reason);
  if (withReason.length > 0) {
    line +=
      " · not attempted: " +
      withReason.map((r) => `${r.rigId} — ${r.reason}${r.remediation ? ` (${r.remediation})` : ""}`).join("; ");
  }
  return line;
}
