/**
 * Seats that would resume the same recorded conversation (#3218 item 3).
 *
 * This is a reported gap, not a restore guard: a restore still resumes each seat as recorded. The caller decides which
 * seats count (running ones for restore-check, the resuming occupants of a snapshot for restore); this module only
 * groups them by resume type and token and words the report, so the person can decide what to do.
 */

export interface ConversationSeat {
  /** How the seat is named in the report (a session name, or a logical id within one rig). */
  seat: string;
  resumeType: string | null | undefined;
  resumeToken: string | null | undefined;
}

export interface SharedConversation {
  resumeType: string;
  resumeToken: string;
  /** Two or more distinct seats, sorted. */
  seats: string[];
}

export function findSharedConversations(seats: readonly ConversationSeat[]): SharedConversation[] {
  const groups = new Map<string, SharedConversation>();
  for (const entry of seats) {
    const resumeType = entry.resumeType?.trim();
    const resumeToken = entry.resumeToken?.trim();
    if (!resumeType || resumeType === "none" || !resumeToken) continue;
    const key = `${resumeType}\u0000${resumeToken}`;
    let group = groups.get(key);
    if (!group) {
      group = { resumeType, resumeToken, seats: [] };
      groups.set(key, group);
    }
    if (!group.seats.includes(entry.seat)) group.seats.push(entry.seat);
  }
  return [...groups.values()]
    .filter((group) => group.seats.length > 1)
    .map((group) => ({ ...group, seats: [...group.seats].sort() }))
    .sort((a, b) => a.seats[0]!.localeCompare(b.seats[0]!) || a.resumeToken.localeCompare(b.resumeToken));
}

function listSeats(seats: readonly string[]): string {
  return seats.length <= 2 ? seats.join(" and ") : `${seats.slice(0, -1).join(", ")} and ${seats[seats.length - 1]}`;
}

export function describeSharedConversation(group: SharedConversation): string {
  return `${listSeats(group.seats)} carry the same ${group.resumeType} conversation ${group.resumeToken}; `
    + "a restore resumes it in each of them as recorded. Decide which seat should keep it.";
}
