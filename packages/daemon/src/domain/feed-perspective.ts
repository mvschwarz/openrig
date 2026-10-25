import type { AttentionRead } from "../attention-surface.js";
import type { QueueRepository } from "./queue-repository.js";
import { resolveRegisteredHumanAddress } from "./gateway/human-registry.js";
import { resolveDefaultPerson } from "./gateway/participants.js";

export type FeedPerspective = NonNullable<AttentionRead["perspective"]>;

/**
 * Whose queue a Feed read shows (`view`: a person, `default` or `all`), and whether something addressed to a recipient is
 * in it. Every Feed list (asks, parked rows, delivered updates) uses this one rule. A view, never an identity: acts on what
 * it shows carry the primary user's authority, the person at the terminal, whoever's queue it is. With no person
 * registered there's no perspective, and everything is in view, as before.
 */
export function feedPerspective(queue: Pick<QueueRepository, "humanRegistry"> | undefined, view: string | undefined): {
  perspective?: FeedPerspective;
  inView: (recipient: string | null | undefined) => boolean;
} {
  const registry = queue?.humanRegistry();
  const entities = registry?.ok ? registry.entities : [];
  if (!entities.length) return { inView: () => true };
  const person = (session: string | null | undefined) => resolveRegisteredHumanAddress(session, entities);
  const requested = view?.trim() || undefined;
  // The primary user is the default person: the participants file's `default`, else the only registered person.
  const primaryUser = resolveDefaultPerson(entities);
  const primary = primaryUser.person?.address ?? null;
  const named = requested !== undefined && requested !== "all" && requested !== "default";
  const chosen = named && requested ? person(requested) ?? person(`${requested}@external`) : null;
  const viewing = requested === "default" ? primary : chosen;
  const basis: FeedPerspective["basis"] = requested === "default" ? (primary ? "default" : "all")
    : named ? (chosen ? "chosen-here" : "unknown") : "all";
  const perspective: FeedPerspective = { viewing, basis, ...(basis === "unknown" ? { requested } : {}), defaultSource: primaryUser.source,
    actingAs: { person: primary, authority: "primary-user" } };
  // A person's items are in their view. Items for no registered person (instance facts, a bare human seat) are the primary
  // user's, so they're in theirs.
  const inView = basis === "unknown" ? () => false
    : basis === "all" ? () => true
    : (recipient: string | null | undefined) => {
      const owner = person(recipient);
      return owner ? owner === viewing : viewing === primary;
    };
  return { perspective, inView };
}
