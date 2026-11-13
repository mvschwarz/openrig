import { CHECK_IN_DISPLAY, describeCheckIn, type CheckInStatus } from "@openrig/daemon/connection-contract";
import { wrapDetailLines, type ContentLine } from "./detail.js";
import { displayTime } from "./time.js";
import type { ConnectedAssistant } from "./types.js";

/** The hosted-members answer as connected assistants; null when it isn't one. A status this TUI doesn't know reads
 *  unknown, as in `rig ps`. */
export function toConnectedAssistants(body: unknown): ConnectedAssistant[] | null {
  const members = (body as { members?: unknown } | null)?.members;
  if (!Array.isArray(members)) return null;
  return members.flatMap((member: Record<string, unknown>) => {
    if (typeof member?.seat !== "string" || !member.seat) return [];
    const known = typeof member.status === "string" && Object.hasOwn(CHECK_IN_DISPLAY, member.status);
    return [{ seat: member.seat, checkIn: {
      status: known ? member.status as CheckInStatus : "unknown",
      lastCheckInAt: typeof member.lastCheckInAt === "string" ? member.lastCheckInAt : null,
      expectedMinutes: typeof member.expectedMinutes === "number" ? member.expectedMinutes : null,
      onRequest: member.onRequest === true,
      ...(known && typeof member.reason === "string" ? { reason: member.reason } : {}),
    } }];
  });
}

/** The hosted-members read as the list, or why it couldn't be read, in `rig ps`'s words: an older daemon's 404, a failed
 *  read, or an answer that isn't one. A failed read isn't an empty list. */
export function connectedAssistantsOf(answer: { status: number; body: unknown }): { assistants: ConnectedAssistant[] } | { unavailable: string } {
  if (answer.status === 404) return { unavailable: "this daemon doesn't serve it" };
  if (answer.status >= 400) return { unavailable: `the read failed: HTTP ${answer.status}` };
  const assistants = toConnectedAssistants(answer.body);
  return assistants ? { assistants } : { unavailable: "the daemon's answer couldn't be read" };
}

/** The connected assistants under a seat table, each with its check-in line in the daemon's words and the time in the
 *  viewer's zone; only one rig's when `rig` is given. Nothing when there are none; one line saying check-in is
 *  unavailable, with the reason, when the list couldn't be read. */
export function connectedAssistantLines(assistants: ConnectedAssistant[] | undefined, unavailable: string | undefined, rig: string | null,
  filter: string | null, width: number, timeZone?: string): ContentLine[] {
  if (unavailable) return [{ text: "" }, ...wrapDetailLines([{ text: `Connected assistants: check-in unavailable (${unavailable})` }], width)];
  const shown = (assistants ?? [])
    .filter((a) => !rig || a.seat.endsWith(`@${rig}`))
    .filter((a) => !filter || a.seat.includes(filter));
  if (shown.length === 0) return [];
  return [
    { text: "" },
    { text: "Connected assistants (outside the terminal; each checks its own queue):" },
    ...wrapDetailLines(shown.map((a) => ({ text: `  ${a.seat}  ${describeCheckIn({ ...a.checkIn,
      lastCheckInAt: a.checkIn.lastCheckInAt === null ? null : displayTime(a.checkIn.lastCheckInAt, timeZone) })}` })), width),
  ];
}
