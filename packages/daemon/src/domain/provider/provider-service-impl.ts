// Slice-04 (OPR.0.5.0.4) C1 (resume) — the production ProviderService. getReadModel is fully
// wired over the collection seam (real codex-auth reader + node-inventory across rigs + clock).
// precheck composes the pure precheckSwitch gate (fails closed on unknown auth per BR-3). switch
// is precheck-gated and NEVER fabricates success — the switch-execution + BR-1 action-record path
// is the D seam; until it lands, switch returns an honest failed_safely with an operational reason.

import type Database from "better-sqlite3";
import { getNodeInventory } from "../node-inventory.js";
import { readCodexAuthMetadata } from "./codex-auth-reader.js";
import { collectFourBlockReadModel } from "./provider-collect.js";
import { precheckSwitch } from "./provider-policy.js";
import type {
  ProviderService,
  ProviderPrecheckInput,
  ProviderSwitchInput,
  ProviderSwitchResult,
} from "./provider-service.js";
import type { FourBlockReadModel, PrecheckResult } from "./provider-types.js";

export interface ProviderServiceImplDeps {
  db: Database.Database;
  /** The rig universe (rigRepo.listRigs()) — each rig's node-inventory contributes seats. */
  listRigs: () => Array<{ id: string }>;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class ProviderServiceImpl implements ProviderService {
  constructor(private readonly deps: ProviderServiceImplDeps) {}

  async getReadModel(): Promise<FourBlockReadModel> {
    const env = this.deps.env ?? process.env;
    return collectFourBlockReadModel({
      readCodexAuth: () => readCodexAuthMetadata(env),
      listSeats: () => {
        const seats: Array<{ seatSession: string; rigName: string; runtime: string }> = [];
        for (const rig of this.deps.listRigs()) {
          for (const e of getNodeInventory(this.deps.db, rig.id)) {
            if (e.canonicalSessionName) {
              seats.push({ seatSession: e.canonicalSessionName, rigName: e.rigName ?? "", runtime: e.runtime ?? "unknown" });
            }
          }
        }
        return seats;
      },
      now: this.deps.now ?? (() => new Date().toISOString()),
    });
  }

  async precheck(input: ProviderPrecheckInput): Promise<PrecheckResult> {
    const model = await this.getReadModel();
    const target = model.accounts.find((a) => a.accountId === input.toAccount);
    // Validate-at-use: an unknown target OR unknown auth fails closed (BR-3 — disk presence never
    // asserts active). Live-conversation state is not yet wired (the C2 activity seam), so assume
    // live — the conservative direction never strands a conversation silently. This is the MANUAL
    // precheck variant (no triggeringSignal; that's for automated policy-driven switches).
    return precheckSwitch({
      targetProvider: target?.provider ?? "codex",
      targetAuthState: target?.authState ?? "unknown",
      seatHasLiveConversation: true,
    });
  }

  async switchAccount(input: ProviderSwitchInput): Promise<ProviderSwitchResult> {
    // Precheck-gate: never switch past an unsafe verdict unless explicitly forced.
    const verdict = await this.precheck({ seat: input.seat, toAccount: input.toAccount });
    if (verdict.safe === false && !input.forceUnsafe) {
      const reasons = verdict.reasons.length > 0 ? verdict.reasons : ["precheck_unsafe"];
      return { outcome: "failed_safely", reasons: reasons as [string, ...string[]] };
    }
    // D seam (compose the rig-auth codex switch + BR-1 durable action record) is NOT yet wired.
    // Honest operational failure — never fabricate a succeeded/rebind_in_progress outcome.
    return { outcome: "failed_safely", reasons: ["switch_execution_not_yet_wired"] };
  }
}
