// The bare body of a queue wake nudge (create / handoff / handoff-and-complete).
// `wrapPaneEnvelope` wraps it in the From/To/---/body/---/↩ Reply envelope.
//
// When the qitem has a stored summary, the nudge carries a bounded one-line copy so
// the recipient knows what arrived without a second queue read. The durable row stays
// authoritative: the body never rides the nudge, and sanitizing here never rewrites
// the stored summary.
//
// The summary is author-supplied text typed into another seat's pane, so it must not
// be able to alter the envelope or hide text in it: every control character (C0,
// DEL, C1), Unicode line/paragraph separator and invisible format character
// (zero-width, direction marks, bidi overrides, tag characters) becomes a space.
// With no line break left, the summary stays on the body line after the fixed
// "Queue handoff:" prefix and cannot forge a `---`, From:, Sent: or ↩ Reply line.

/** Longest summary the nudge carries, in code points (including the ellipsis). */
export const QUEUE_NUDGE_SUMMARY_MAX_CHARS = 120;

const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function boundSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const flat = summary.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  // Array.from splits by code point so the cut never leaves half a surrogate pair.
  const chars = Array.from(flat);
  if (chars.length <= QUEUE_NUDGE_SUMMARY_MAX_CHARS) return flat;
  return `${chars.slice(0, QUEUE_NUDGE_SUMMARY_MAX_CHARS - 1).join("").trimEnd()}…`;
}

export function renderQueueHandoffNudge(qitemId: string, summary: string | null | undefined): string {
  const generic = `Queue handoff: ${qitemId} - check your queue.`;
  const bounded = boundSummary(summary);
  return bounded === null ? generic : `${generic} Summary: ${bounded}`;
}
