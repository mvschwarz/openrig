// The text an ordinary park timer's wake carries about the park's recorded continuation. The default wake names the
// row only; with a continuation recorded, the wake also shows a bounded preview of it, so the woken owner sees what
// it said it would do next without first opening the row.

import { NOTED_ON_PARKED_ROW } from "./watchdog-history-log.js";

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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A park's default wake (queue-repository.ts defaultParkWakeMessage), for any row, exactly or with its continuation's
 *  preview (withContinuationPreview). */
const DEFAULT_PARK_WAKE = new RegExp(
  "^Wake timer fired for parked qitem \\S+\\. Resume the recorded continuation and update the row\\."
  + "(?:\\nRecorded continuation(?: \\(the first \\d+ of \\d+ characters; read the rest with rig queue show \\S+ --full\\))?: [^\\n]*"
  + `\\n${escapeRegExp(PARK_WAKE_GUIDANCE)})?$`,
);

/** Whether a reminder is a park's default wake, for any row: a timer shared by --wake-watchdog carries the default of
 *  the row that armed it. Any other text, also after the default, is the reminder's own. */
export function isDefaultParkWakeMessage(message: string): boolean {
  return DEFAULT_PARK_WAKE.test(message);
}

/** The most of a reminder's own text one queue note keeps; the rest stays in the job's history (rig watchdog show). */
export const REMINDER_NOTE_MAX_CHARS = 2000;

/** The first `max` UTF-16 units of `text`, one fewer when the last would be half of a surrogate pair. */
export function sliceWholeChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

/** A reminder's text for a queue note, cut past REMINDER_NOTE_MAX_CHARS (never inside a surrogate pair) with a pointer
 *  to the job's full text. */
export function cutReminderForNote(message: string, jobId: string): string {
  if (message.length <= REMINDER_NOTE_MAX_CHARS) return message;
  return `${sliceWholeChars(message, REMINDER_NOTE_MAX_CHARS)}… (full text: rig watchdog show ${jobId})`;
}

/** How a queue-only seat's park wake note on its parked row starts (#3076); the queue's park record finds it by this. */
export function parkedRowNotePrefix(jobId: string): string {
  return `park wake noted on this row: watchdog ${jobId};`;
}

/** The park record on a row bound to the job but owned by another seat than the one a queue-only reminder went to
 *  (#3076): what the reminder became instead of typed input, with the queue row it became or was noted on. */
export function queuedAsRowNote(jobId: string, deliveryStatus: string, queuedQitemId?: string): string {
  return `park wake queued as row: watchdog ${jobId}; delivery=${deliveryStatus}${queuedQitemId ? ` ${queuedQitemId}` : ""}; nothing typed; awaiting owner consumption`;
}

/** A queue-only seat's park wake, noted on the parked row it is about instead of typed (#3076): with the reminder's own
 *  text, unless it is the park's default wake. */
export function parkedRowNote(jobId: string, reminder?: string): string {
  const own = reminder?.trim();
  return `${parkedRowNotePrefix(jobId)} delivery=${NOTED_ON_PARKED_ROW}; nothing typed; awaiting owner consumption`
    + (own && !isDefaultParkWakeMessage(own) ? `\nreminder: ${cutReminderForNote(own, jobId)}` : "");
}

/** A single park wake: its message, then, when the current park recorded a continuation, the preview and how to act
 *  on it. Without one the message is unchanged. */
export function withContinuationPreview(message: string, qitemId: string, continuation: string | null | undefined): string {
  const recorded = continuation?.trim();
  if (!recorded) return message;
  return [message, parkContinuationPreview(qitemId, recorded), PARK_WAKE_GUIDANCE].join("\n");
}
