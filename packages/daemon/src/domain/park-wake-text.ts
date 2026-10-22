// The text an ordinary park timer's wake carries about the park's recorded continuation. The default wake names the
// row only; with a continuation recorded, the wake also shows a bounded preview of it, so the woken owner sees what
// it said it would do next without first opening the row.

/** How much of a park's recorded continuation its wake shows. */
export const PARK_WAKE_PREVIEW_CHARS = 300;

/** A park's recorded continuation, labelled and on one line. Past PARK_WAKE_PREVIEW_CHARS it's cut, says so, and
 *  names the command that shows the rest. */
export function parkContinuationPreview(qitemId: string, continuation: string): string {
  const flat = continuation.replace(/\s+/g, " ").trim();
  if (flat.length <= PARK_WAKE_PREVIEW_CHARS) return `Recorded continuation: ${flat}`;
  return `Recorded continuation (the first ${PARK_WAKE_PREVIEW_CHARS} of ${flat.length} characters; read the rest with `
    + `rig queue show ${qitemId} --full): ${flat.slice(0, PARK_WAKE_PREVIEW_CHARS)}…`;
}

/** How a woken owner acts on a previewed continuation. */
export const PARK_WAKE_GUIDANCE = "Check the row's current state and blocker first, then resume only that recorded work and record the "
  + "outcome, or park it again with a wake. Work already done is recorded, not repeated.";

/** A single park wake: its message, then, when the current park recorded a continuation, the preview and how to act
 *  on it. Without one the message is unchanged. */
export function withContinuationPreview(message: string, qitemId: string, continuation: string | null | undefined): string {
  const recorded = continuation?.trim();
  if (!recorded) return message;
  return [message, parkContinuationPreview(qitemId, recorded), PARK_WAKE_GUIDANCE].join("\n");
}
