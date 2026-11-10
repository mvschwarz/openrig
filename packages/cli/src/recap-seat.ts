import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSessionName } from "./session-name.js";

/** Where `rig context recap-write` writes a recap: `rigs/<rig>/seats/<seat>`, where `<seat>` is the folder every recap
 *  reader uses, the part of the seat's session name before `@`. Without --rig or --seat it's the calling seat
 *  (OPENRIG_SESSION_NAME). The calling seat's own member id or logical id, and any logical id (`pod.member`; pod and
 *  member ids have no dots), map to that folder, so a recap isn't left under a name nothing reads. Any other name is
 *  written as given. The notes say what was mapped, or that a new folder may not be the one OpenRig reads. */
export function resolveRecapSeat(opts: { rig?: string; seat?: string; sessionName?: string; topologyRoot: string }):
  { rig: string; seat: string; notes: string[] } | { error: string } {
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
  const logical = /^[^.]+\.[^.]+$/.test(given) ? given.replace(".", "-") : undefined;
  if (self && given !== self && (logical === self || self.endsWith(`-${given}`))) {
    return { rig, seat: self, notes: [`--seat ${given} names this seat (${opts.sessionName}), so the recap goes to seats/${self}, the folder OpenRig reads its recap from.`] };
  }
  if (logical) {
    return { rig, seat: logical, notes: [`--seat ${given} is a logical id, so the recap goes to seats/${logical}, the folder OpenRig reads that seat's recap from (the part of its session name before @).`] };
  }
  const seatsDir = join(opts.topologyRoot, "rigs", rig, "seats");
  if (existsSync(join(seatsDir, given))) return { rig, seat: given, notes: [] };
  let likely: string[] = [];
  try { likely = readdirSync(seatsDir).filter((name) => name.endsWith(`-${given}`)); } catch { /* no seats folder yet */ }
  const hint = likely.length ? ` ${likely.map((name) => `seats/${name}`).join(", ")} ${likely.length === 1 ? "exists" : "exist"}.` : "";
  return { rig, seat: given, notes: [`seats/${given} didn't exist in rig ${rig}, so this write created it. OpenRig reads a seat's recap from the folder named by the part of its session name before @.${hint}`] };
}
