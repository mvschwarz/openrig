import type Database from "better-sqlite3";
import { memberConnection, type MemberConnection } from "./connection-contract.js";
import type { QueueRepository } from "./queue-repository.js";
import { resolveGuardTarget } from "./seat-delivery-guard.js";
import { isHumanSeatSessionRef } from "./session-name.js";
import { resolveCurrentSessionAddress } from "./session-registry.js";

/** The connection an address is reached on, as this daemon resolves it: a person (the gateway), a hosted member (its
 *  trigger), else the seat it addresses, read by seat rather than by the newest session row with that name, live when
 *  its current session runs. An address none of them has reads every capability unknown, with the reason. */
export function resolveMemberConnection(db: Database.Database, queue: Pick<QueueRepository, "isPersonAddress" | "isHostedMember"> | undefined,
  member: string): MemberConnection {
  if (isHumanSeatSessionRef(member) || queue?.isPersonAddress(member)) return memberConnection(member, { kind: "person" });
  if (queue?.isHostedMember(member)) return memberConnection(member, { kind: "hosted" });
  const target = resolveGuardTarget(db, member);
  if (!target) return memberConnection(member, { kind: "none", reason: "no seat, hosted member or registered person has this address on this daemon" });
  const node = db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(target.nodeId) as { runtime: string | null } | undefined;
  return memberConnection(member, { kind: "seat", runtime: node?.runtime ?? null,
    live: resolveCurrentSessionAddress(db, member)?.nodeId === target.nodeId });
}
