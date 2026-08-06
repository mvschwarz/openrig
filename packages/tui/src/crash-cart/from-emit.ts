// Crash-cart C3 unit-C — map the parsed `rig crash-cart --json` verdict onto the renderScreen
// daemon-down opts. The verb is the SSOT; this is the TUI's thin interpretation. RAIL 3: a DOWN
// verdict that carries a REFUSAL (the read fail-closed because a daemon actually answered) NEVER
// renders the cockpit — it falls to the normal TUI.
import type { DaemonState, DaemonUnverifiedEvidence } from "./contract.js";
import { buildCrashCartModel, type CrashCartDiscoveryInput, type CrashCartModel } from "./crash-cart-model.js";

/** The `rig crash-cart --json` payload (mirrors the daemon verb's emit — the documented JSON contract). */
export interface CrashCartEmit {
  state: DaemonState;
  evidence?: DaemonUnverifiedEvidence;
  discovery?: CrashCartDiscoveryInput;
  refusal?: string;
}

/** The daemon-down subset of RenderOptions the TUI feeds renderScreen (empty ⇒ normal fleet views). */
export interface CrashCartRenderOpts {
  daemonState?: DaemonState;
  crashCart?: CrashCartModel;
  daemonEvidence?: DaemonUnverifiedEvidence;
}

/** Verdict → render opts. DOWN+discovery → cockpit; UNVERIFIED+evidence → cannot-verify; else (UP, or
 *  DOWN+refusal) → normal TUI (never the cockpit from a refusal). */
export function crashCartRenderOpts(emit: CrashCartEmit): CrashCartRenderOpts {
  if (emit.state === "down" && emit.discovery) {
    return { daemonState: "down", crashCart: buildCrashCartModel(emit.discovery) };
  }
  if (emit.state === "unverified" && emit.evidence) {
    return { daemonState: "unverified", daemonEvidence: emit.evidence };
  }
  return {};
}

/**
 * Run the `rig crash-cart --json` verb (injected) + map its JSON → render opts. Any failure (the verb
 * erroring, or unparseable output) yields normal-TUI opts — the probe NEVER fabricates a cockpit from a
 * failed run (honest-degraded).
 */
export async function probeCrashCart(runVerb: () => Promise<string>): Promise<CrashCartRenderOpts> {
  try {
    const emit = JSON.parse(await runVerb()) as CrashCartEmit;
    if (!emit || typeof emit.state !== "string") return {};
    return crashCartRenderOpts(emit);
  } catch {
    return {};
  }
}
