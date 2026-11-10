/** Every host pairing request's approval item comes from this address. */
export const PAIR_SOURCE_SESSION = "host-pair@kernel";

/** A host pairing request's approval item. It's answered in place, like a runner's permission request: the pairing
 *  poll reads the answer from the item, and a reply row would go to an address nothing reads (and that doesn't exist
 *  on a daemon started without a kernel). */
export function isHostPairingAsk(item: { sourceSession: string; evidenceRef?: string | null }): boolean {
  return item.sourceSession === PAIR_SOURCE_SESSION && (item.evidenceRef ?? "").startsWith("pair-request:");
}
