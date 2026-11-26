/** Compact-row display only: neither an authored summary nor a claim about the whole body. */
export const QUEUE_DISPLAY_PREFIX_UNITS = 1024;
const DISPLAY_UNITS = 160;

function firstLine(text: string | null | undefined): string {
  // Bound work before splitting/trimming. Do not expose half of a surrogate pair at the boundary.
  const prefix = (text ?? "").slice(0, QUEUE_DISPLAY_PREFIX_UNITS).replace(/[\uD800-\uDBFF]$/u, "");
  const line = (prefix.split(/\r\n|[\r\n\u2028\u2029]/u).find(part => part.trim()) ?? "").trim().replace(/\s+/gu, " ");
  return line.length > DISPLAY_UNITS
    ? line.slice(0, DISPLAY_UNITS - 1).replace(/[\uD800-\uDBFF]$/u, "") + "…" : line;
}

export function queueDisplayText(summary: string | null | undefined, bodyPrefix: string, qitemId: string): string {
  // An unhelpful prefix says nothing about the rest of the body. The id is an honest fallback.
  return firstLine(summary) || firstLine(bodyPrefix) || firstLine(qitemId) || "Queue item";
}
