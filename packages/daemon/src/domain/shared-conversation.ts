/**
 * Agents that hold the same recorded conversation (#3218 item 3).
 *
 * This is a reported gap, not a restore guard: nothing is refused, stopped or picked, and restore's own result still
 * says what happened to each agent. The callers choose which agents count (rig restore-check: every agent with a
 * recorded, resumable conversation; restore: the agents it resumes and the known ones outside it); this module groups
 * them and words the report.
 *
 * The report never carries the resume token itself: restore's warnings reach the restore.completed event, and OpenRig
 * keeps raw resume tokens out of events. It names the agents and the resume type.
 *
 * The key is the exact resume type and token: the same conversation recorded under two types (a claude_name and a
 * claude_id for one Claude session) is not paired, a false negative accepted here. Saved data that is not text makes
 * the comparison unavailable for that agent; it never throws.
 */

export interface ConversationSeat {
  /** How the agent is named in the report. */
  seat: string;
  /** Its recorded session status as it is ("running", "exited", "detached"; "unknown" when none), said in the report. */
  state?: string;
  resumeType: unknown;
  resumeToken: unknown;
}

export interface SharedConversation {
  resumeType: string;
  /** Two or more distinct agents, sorted by name. The token stays out of this object. */
  seats: Array<{ seat: string; state?: string }>;
}

export interface ConversationComparison {
  groups: SharedConversation[];
  /** Agents whose saved resume type or token is not text: the comparison is unavailable for them. */
  unavailable: string[];
}

/**
 * Whether a known agent counts as holding its recorded conversation: a running agent holds it now, whatever its
 * restore policy; one that is not running only if it would resume it. A terminal never does.
 */
export function holdsRecordedConversation(entry: { runtime?: string | null; sessionStatus?: string | null; restorePolicy?: string | null }): boolean {
  if (entry.runtime === "terminal") return false;
  return entry.sessionStatus === "running" || (entry.restorePolicy ?? "resume_if_possible") === "resume_if_possible";
}

/** Whether an agent's saved resume data names a conversation the comparison can pair: a resume type other than none
 *  and a token, both text and not blank. Restore reads the agents outside it only when one of its own does (#3250). */
export function pairableConversation(seat: ConversationSeat): boolean {
  return typeof seat.resumeType === "string" && typeof seat.resumeToken === "string"
    && !!seat.resumeType.trim() && seat.resumeType.trim() !== "none" && !!seat.resumeToken.trim();
}

export function compareConversations(seats: readonly ConversationSeat[]): ConversationComparison {
  const groups = new Map<string, SharedConversation>();
  const unavailable: string[] = [];
  for (const entry of seats) {
    if (entry.resumeType == null || entry.resumeToken == null) continue;   // nothing recorded
    if (typeof entry.resumeType !== "string" || typeof entry.resumeToken !== "string") {
      if (!unavailable.includes(entry.seat)) unavailable.push(entry.seat);
      continue;
    }
    const resumeType = entry.resumeType.trim();
    const resumeToken = entry.resumeToken.trim();
    if (!resumeType || resumeType === "none" || !resumeToken) continue;
    const key = `${resumeType}\u0000${resumeToken}`;
    let group = groups.get(key);
    if (!group) {
      group = { resumeType, seats: [] };
      groups.set(key, group);
    }
    if (!group.seats.some((known) => known.seat === entry.seat)) group.seats.push({ seat: entry.seat, state: entry.state });
  }
  return {
    groups: [...groups.values()]
      .filter((group) => group.seats.length > 1)
      .map((group) => ({ ...group, seats: [...group.seats].sort((a, b) => a.seat.localeCompare(b.seat)) }))
      .sort((a, b) => a.seats[0]!.seat.localeCompare(b.seats[0]!.seat) || a.resumeType.localeCompare(b.resumeType)),
    unavailable: unavailable.sort(),
  };
}

function listSeats(seats: readonly string[]): string {
  return seats.length <= 2 ? seats.join(" and ") : `${seats.slice(0, -1).join(", ")} and ${seats[seats.length - 1]}`;
}

function named(seats: SharedConversation["seats"]): string[] {
  return seats.map(({ seat, state }) => (state ? `${seat} (${state})` : seat));
}

const CHOICE = "Which agent should keep it is the person's choice; this report changes nothing.";

export function describeSharedConversation(group: SharedConversation): string {
  return `${listSeats(named(group.seats))} have the same recorded ${group.resumeType} conversation. ${CHOICE}`;
}

export function describeUnavailable(seats: readonly string[]): string {
  return `The shared-conversation comparison is unavailable for ${listSeats([...seats])}: its saved resume data is not readable.`;
}

/**
 * The restore side: agents a restore resumes, compared with known agents outside it (in the same rig outside a
 * replacement's selection, or in another rig; whatever their recorded status). Only groups that mix the two are reported here; a
 * group of the restore's own agents is validatePreRestore's.
 */
export function describePartners(resuming: readonly ConversationSeat[], others: readonly ConversationSeat[]): string[] {
  const own = new Set(resuming.map((entry) => entry.seat));
  const { groups, unavailable } = compareConversations([...resuming, ...others]);
  const out: string[] = [];
  for (const group of groups) {
    const restored = group.seats.filter((entry) => own.has(entry.seat));
    const outside = group.seats.filter((entry) => !own.has(entry.seat));
    if (!restored.length || !outside.length) continue;
    out.push(`${listSeats(named(restored))} ${restored.length > 1 ? "have" : "has"} the same recorded ${group.resumeType} `
      + `conversation as ${listSeats(named(outside))}, outside this restore. ${CHOICE}`);
  }
  const outsideUnavailable = unavailable.filter((seat) => !own.has(seat));   // the restore's own: validatePreRestore's
  if (outsideUnavailable.length) out.push(describeUnavailable(outsideUnavailable));
  return out;
}
