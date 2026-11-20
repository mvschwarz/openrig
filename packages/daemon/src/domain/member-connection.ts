import type Database from "better-sqlite3";
import { memberConnection, type MemberConnection } from "./connection-contract.js";
import { registeredPeople, resolveRegisteredHumanAddress } from "./gateway/human-registry.js";
import type { QueueRepository } from "./queue-repository.js";
import { resolveGuardTarget } from "./seat-delivery-guard.js";
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";
import { resolveCurrentSessionAddress } from "./session-registry.js";

/** The connection an address is reached on, as this daemon resolves it: a person (the gateway), a hosted member (its
 *  trigger), else the seat it addresses, read by seat rather than by the newest session row with that name, and live
 *  when a session is recorded as its current one (a record, not an observed pane). A person is one the human registry
 *  resolves, or the reserved terminal person's seat (`human@host`, `human-<x>@kernel|host`); an address shaped like a
 *  person's (`<id>@external`) that the registry doesn't resolve isn't one. A person is resolved before a hosted member
 *  or seat, as the queue does, so when the registry can't be read, any spelling it could resolve to a person (an
 *  `@external` address or a canonical `member@rig`) reads unknown rather than as whatever else has that name. Nobody
 *  registered yet is a readable registry with no one in it. An address none of them has reads every capability
 *  unknown too, with its own reason. */
export function resolveMemberConnection(db: Database.Database, queue: Pick<QueueRepository, "humanRegistry" | "isHostedMember"> | undefined,
  member: string): MemberConnection {
  const parsed = parseSessionName(member);
  const terminalPersonSeat = isHumanSeatSessionRef(member) && parsed.kind !== "external";
  const people = queue ? registeredPeople(queue.humanRegistry()) : null;
  if (terminalPersonSeat || (people && resolveRegisteredHumanAddress(member, people) !== null)) {
    return memberConnection(member, { kind: "person" });
  }
  if (!people && (parsed.kind === "external" || parsed.kind === "canonical")) {
    return memberConnection(member, { kind: "none", reason: "the person registry couldn't be read, so whether a person has this address is unknown" });
  }
  if (queue?.isHostedMember(member)) return memberConnection(member, { kind: "hosted" });
  const target = resolveGuardTarget(db, member);
  if (!target) return memberConnection(member, { kind: "none", reason: "no seat, hosted member or registered person has this address on this daemon" });
  const node = db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(target.nodeId) as { runtime: string | null } | undefined;
  return memberConnection(member, { kind: "seat", runtime: node?.runtime ?? null,
    live: resolveCurrentSessionAddress(db, member)?.nodeId === target.nodeId });
}
