/** Compact-row display only: neither an authored summary nor a claim about the whole body. */
export const QUEUE_DISPLAY_PREFIX_UNITS = 1024;
const DISPLAY_UNITS = 160;

/** One bounded line rule. Body candidates need a word and lose leading Markdown markers;
 * explicit summaries and ids keep their own text. The stored content is never rewritten. */
export function queueLabelLine(text: string | null | undefined, maxUnits: number, fromBody = false): string {
  const prefix = (text ?? "").slice(0, QUEUE_DISPLAY_PREFIX_UNITS).replace(/[\uD800-\uDBFF]$/u, "");
  const line = prefix.split(/\r\n|[\r\n\u2028\u2029]/u).map(part => {
    const clean = part.replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f]/g, "");
    return (fromBody ? clean.replace(/^[\s#>*+-]+/, "") : clean).trim();
  }).find(part => fromBody ? /[\p{L}\p{N}]/u.test(part) : part.length > 0) ?? "";
  return line.length > maxUnits
    ? line.slice(0, maxUnits - 1).replace(/[\uD800-\uDBFF]$/u, "") + "…" : line;
}

export function queueDisplayText(summary: string | null | undefined, bodyPrefix: string, qitemId: string): string {
  // An unhelpful prefix says nothing about the rest of the body. The id is an honest fallback.
  return queueLabelLine(summary, DISPLAY_UNITS) || queueLabelLine(bodyPrefix, DISPLAY_UNITS, true)
    || queueLabelLine(qitemId, DISPLAY_UNITS) || "Queue item";
}
