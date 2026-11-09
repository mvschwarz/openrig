// A seat's terminal substrate: the terminal multiplexer that runs its pane. tmux is the default and the only
// substrate a seat had before; herdr is opt-in. Chosen per seat, resolved once when the node is created
// (member > rig > host setting `terminal.substrate` > tmux) and stored on the node, so a later change of the
// host setting never moves an existing seat. A stored value this daemon doesn't know is reported as unknown and
// refused by the terminal router; it is never read as tmux.

export const TERMINAL_SUBSTRATES = ["tmux", "herdr"] as const;
export type TerminalSubstrate = (typeof TERMINAL_SUBSTRATES)[number];

export function isTerminalSubstrate(value: unknown): value is TerminalSubstrate {
  return typeof value === "string" && (TERMINAL_SUBSTRATES as readonly string[]).includes(value);
}

/** A spec or setting value: an error message, or null when valid (absent is valid). */
export function terminalSubstrateError(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (isTerminalSubstrate(value)) return null;
  return `${where}: must be one of ${TERMINAL_SUBSTRATES.map((s) => `"${s}"`).join(", ")} (got ${JSON.stringify(value)})`;
}

/** Precedence: member > rig > host default > tmux. Inputs are already validated. */
export function resolveTerminalSubstrate(input: {
  member?: TerminalSubstrate | undefined;
  rig?: TerminalSubstrate | undefined;
  hostDefault?: TerminalSubstrate | undefined;
}): TerminalSubstrate {
  return input.member ?? input.rig ?? input.hostDefault ?? "tmux";
}

/** How a stored node value reads: null/absent is tmux (every seat before migration 155). */
export type StoredSubstrate = { kind: TerminalSubstrate } | { kind: "unknown"; value: string };

export function readStoredSubstrate(value: string | null | undefined): StoredSubstrate {
  if (value === null || value === undefined || value === "") return { kind: "tmux" };
  return isTerminalSubstrate(value) ? { kind: value } : { kind: "unknown", value };
}

/** What a person runs to see a Herdr seat: its workspace, labelled with the seat's session name. */
export function herdrAttachHint(sessionName: string): string {
  return `Herdr workspace "${sessionName}" (open Herdr and select it)`;
}

/** A refusal for an operation the MVP doesn't support on a non-tmux seat, or null for a tmux seat. Services call it
 *  BEFORE any terminal call, so nothing is staged, created or signalled (design §5). An unknown stored value is
 *  refused too: it is never treated as tmux. */
export function substrateFence(
  db: { prepare(sql: string): { get(...args: unknown[]): unknown } },
  nodeId: string,
  operation: string,
): { ok: false; code: "herdr_unsupported" | "substrate_unknown"; message: string; guidance: string } | null {
  let stored: string | null = null;
  try {
    const row = db.prepare("SELECT terminal_substrate FROM nodes WHERE id = ?").get(nodeId) as { terminal_substrate?: string | null } | undefined;
    stored = row?.terminal_substrate ?? null;
  } catch { return null; /* pre-155 schema: every seat is tmux */ }
  const substrate = readStoredSubstrate(stored);
  if (substrate.kind === "tmux") return null;
  if (substrate.kind === "unknown") {
    return { ok: false, code: "substrate_unknown", message: `This seat's terminal substrate "${substrate.value}" is not known to this daemon; ${operation} was not started.`,
      guidance: "Run this operation from a daemon that supports the seat's substrate." };
  }
  return { ok: false, code: "herdr_unsupported", message: `${operation} is not supported for a seat running on Herdr yet; nothing was done.`,
    guidance: "Stop and relaunch the seat instead (rig down, then rig up), or run it on tmux." };
}
