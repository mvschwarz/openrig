// The offer to register a person, in one place: what `rig daemon start` and `rig gateway participants` tell an agent
// that's setting OpenRig up, or meeting the person first, when the person registry holds nobody.

/** The offer's lines. OpenRig registers no one by printing them; the agent asks, and registers only on a yes. */
export const REGISTRATION_OFFER: readonly string[] = [
  "No person is registered yet, so OpenRig's questions to a person, such as another machine asking to pair, can't reach anyone.",
  "If you're setting OpenRig up for someone, offer to register them now. Ask the name to use, and only on their yes run:",
  '  rig gateway human add <id> --display-name "<name>" --delivery-class B --default',
];

/** Whether a readable participants view holds no person (shared channels don't count). */
export function nobodyRegistered(participants: ReadonlyArray<{ kind: string }>): boolean {
  return !participants.some((p) => p.kind === "person");
}

/** The offer, when the person registry is readable and holds nobody; empty otherwise, since an unreadable registry
 *  isn't evidence that nobody is registered. */
export async function personRegistrationOffer(): Promise<readonly string[]> {
  try {
    const { participantsView } = await import("@openrig/daemon/gateway-human-registry");
    const view = participantsView();
    return view.ok && nobodyRegistered(view.participants) ? REGISTRATION_OFFER : [];
  } catch {
    return [];
  }
}
