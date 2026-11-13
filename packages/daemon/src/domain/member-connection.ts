import type Database from "better-sqlite3";
import { memberConnection, type MemberConnection } from "./connection-contract.js";
import { resolveRegisteredHumanAddress } from "./gateway/human-registry.js";
import type { QueueRepository } from "./queue-repository.js";
import { resolveGuardTarget } from "./seat-delivery-guard.js";
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";
import { resolveCurrentSessionAddress } from "./session-registry.js";

/** The connection an address is reached on, as this daemon resolves it: a person (the gateway), a hosted member (its
 *  trigger), else the seat it addresses, read by seat rather than by the newest session row with that name, and live
 *  when a session is recorded as its current one (a record, not an observed pane). A person is one the human registry
 *  resolves, or the reserved terminal person's seat (`human@host`, `human-<x>@kernel|host`); an address shaped like a
 *  person's (`<id>@external`) that the registry doesn't resolve isn't one. An address none of them has, or any address
 *  when the registry can't be read, reads every capability unknown, with the reason. */
export function resolveMemberConnection(db: Database.Database, queue: Pick<QueueRepository, "humanRegistry" | "isHostedMember"> | undefined,
  member: string): MemberConnection {
  const terminalPersonSeat = isHumanSeatSessionRef(member) && parseSessionName(member).kind !== "external";
  const registry = queue?.humanRegistry();
  if (terminalPersonSeat || (registry?.ok && resolveRegisteredHumanAddress(member, registry.entities) !== null)) {
    return memberConnection(member, { kind: "person" });
  }
  if (isHumanSeatSessionRef(member) && !registry?.ok) {
    return memberConnection(member, { kind: "none", reason: "the person registry couldn't be read, so whether a person has this address is unknown" });
  }
  if (queue?.isHostedMember(member)) return memberConnection(member, { kind: "hosted" });
  const target = resolveGuardTarget(db, member);
  if (!target) return memberConnection(member, { kind: "none", reason: "no seat, hosted member or registered person has this address on this daemon" });
  const node = db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(target.nodeId) as { runtime: string | null } | undefined;
  return memberConnection(member, { kind: "seat", runtime: node?.runtime ?? null,
    live: resolveCurrentSessionAddress(db, member)?.nodeId === target.nodeId });
}
