// Slice-04 (OPR.0.5.0.4) provider-interruption-automation — the §1 four-block read model.
// Schema authority: locked packet 3ffa3c22 IMPLEMENTATION-PRD §1 + the 2026-07-31 RESEARCH
// verdict's signals[] normalization (adopted verbatim). Field names ARE the contract —
// additive evolution only after schema lock. BR-6: accountId/profileRef are opaque refs,
// NEVER a token/header/auth-file content.

export type ProviderKind = "codex" | "claude";
export type AccountAuthState = "active" | "needs_reauth" | "unknown";

/** accounts[] — one row per known provider account. */
export interface ProviderAccount {
  accountId: string; // stable opaque ref — NEVER a secret or token
  label: string; // human, stable
  provider: ProviderKind;
  authState: AccountAuthState;
  profileRef: string | null; // the `rig auth` profile name where one exists; null for unmanaged
  asOf: string; // ISO-8601
}

import type { HostUsageRow } from "./host-usage-rollup.js";

export type BindingAnomalyKind = "same_account_on_n_seats" | "seat_with_no_account";

/**
 * First-class binding anomalies — server-computed, not derived client-side. A discriminated
 * union carrying EXACTLY the locked §1 fields for each variant (nothing added).
 */
export type SameAccountOnNSeatsAnomaly = {
  kind: "same_account_on_n_seats";
  count: number;
  seats: string[];
  evidence: string;
  asOf: string;
};
export type SeatWithNoAccountAnomaly = {
  kind: "seat_with_no_account";
  seat: string;
  evidence: string;
  asOf: string;
};
export type BindingAnomaly = SameAccountOnNSeatsAnomaly | SeatWithNoAccountAnomaly;

/**
 * A `bindings[]` row — a discriminated bound/unbound union over the SAME locked §1 field names
 * (`accountId`, `seatSession`, `rigName`, `boundAt`, `bindingSource`, `anomalies`). A bound row
 * has a non-null `accountId` (+ `boundAt`/`bindingSource`); an unbound seat keeps the same field
 * names but `null` for the absent BINDING data and MUST carry a `seat_with_no_account` anomaly —
 * never a fabricated/sentinel account. Discriminant: `accountId` (string vs null).
 */
export type ProviderBinding =
  | {
      accountId: string;
      seatSession: string;
      rigName: string;
      boundAt: string;
      bindingSource: string;
      anomalies: BindingAnomaly[];
    }
  | {
      accountId: null;
      seatSession: string;
      rigName: string;
      boundAt: null;
      bindingSource: null;
      // An unbound seat MUST carry a seat_with_no_account anomaly — enforced at the type
      // level as a non-empty tuple whose first element is that anomaly, so the dishonest
      // "unbound row with an empty/same-account-only anomaly list" cannot even compile.
      anomalies: [SeatWithNoAccountAnomaly, ...BindingAnomaly[]];
    };

export type SignalSourceClass =
  | "provider_structured_read"
  | "provider_statusline"
  | "provider_event"
  | "local_usage_attribution"
  | "community_probe"
  | "capture_fallback"
  | "unknown";

export type SignalAuthority =
  | "account_cross_device"
  | "device_local"
  | "api_workspace"
  | "reactive_error"
  | "unknown";

// Normalized windows; provider-native enum values are ALSO allowed (honesty rule — never
// force Codex/Claude into identical fields).
export type SignalWindow =
  | "five_hour"
  | "weekly"
  | "primary"
  | "secondary"
  | "monthly_credit"
  | (string & {}); // provider-native

export type AutomationUse = "allow_switch_decision" | "advisory_only" | "do_not_automate";

/**
 * signals[] — the research verdict's normalization. An absent/unknown reading is an EXPLICIT
 * row (`sourceClass`/`authority` = "unknown", `unknownReason` set), never a missing row and
 * never a fabricated zero (`usedPercent` is OMITTED when unknown).
 */
export interface ProviderSignal {
  provider: ProviderKind;
  /** Opaque account ref (BR-6). Claude statusline rows omit it: that surface exposes no account identity. */
  accountRef?: string;
  /** Runtime seat identity for seat-keyed lanes such as Claude statusline provider_usage. */
  seatSession?: string;
  sourceClass: SignalSourceClass;
  authority: SignalAuthority;
  window?: SignalWindow;
  usedPercent?: number; // omitted when unknown — NEVER coerced to 0 (BR-2 silent-zero trap)
  remaining?: number; // provider-native remaining, when the provider expresses it that way
  resetsAt?: string;
  windowDurationMins?: number;
  asOf: string;
  staleAfter?: string;
  unknownReason?: string;
  supportsNotification?: boolean;
  automationUse: AutomationUse; // BR-2: unknown/stale/advisory are never allow_switch_decision
}

// precheck / switch (§1 + §3)
export type PrecheckReason =
  | "would_strand_live_conversation"
  | "target_needs_reauth" // target authState === "needs_reauth"
  | "target_auth_unknown" // target authState === "unknown" — fails closed, NOT relabeled as re-auth
  | "signal_unknown_or_stale"
  | "rebind_unsupported_for_runtime";

export type PrecheckResult = { safe: true } | { safe: false; reasons: PrecheckReason[] };

export type SwitchOutcome = "succeeded" | "rebind_in_progress" | "failed_safely";

/** The whole four-block read model, emitted by `rig provider status --json`. */
export interface FourBlockReadModel {
  accounts: ProviderAccount[];
  bindings: ProviderBinding[];
  signals: ProviderSignal[];
  asOf: string;
  /** Slice-04 S-A (A2 amendment) — the host-level usage rollup, ADDITIVE: one honest state
   *  row per (host, provider) aggregated from the seat-sourced signal rows. Optional so the
   *  sealed assembler stays untouched; the collect layer always populates it. */
  hostUsage?: HostUsageRow[];
}
