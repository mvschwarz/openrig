// Slice-04 (OPR.0.5.0.4) — the ProviderService seam. The routes (seam B) are thin over this
// interface; the real implementation (collection from rig auth + seat registry + the three lanes,
// switch composition + action recording) is seams C/D. Keeping this an interface lets the routes
// register and honestly 503 until the production service is wired.

import type { FourBlockReadModel, PrecheckResult } from "./provider-types.js";
import type { UsageRefreshResult } from "./usage-windows.js";
import type { RestartInPlaceResult } from "../seat-lifecycle-service.js";
import type { PeerReport } from "../seat-restart-in-place.js";

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
  | { outcome: "succeeded"; message?: string; seat?: SeatSwitchReport }
  | { outcome: "rebind_in_progress"; message?: string; seat?: SeatSwitchReport }
  | { outcome: "failed_safely"; reasons: [string, ...string[]]; message?: string; seat?: SeatSwitchReport }
  // The restart ran but its result wasn't confirmed: reported with its recovery command, never retried.
  | { outcome: "unknown"; reasons: [string, ...string[]]; message: string; seat: SeatSwitchReport };

/** The seat's in-place restart (`rig seat restart --keep-conversation`), lent by the route for one call. */
export interface SeatRestart {
  /** Every gate, read-only: nothing is stopped. */
  plan(seat: string): Promise<RestartInPlaceResult>;
  run(seat: string, reason: string): Promise<RestartInPlaceResult>;
}

/** What a seat switch did in the Codex home the seat runs on. */
export interface SeatSwitchReport {
  seat: string;
  home: string;
  account: string;
  /** Whether the home's active login is now `account`. */
  loginChanged: boolean;
  /** The outgoing login, saved in the same home first under a name of its own; null when the home had no active login. */
  savedBefore: string | null;
  /** The command that switches the home back. */
  undo: string | null;
  restart?: { outcome: string; message: string; recoveryCommand?: string; remainingStep?: string };
  /** The other Codex seats. One on the same home shares its login: it keeps its current one only until its next token
   *  refresh, then stops until it's restarted, so `step` is that restart. */
  peers: Array<PeerReport & { step?: string }>;
  next?: string;
}

export interface ProviderService {
  /** The ONE four-block read model; the filtered block routes are projections of this. */
  getReadModel(): Promise<FourBlockReadModel>;
  /** Resolve the target/seat state at call time (validate-at-use) and return the safety verdict. */
  precheck(input: ProviderPrecheckInput, seatRestart?: SeatRestart): Promise<PrecheckResult>;
  /** Precheck-gated switch; returns an explicit business outcome (never a transport error). With the seat's restart it
   *  moves that seat to a login saved in the Codex home it runs on. */
  switchAccount(input: ProviderSwitchInput, seatRestart?: SeatRestart): Promise<ProviderSwitchResult>;
  /** Slice 01: one bounded native read of the usage windows (coalesced); `disabled` while the switch is off. */
  refreshUsage?(provider: "codex" | "claude", token?: import("./claude-token-usage.js").ClaudeTokenSelection): Promise<UsageRefreshResult | { disabled: true } | { unavailable: true }>;
}
