// Slice-04 (OPR.0.5.0.4) — the ProviderService seam. The routes (seam B) are thin over this
// interface; the real implementation (collection from rig auth + seat registry + the three lanes,
// switch composition + action recording) is seams C/D. Keeping this an interface lets the routes
// register and honestly 503 until the production service is wired.

import type { FourBlockReadModel, PrecheckResult } from "./provider-types.js";
import type { UsageRefreshResult } from "./usage-windows.js";
import type { RestartInPlaceResult } from "../seat-lifecycle-service.js";
import type { PeerReport } from "../seat-restart-in-place.js";
import type { ClaudeSeatTokenRef } from "../claude-seat-token.js";
import type { CredentialPrecedence } from "../claude-credential-precedence.js";

export interface ProviderPrecheckInput {
  seat: string;
  toAccount: string;
  /** A Claude seat's own subscription token file (absolute); null moves it back to its config dir's stored login. */
  tokenFile?: string | null;
  /** Claude API key read from this file at launch; never credential bytes. */
  apiKeyFile?: string;
}

export interface ProviderSwitchInput {
  seat: string;
  toAccount: string;
  forceUnsafe: boolean;
  /** As on the precheck. */
  tokenFile?: string | null;
  /** Claude API key read from this file at launch; never credential bytes. */
  apiKeyFile?: string;
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

/** A Claude seat's relaunch on the same conversation, in its own pane, by restore's own resume path, lent by the route for
 *  one call. */
export interface ClaudeSeatRelaunch {
  /** The seat, when it's a managed Claude seat; null for any other runtime. `pane` is its bound tmux pane. */
  seat(seat: string): { nodeId: string; rigId: string; rigName: string; logicalId: string; running: boolean; pane: string | null } | null;
  tokenRef(nodeId: string): ClaudeSeatTokenRef | null;
  setTokenRef(nodeId: string, ref: ClaudeSeatTokenRef | null): void;
  /** A snapshot taken now, and whether restoring this seat from it resumes its conversation. */
  snapshot(rigId: string, nodeId: string): { snapshotId: string; resumes: true; conversation: string | null } | { snapshotId: string; resumes: false; why: string };
  /** Runs `fn` holding the seat's lifecycle lease (the one its stop, launch and restore take), so no other one runs on the
   *  seat in between. A wait for it ends with the seat as it is then. */
  exclusive<T>(nodeId: string, fn: () => Promise<T>): Promise<T>;
  /** Relaunch only this seat from that snapshot in its own pane: its process ends in place, the pane and its scrollback stay,
   *  and restore resumes the conversation there. `effect: "none"` when it was refused before anything stopped. */
  relaunchInPane(rigId: string, logicalId: string, snapshotId: string): Promise<{ ok: true; status: "resumed"; warnings: string[] }
    | { ok: false; effect: "none" | "unknown"; code: string; message: string }>;
}

/** What would outrank a Claude seat's own token at its next launch (`ClaudeManagedLaunch.credentialPrecedence`). */
export type ClaudeCredentialPrecedence = (nodeId: string, opts?: { storedLogin?: boolean; apiKey?: boolean }) => Promise<CredentialPrecedence>;

/** What a seat switch did: for a Codex seat, in the Codex home it runs on; for a Claude seat, to its token reference. */
export interface SeatSwitchReport {
  seat: string;
  /** Codex: the home whose active login changed. */
  home?: string;
  /** Codex: the login's saved name. Claude: the token's label, or `stored-login`. */
  account: string;
  /** Claude: the token file the launch reads (a path; never its contents). */
  tokenFile?: string;
  credentialKind?: "api-key";
  /** Claude: the conversation the relaunch resumes. */
  conversation?: string | null;
  /** Whether the seat's login source is now `account`. */
  loginChanged: boolean;
  /** Codex: the outgoing login, saved in the same home first under a name of its own; null when the home had no active login. */
  savedBefore?: string | null;
  /** The command that switches the home back. */
  undo: string | null;
  restart?: { outcome: string; message: string; recoveryCommand?: string; remainingStep?: string };
  /** Claude: what the relaunch reported, such as a token it couldn't apply. */
  warnings?: string[];
  /** Claude: false when the relaunch reported starting without the seat's token. True means no such fallback was reported;
   *  the seat's /status after a tool turn is the evidence. */
  tokenApplied?: boolean;
  /** The other Codex seats. One on the same home shares its login: it keeps its current one only until its next token
   *  refresh, then stops until it's restarted, so `step` is that restart. */
  peers: Array<PeerReport & { step?: string }>;
  next?: string;
}

export interface ProviderService {
  /** The ONE four-block read model; the filtered block routes are projections of this. */
  getReadModel(): Promise<FourBlockReadModel>;
  /** Resolve the target/seat state at call time (validate-at-use) and return the safety verdict. */
  precheck(input: ProviderPrecheckInput, seatRestart?: SeatRestart, claudeSeat?: ClaudeSeatRelaunch): Promise<PrecheckResult>;
  /** Precheck-gated switch; returns an explicit business outcome (never a transport error). With the seat's restart it
   *  moves that seat to a login saved in the Codex home it runs on. */
  switchAccount(input: ProviderSwitchInput, seatRestart?: SeatRestart, claudeSeat?: ClaudeSeatRelaunch): Promise<ProviderSwitchResult>;
  /** Slice 01: one bounded native read of the usage windows (coalesced); `disabled` while the switch is off. */
  refreshUsage?(provider: "codex" | "claude", token?: import("./claude-token-usage.js").ClaudeTokenSelection): Promise<UsageRefreshResult | { disabled: true } | { unavailable: true }>;
}
