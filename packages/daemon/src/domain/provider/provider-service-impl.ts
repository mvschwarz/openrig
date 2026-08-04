// Slice-04 (OPR.0.5.0.4) C1 (resume) — the production ProviderService. getReadModel is fully
// wired over the collection seam (real codex-auth reader + node-inventory across rigs + clock).
// precheck composes the pure precheckSwitch gate (fails closed on unknown auth per BR-3). switch
// is precheck-gated and NEVER fabricates success — the switch-execution + BR-1 action-record path
// is the D seam; until it lands, switch returns an honest failed_safely with an operational reason.

import type Database from "better-sqlite3";
import {
  AGENT_ACTIVITY_FRESHNESS_MS,
  type AgentActivityStore,
} from "../agent-activity-store.js";
import { getNodeInventory } from "../node-inventory.js";
import { readCodexAuthMetadata, type CodexAuthMetadata } from "./codex-auth-reader.js";
import { collectFourBlockReadModel, type ProviderSeat } from "./provider-collect.js";
import { precheckSwitch } from "./provider-policy.js";
import { collectReactiveEventSignals } from "./reactive-tap.js";
import type {
  ProviderService,
  ProviderPrecheckInput,
  ProviderSwitchInput,
  ProviderSwitchResult,
} from "./provider-service.js";
import type { FourBlockReadModel, PrecheckResult, ProviderSignal } from "./provider-types.js";

export interface ProviderServiceImplDeps {
  db: Database.Database;
  /** The rig universe (rigRepo.listRigs()) — each rig's node-inventory contributes seats. */
  listRigs: () => Array<{ id: string }>;
  /** Slice-04 C3: the Claude statusline provider_usage signal source (undefined → signals []). */
  collectClaudeSignals?: () => ProviderSignal[];
  /** Slice-04 C4: the shipped structured activity detector. Undefined keeps the reactive lane empty. */
  agentActivityStore?: Pick<AgentActivityStore, "getLatestForNode">;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class ProviderServiceImpl implements ProviderService {
  constructor(private readonly deps: ProviderServiceImplDeps) {}

  async getReadModel(): Promise<FourBlockReadModel> {
    const env = this.deps.env ?? process.env;
    const asOf = (this.deps.now ?? (() => new Date().toISOString()))();
    let auth: CodexAuthMetadata | undefined;
    let seats: ProviderSeat[] | undefined;
    const readAuth = () => auth ??= readCodexAuthMetadata(env);
    const listSeats = () => seats ??= this.listSeats();
    return collectFourBlockReadModel({
      readCodexAuth: readAuth,
      listSeats,
      collectSignals: () => [
        ...(this.deps.collectClaudeSignals?.() ?? []),
        ...(this.deps.agentActivityStore
          ? collectReactiveEventSignals({
            seats: listSeats(),
            auth: readAuth(),
            activity: this.deps.agentActivityStore,
            now: asOf,
            freshnessMs: AGENT_ACTIVITY_FRESHNESS_MS,
          })
          : []),
      ],
      now: () => asOf,
    });
  }

  private listSeats(): ProviderSeat[] {
    const seats: ProviderSeat[] = [];
    for (const rig of this.deps.listRigs()) {
      for (const entry of getNodeInventory(this.deps.db, rig.id)) {
        if (!entry.canonicalSessionName) continue;
        seats.push({
          seatSession: entry.canonicalSessionName,
          rigName: entry.rigName ?? "",
          runtime: entry.runtime ?? "unknown",
          lifecycleState: entry.lifecycleState,
        });
      }
    }
    return seats;
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
