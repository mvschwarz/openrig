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
    const known = typeof member.status === "string" && member.status in CHECK_IN_DISPLAY;
    return [{ seat: member.seat, checkIn: {
      status: known ? member.status as CheckInStatus : "unknown",
      lastCheckInAt: typeof member.lastCheckInAt === "string" ? member.lastCheckInAt : null,
      expectedMinutes: typeof member.expectedMinutes === "number" ? member.expectedMinutes : null,
      onRequest: member.onRequest === true,
      ...(known && typeof member.reason === "string" ? { reason: member.reason } : {}),
    } }];
  });
}

/** The connected assistants under a seat table, each with its check-in line in the daemon's words and the time in the
 *  viewer's zone; only one rig's when `rig` is given. Nothing when there are none. */
export function connectedAssistantLines(assistants: ConnectedAssistant[] | undefined, rig: string | null, filter: string | null,
  width: number, timeZone?: string): ContentLine[] {
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
