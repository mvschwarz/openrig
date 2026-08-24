import type { EvalProvider, EvalRunResult } from "./eval-provider.js";

export interface RigSeatProviderOptions {
  /** Config-resolved packs root the spawned seat pulls from (Track A: OPENRIG_CONTEXT_PACKS_ROOT). */
  packsRoot: string;
  /** Seat spec / model to fork for the eval, when the non-author wires this live. */
  seatSpec?: string;
}

/**
 * slice-07 R6 — the LIVE-SEAT provider: the proof-contract PULL-WORKS / AGENT-DRIVEN door.
 *
 * Contract (what the non-author drives): spawn an ephemeral seat with the seeded library on its
 * config-resolved packs root, teach it only that context is pullable via `rig context get <ref>`,
 * send the case's NATURAL prompt, capture the seat's transcript (what it actually ran), retire it,
 * and return that transcript to the deterministic door grader.
 *
 * This path is NON-DETERMINISTIC and needs a real model seat, so it is VERIFIED BY THE NON-AUTHOR
 * DOOR, not by this slice's unit suite (a reviewer who cannot run it defers and names their
 * vantage). It is kept behind the EvalProvider seam so the whole harness runs without it
 * (FakeProvider). It THROWS — rather than returning a plausible empty transcript — so a live run
 * can never read as a false green before the non-author has actually wired seat spawn + capture.
 */
export class RigSeatProvider implements EvalProvider {
  readonly name = "rig-seat";
  constructor(private readonly opts: RigSeatProviderOptions) {}

  async run(_prompt: string): Promise<EvalRunResult> {
    void this.opts;
    throw new Error(
      "RigSeatProvider is the live proof-contract door and is not yet driven. The non-author wires " +
        "seat spawn (packs root = OPENRIG_CONTEXT_PACKS_ROOT), natural-prompt send, and transcript " +
        "capture here, then verifies live. Until then, run the harness with --provider fake. See " +
        "packages/test-system/evals/README.md.",
    );
  }
}
