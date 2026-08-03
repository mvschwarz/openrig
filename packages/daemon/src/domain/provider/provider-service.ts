// Slice-04 (OPR.0.5.0.4) — the ProviderService seam. The routes (seam B) are thin over this
// interface; the real implementation (collection from rig auth + seat registry + the three lanes,
// switch composition + action recording) is seams C/D. Keeping this an interface lets the routes
// register and honestly 503 until the production service is wired.

import type { FourBlockReadModel, PrecheckResult } from "./provider-types.js";

export interface ProviderPrecheckInput {
  seat: string;
  toAccount: string;
}

export interface ProviderSwitchInput {
  seat: string;
  toAccount: string;
  forceUnsafe: boolean;
}

/**
 * A discriminated union that TYPE-ENFORCES BR-1 fail-visibility: `succeeded`/`rebind_in_progress`
 * carry NO reasons; `failed_safely` REQUIRES a non-empty reason tuple — a failed switch with no
 * explanation cannot compile. Reasons are string[] so seam D can surface OPERATIONAL failures
 * (auth-switch failure, action-record failure), not only PrecheckReason refusals.
 */
export type ProviderSwitchResult =
  | { outcome: "succeeded" }
  | { outcome: "rebind_in_progress" }
  | { outcome: "failed_safely"; reasons: [string, ...string[]] };

export interface ProviderService {
  /** The ONE four-block read model; the filtered block routes are projections of this. */
  getReadModel(): Promise<FourBlockReadModel>;
  /** Resolve the target/seat state at call time (validate-at-use) and return the safety verdict. */
  precheck(input: ProviderPrecheckInput): Promise<PrecheckResult>;
  /** Precheck-gated switch; returns an explicit business outcome (never a transport error). */
  switchAccount(input: ProviderSwitchInput): Promise<ProviderSwitchResult>;
}
