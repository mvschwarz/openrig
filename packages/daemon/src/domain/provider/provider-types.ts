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
  /** Slice 01 (OPR.0.7.0.1) — observed usage windows by allowance identity, ADDITIVE and present
   *  only while `provider.usage_windows` is on. Read from memory; never probed by a read. */
  usage?: ProviderUsageAllowance[];
  /** Slice 01 — each live seat's CONFIGURED account and its source, kept apart from observed allowances
   *  (never linked to a usage row). ADDITIVE and present only while `provider.usage_windows` is on. */
  seatAccounts?: SeatConfiguredAccount[];
}

/** Slice 01 — where a seat's account configuration comes from. A registry row is metadata: it doesn't prove
 *  which login a running session uses. A default login is whatever the daemon's home held at the seat's launch. */
export type SeatAccountConfiguration =
  | { source: "registry"; profileRef: string; recordedAt: string; profileSaved: boolean | null }
  | { source: "default_login"; home: string | null; homeNote: string }
  | { source: "unknown"; reason: string };

export interface SeatConfiguredAccount {
  seatSession: string;
  rigName: string;
  runtime: string;
  configured: SeatAccountConfiguration;
  /** A registry row that exists but isn't applied or doesn't match (stale after a runtime change, another
   *  runtime in its column, or a profile not saved on this host). */
  registryNotes?: string[];
  /** Always unlinked: nothing supported links a configured account to an observed allowance. */
  allowance: { linked: false; reason: string };
  /** What this seat itself was observed reporting. Claude: its own status-line samples, and the seats whose
   *  fresh readings disagree with it (possibly a different login, never a verdict). `withheld` when several
   *  seats share this session name, so samples keyed by it can't be attributed to one seat. */
  observed?: { windowsSampled?: boolean; lastSampledAt?: string; differsFrom?: string[]; withheld?: true; note?: string };
}

/** Slice 01 — allowance identity: the usage answer's accountId, else the workspace account/read
 *  reports, else unresolved; with the bucket (limitId). Email and plan are labels, never identity. */
export interface UsageAllowanceIdentity {
  accountId: string | null;
  workspaceId: string | null;
  limitId: string;
  email: string | null;
  planType: string | null;
  source: "account/rateLimits/read accountId" | "account/read workspace routing" | "unresolved";
}

/** Slice 01 — a Claude allowance's identity: the organisation and email `claude auth status` reports, with the
 *  bucket (the status line's windows cover all models). Claude reports no per-account id, and members of one
 *  organisation have their own limits, so the email is part of the identity here (unlike Codex). */
export interface ClaudeUsageIdentity {
  orgId: string | null;
  limitId: string;
  email: string | null;
  /** Labels only, never part of the key. */
  orgName: string | null;
  subscriptionType: string | null;
  source: "claude auth status orgId and email" | "unresolved";
}

export interface UsageWindowRow {
  /** The provider-native window name (Codex: primary / secondary). */
  window: string;
  durationMins: number | null;
  usedPercent: number | null;
  /** 100 − usedPercent: a percentage; the provider reports no absolute amount. */
  remainingPercent: number | null;
  resetsAt: string | null;
  /** When the native read answered (Claude: the status line's own time for the sample): freshness ages from this. */
  observedAt: string;
  /** Claude: the seat whose status-line sample this window is. */
  seatSession?: string;
  /** Claude: other seats whose fresh readings of this window disagree (a reset more than 60 s apart), with their own
   *  numbers, so which login is where can be read from the row. Present only when they disagree. */
  disagreeingSeats?: Array<{ seatSession: string; usedPercent: number; resetsAt: string | null; observedAt: string }>;
  level: "ok" | "nearing" | "exhausted" | "unknown";
  levelReason?: string;
  freshness: "fresh" | "stale" | "unavailable";
  freshnessReason?: string;
  /** Present when this window's reset has passed since its reading: planning, never a reading. It changes nothing
   *  measured (used %, level, freshness, availability), and a newer reading replaces it. */
  expectation?: { expectedFullSince: string; note: string };
}

/** Slice 01: whether an account's sign-in is usable, read only from the evidence a refresh already holds, apart
 *  from usage. `unknown` is neither usable nor unusable, and nothing decides on it. Ages from `at`; a daemon restart
 *  forgets it, as it forgets the refresh outcome. */
export interface SignInFact {
  state: "usable" | "needs_sign_in" | "unknown";
  evidence: string;
  /** The refresh the evidence comes from; null when there is none. */
  at: string | null;
}

export interface UsageRefreshOutcome {
  at: string;
  outcome: "ok" | "failed";
  reason?: string;
  detail?: string;
}

export interface ProviderUsageAllowance {
  provider: ProviderKind;
  /** Null only for the explicit row of a source never read since the daemon started. */
  identity: UsageAllowanceIdentity | ClaudeUsageIdentity | null;
  source: { kind: "codex_app_server" | "claude_statusline_samples"; host: "local" };
  observedAt: string | null;
  /** Seat links are not observed by this read. */
  seats: "unknown";
  windows: UsageWindowRow[];
  /** The bucket's provider-reported limit evidence (Codex `rateLimitReachedType`), shown once. */
  limitEvidence: string | null;
  /** False when this row came from an earlier read than the latest one (kept; the latest read didn't match it;
   *  its windows read stale: a later read exists). */
  latestFromSource: boolean;
  lastRefresh: UsageRefreshOutcome | null;
  currentAvailability: "known" | "unknown";
  unavailableReason?: string;
  /** Present on a row kept from before the daemon restarted: historical, never current. */
  retained?: "before_restart";
  /** Whether this row's readings are linked to an account: a resolved provider identity, or unknown. */
  accountHistory?: "linked" | "unknown";
  /** The most recent time this allowance was observed exhausted (stored, so it survives a restart), or null. */
  lastObservedExhausted?: { at: string; window: string | null; evidence: string } | null;
  /** On an inactive account's row: OpenRig doesn't record which saved profile was active at its read. */
  savedProfile?: "not linked";
  /** The sign-in fact for this row's login. Optional: an older daemon's rows don't carry it. */
  signIn?: SignInFact;
  /** Claude: how the identity and the windows were joined (identity as of a refresh; windows from seats' samples at
   *  their own times; not proven to be the same login). */
  identityNote?: string;
  /** Present on an unresolved observation: never matched, merged or replaced; kept from the most recent reads. */
  unresolved?: { note: string; keptReads: number; droppedReads: number };
  /** Present when rig auth profiles exist: this read covers only the login active in the daemon's CODEX_HOME. */
  savedProfiles?: { names: string[]; note: string };
}
