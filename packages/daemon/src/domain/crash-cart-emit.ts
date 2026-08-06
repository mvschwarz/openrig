// Crash-cart C3 — the SSOT for the `rig crash-cart --json` payload (plan c015d9ed §C3, coupling
// ruling option C, 4 rails). ONE JSON = the 3-state detector verdict + (on DOWN) the discovery
// (rail 3). Composes the detector + the C2 read VERBATIM (rail 2 — never a parallel read). A
// fail-closed refusal of the read emits a STRUCTURED refusal note (NOT exit-code-only, NO discovery)
// so the TUI never renders the recovery cockpit from a refusal. Read-only (rail 1). The sub-steps are
// injected so this decision layer is deterministic; the CLI verb wires the real detector + read.

import type { DaemonState, DaemonUnverifiedEvidence } from "./crash-cart-detect.js";
import type { CrashCartDiscovery } from "./crash-cart-discovery.js";

/** The verb's JSON payload. Exactly one of {evidence | discovery | refusal} accompanies the state
 *  (up → none; unverified → evidence; down → discovery, or refusal if the read fail-closed). */
export interface CrashCartEmit {
  state: DaemonState;
  evidence?: DaemonUnverifiedEvidence;
  discovery?: CrashCartDiscovery;
  refusal?: string;
}

export interface EmitCrashCartDeps {
  /** Resolve the 3-state verdict (bounded-retry detector). */
  resolveState: () => Promise<DaemonState>;
  /** Assemble the UNVERIFIED evidence (pid state + last probe). */
  assembleEvidence: () => Promise<DaemonUnverifiedEvidence>;
  /** Run the C2 daemon-down read (loadCrashCartDiscovery) VERBATIM; may fail-closed (throws). */
  loadDiscovery: () => Promise<CrashCartDiscovery>;
}

/** Assemble the verb's verdict. UP → state only; UNVERIFIED → state + evidence (no read); DOWN → the
 *  read's discovery, or a structured refusal note if the read fail-closed. */
export async function emitCrashCartState(deps: EmitCrashCartDeps): Promise<CrashCartEmit> {
  const state = await deps.resolveState();
  if (state === "up") return { state };
  if (state === "unverified") return { state, evidence: await deps.assembleEvidence() };
  // down — attempt the C2 read; a refusal is structured, never a rendered cockpit.
  try {
    return { state, discovery: await deps.loadDiscovery() };
  } catch (e) {
    return { state, refusal: e instanceof Error ? e.message : String(e) };
  }
}
