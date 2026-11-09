// Resolves a new seat's terminal substrate with the host setting in the precedence (member > rig > host > tmux).
// Kept apart from terminal-substrate.ts so the pure rules stay free of the settings store.
import { SettingsStore } from "./user-settings/settings-store.js";
import { isTerminalSubstrate, resolveTerminalSubstrate, type TerminalSubstrate } from "./terminal-substrate.js";

/** The host default (`terminal.substrate`), or undefined when unset or unreadable. A bad stored value is rejected by
 *  the settings store's constraint; anything it still returns that isn't a known substrate is ignored here. */
export function hostDefaultTerminalSubstrate(): TerminalSubstrate | undefined {
  try {
    const value = new SettingsStore().resolveOne("terminal.substrate").value;
    return isTerminalSubstrate(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function seatTerminalSubstrate(
  member: { terminalSubstrate?: TerminalSubstrate } | undefined,
  rig: { terminalSubstrate?: TerminalSubstrate } | undefined,
  hostDefault: () => TerminalSubstrate | undefined = hostDefaultTerminalSubstrate,
): TerminalSubstrate {
  return resolveTerminalSubstrate({ member: member?.terminalSubstrate, rig: rig?.terminalSubstrate, hostDefault: hostDefault() });
}
