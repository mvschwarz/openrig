/** Every host pairing request's approval item comes from this address. */
export const PAIR_SOURCE_SESSION = "host-pair@kernel";

/** A host pairing request's approval item. It's answered in place, like a runner's permission request: the pairing
 *  poll reads the answer from the item, and a reply row would go to an address nothing reads (and that doesn't exist
 *  on a daemon started without a kernel). */
export function isHostPairingAsk(item: { sourceSession: string; evidenceRef?: string | null }): boolean {
  return item.sourceSession === PAIR_SOURCE_SESSION && (item.evidenceRef ?? "").startsWith("pair-request:");
}

/** A pairing requester's self-description wherever a person or an agent reads it: quoted and escaped, as the
 *  unauthenticated requesting machine's own words, so nothing in it can close the quotes and read as OpenRig's own
 *  text. Its length and characters are bounded where the request is taken; anything left is shown, quoted. */
export function quotedRequester(requester: string): string {
  return JSON.stringify(requester);
}

/** The quoted name where a limit applies (the request's question): whole when it fits in `max` characters, else the
 *  longest leading part that fits, quoted and marked "(shortened)", so it never reads as the whole name. Escapes can
 *  make a name up to six times longer quoted than stored; the request's body and its record keep it whole. */
export function quotedRequesterWithin(requester: string, max: number): string {
  const whole = quotedRequester(requester);
  if (whole.length <= max) return whole;
  const marker = " (shortened)";
  // By code point, so a character outside the basic plane is never split.
  const kept = [...requester];
  while (kept.length > 0 && quotedRequester(kept.join("")).length + marker.length > max) kept.pop();
  return `${quotedRequester(kept.join(""))}${marker}`;
}
