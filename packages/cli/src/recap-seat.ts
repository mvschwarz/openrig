import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSessionName } from "./session-name.js";

/** One of the rig's seats as the daemon records it: its logical id, its member id within its pod, and its folder, the
 *  part of its session name before `@`, which every recap reader uses. */
export interface RigSeat { logicalId: string; member: string; folder: string }

/** Where `rig context recap-write` writes a recap: `rigs/<rig>/seats/<seat>`. Without --rig or --seat it's the calling
 *  seat's folder (OPENRIG_SESSION_NAME). A name that is a seat's folder, or the caller's own, is used as given. Another
 *  name maps to a seat's folder only when it is exactly one seat's recorded logical id or member id in the rig's seats,
 *  so neither a suffix nor a dot is taken as identity. When the seats can't be read, or nothing matches, the name is
 *  written as given and a note says what was and wasn't checked. Nothing is refused. */
export function resolveRecapSeat(opts: { rig?: string; seat?: string; sessionName?: string; topologyRoot: string;
  seats?: RigSeat[] | { unavailable: string } }): { rig: string; seat: string; notes: string[] } | { error: string } {
  const own = opts.sessionName ? parseSessionName(opts.sessionName) : undefined;
  const ownRig = own?.kind === "canonical" ? own.rig : undefined;
  const rig = opts.rig ?? ownRig;
  if (!rig) return { error: "Name the rig with --rig: OPENRIG_SESSION_NAME isn't set, so there's no seat to default to." };
  const self = own?.kind === "canonical" && rig === own.rig ? own.member : undefined;
  if (opts.seat === undefined) {
    if (!self) return { error: `Name the seat with --seat: the part of its session name before @ (dev-qa for dev-qa@${rig}).` };
    return { rig, seat: self, notes: [] };
  }
  const given = opts.seat;
  if (given === self) return { rig, seat: given, notes: [] };
  const fresh = !existsSync(join(opts.topologyRoot, "rigs", rig, "seats", given));
  const where = "OpenRig reads a seat's recap from the folder named by the part of its session name before @.";
  if (!opts.seats || "unavailable" in opts.seats) {
    const why = opts.seats && "unavailable" in opts.seats ? ` (${opts.seats.unavailable})` : "";
    return { rig, seat: given, notes: [`${fresh ? `seats/${given} didn't exist in rig ${rig}, so this write created it, and the` : `The recap went to the existing seats/${given} as given, but the`} name couldn't be checked against the rig's seats${why}. ${where}`] };
  }
  if (opts.seats.some((seat) => seat.folder === given)) return { rig, seat: given, notes: [] };
  const matches = opts.seats.filter((seat) => seat.logicalId === given || seat.member === given);
  if (matches.length === 1) {
    const [seat] = matches;
    const kind = seat!.logicalId === given ? "logical id" : "member id";
    return { rig, seat: seat!.folder, notes: [`--seat ${given} is the ${kind} of ${seat!.folder}@${rig}, so the recap goes to seats/${seat!.folder}, the folder OpenRig reads its recap from.`] };
  }
  const named = matches.length ? ` It's the logical or member id of ${matches.map((seat) => `seats/${seat.folder}`).join(" and ")}, so it wasn't mapped; name one of them.` : "";
  return { rig, seat: given, notes: [`seats/${given} ${fresh ? `didn't exist in rig ${rig}, so this write created it` : `isn't one of rig ${rig}'s seat folders`}. ${where}${named}`] };
}
