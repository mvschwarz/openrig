import { CHECK_IN_DISPLAY, describeCheckIn, type CheckInStatus } from "@openrig/daemon/connection-contract";

type Row = Record<string, unknown>;

/** A connected assistant's check-in in one human line with its evidence, in the daemon's own words
 *  (`describeCheckIn`): "overdue: last check-in 13:05, expected every 60 min; its schedule may be off or waiting for an
 *  approval". Shared by `rig roster` and `rig ps`; a status this CLI doesn't know reads unknown. */
export function formatCheckIn(checkIn: Row): string {
  const known = typeof checkIn.status === "string" && checkIn.status in CHECK_IN_DISPLAY;
  return describeCheckIn({ status: known ? checkIn.status as CheckInStatus : "unknown",
    lastCheckInAt: typeof checkIn.lastCheckInAt === "string" ? checkIn.lastCheckInAt : null,
    expectedMinutes: typeof checkIn.expectedMinutes === "number" ? checkIn.expectedMinutes : null,
    onRequest: checkIn.onRequest === true,
    ...(known && typeof checkIn.reason === "string" ? { reason: checkIn.reason } : {}) });
}
