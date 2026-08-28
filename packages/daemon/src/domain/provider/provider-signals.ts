// Slice-04 (OPR.0.5.0.4) — signals[] normalization (the §2 detection design, encoded).
// Authority: locked packet 3ffa3c22 IMPLEMENTATION-PRD §2 + the 2026-07-31 RESEARCH verdict.
// Honesty rules enforced here: feature-probe-negative and empty reads become EXPLICIT
// `unknown` rows (never silent zeros, never missing rows); only a real structured read is
// `allow_switch_decision` (BR-2).

import { signalEligibleForAutomation } from "./provider-policy.js";
import type { ProviderBinding, ProviderKind, ProviderSignal } from "./provider-types.js";

/** One provider-native usage window from the Codex app-server `account/rateLimits/read`. */
export interface CodexWindowReading {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: string;
}

/** Subset of the Codex app-server `account/rateLimits/read` response we consume. */
export interface CodexRateLimitReading {
  primary?: CodexWindowReading;
  secondary?: CodexWindowReading;
}

export interface CodexSignalInput {
  accountRef: string;
  /** Result of feature-probing the app-server generated schema for the rate-limit methods. */
  probe: { supported: boolean };
  /** Present only when the probe was supported and a read actually returned. */
  reading?: CodexRateLimitReading;
  asOf: string;
  staleAfter?: string;
}

export const CODEX_UNKNOWN_REASON = {
  probe_unsupported: "codex_app_server_unavailable",
  empty_reading: "codex_read_returned_no_windows",
} as const;

function codexUnknownSignal(
  accountRef: string,
  asOf: string,
  unknownReason: string,
  supportsNotification: boolean,
  staleAfter?: string,
): ProviderSignal {
  return {
    provider: "codex",
    accountRef,
    sourceClass: "unknown",
    authority: "unknown",
    asOf,
    staleAfter,
    unknownReason,
    // Unknown DATA must not erase KNOWN transport capability: when the app-server is present
    // (supported-but-empty) `account/rateLimits/updated` still exists, so the notification
    // capability is true; only an absent app-server (probe unsupported) is false.
    supportsNotification,
    automationUse: "do_not_automate",
    // usedPercent / resetsAt / window deliberately OMITTED — an unknown row never carries a
    // fabricated zero (the BR-2 silent-zero trap). A genuine 0 only ever comes from a real read.
  };
}

/**
 * Normalize a Codex app-server rate-limit read into `signals[]` rows.
 * - probe unsupported → one explicit `unknown` row.
 * - supported but no windows → one explicit `unknown` row (never fabricated zeros).
 * - supported with windows → one `provider_structured_read` row per provider-native window,
 *   preserving the native primary/secondary distinction.
 */
export function codexRateLimitSignals(input: CodexSignalInput): ProviderSignal[] {
  const { accountRef, probe, reading, asOf, staleAfter } = input;

  if (!probe.supported) {
    // App-server absent → no notification transport.
    return [codexUnknownSignal(accountRef, asOf, CODEX_UNKNOWN_REASON.probe_unsupported, false, staleAfter)];
  }

  const windows: Array<[Extract<ProviderSignal["window"], "primary" | "secondary">, CodexWindowReading | undefined]> = [
    ["primary", reading?.primary],
    ["secondary", reading?.secondary],
  ];

  const rows: ProviderSignal[] = [];
  for (const [window, w] of windows) {
    if (!w) continue;
    rows.push({
      provider: "codex",
      accountRef,
      sourceClass: "provider_structured_read",
      authority: "account_cross_device",
      window,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      windowDurationMins: w.windowDurationMins,
      asOf,
      staleAfter,
      supportsNotification: true, // Codex app-server carries account/rateLimits/updated
      automationUse: "allow_switch_decision",
    });
  }

  if (rows.length === 0) {
    // App-server present but returned no windows → unknown DATA, but the transport capability
    // (account/rateLimits/updated) is still KNOWN present → supportsNotification stays true.
    return [codexUnknownSignal(accountRef, asOf, CODEX_UNKNOWN_REASON.empty_reading, true, staleAfter)];
  }
  return rows;
}

// ── Claude statusline lane ──────────────────────────────────────────────────────────────
// The Claude Code statusline sidecar writes the documented `rate_limits` object (Pro/Max
// five-hour + seven-day used_percentage + reset timestamps) to an atomic cache; the daemon
// reads it. `rate_limits` is Pro/Max-only and absent before the first API response — those
// absent cases become EXPLICIT unknown rows (the verdict's honesty requirement). Claude
// statusline carries NO push transport → supportsNotification is always false here.

/** One Claude subscription window from the statusline `rate_limits` object. */
export interface ClaudeStatuslineWindow {
  usedPercent: number;
  resetsAt: string;
}

export interface ClaudeStatuslineReading {
  five_hour?: ClaudeStatuslineWindow;
  seven_day?: ClaudeStatuslineWindow; // normalized to the "weekly" window
}

export interface ClaudeSignalInput {
  /** Claude statusline carries session identity but no honest account identity (Option A). */
  seatSession: string;
  /** false = the statusline cache has not been written yet (before the first API response). */
  cachePresent: boolean;
  /** Present only when the cache exists and carried a rate_limits object. */
  reading?: ClaudeStatuslineReading;
  asOf: string;
  staleAfter?: string;
}

export const CLAUDE_UNKNOWN_REASON = {
  no_statusline_cache_yet: "claude_no_statusline_cache_yet",
  empty_reading: "claude_statusline_cache_had_no_windows",
} as const;

function claudeUnknownSignal(
  seatSession: string,
  asOf: string,
  unknownReason: string,
  staleAfter?: string,
): ProviderSignal {
  return {
    provider: "claude",
    seatSession,
    sourceClass: "unknown",
    authority: "unknown",
    asOf,
    staleAfter,
    unknownReason,
    supportsNotification: false, // Claude statusline has no push transport
    automationUse: "do_not_automate",
    // usedPercent / resetsAt / window OMITTED — never a fabricated zero.
  };
}

/**
 * Normalize a Claude statusline `rate_limits` reading into `signals[]` rows.
 * - seat before first response (no cache) → explicit unknown row.
 * - seat with subscription windows → one `provider_statusline` row per window (five_hour, and
 *   seven_day normalized to "weekly"); a genuine 0 survives as 0.
 * - subscription with cache but no windows → explicit unknown row (never fabricated zeros).
 */
export function claudeStatuslineSignals(input: ClaudeSignalInput): ProviderSignal[] {
  const { seatSession, cachePresent, reading, asOf, staleAfter } = input;

  if (!cachePresent) {
    return [claudeUnknownSignal(seatSession, asOf, CLAUDE_UNKNOWN_REASON.no_statusline_cache_yet, staleAfter)];
  }

  const windows: Array<["five_hour" | "weekly", ClaudeStatuslineWindow | undefined]> = [
    ["five_hour", reading?.five_hour],
    ["weekly", reading?.seven_day],
  ];

  const rows: ProviderSignal[] = [];
  for (const [window, w] of windows) {
    if (!w) continue;
    rows.push({
      provider: "claude",
      seatSession,
      sourceClass: "provider_statusline",
      authority: "account_cross_device", // Claude.ai Pro/Max subscription windows are account-level
      window,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      asOf,
      staleAfter,
      supportsNotification: false, // no push unless OpenRig later supplies a cache-update event
      automationUse: "allow_switch_decision",
    });
  }

  if (rows.length === 0) {
    return [claudeUnknownSignal(seatSession, asOf, CLAUDE_UNKNOWN_REASON.empty_reading, staleAfter)];
  }
  return rows;
}

// ── Reactive lane (both providers) ──────────────────────────────────────────────────────
// At-limit errors / stream failures / stop-error events are consumed IMMEDIATELY as
// sourceClass=provider_event, authority=reactive_error — EXHAUSTION evidence, not a remaining
// meter (so never a usedPercent). An at-limit event is a real exhaustion trigger
// (allow_switch_decision); stream/stop errors are advisory context only.

export type ReactiveEventKind = "at_limit" | "stream_failure" | "stop_error";

export interface ReactiveEventInput {
  provider: ProviderKind;
  accountRef: string;
  kind: ReactiveEventKind;
  asOf: string;
  // Required: a reactive event without a freshness bound could never pass BR-2, and a momentary
  // event must always carry when it expires. Staleness itself stays the shared predicate's job.
  staleAfter: string;
}

export function reactiveEventSignal(input: ReactiveEventInput): ProviderSignal {
  return {
    provider: input.provider,
    accountRef: input.accountRef,
    sourceClass: "provider_event",
    authority: "reactive_error",
    asOf: input.asOf,
    staleAfter: input.staleAfter,
    // supportsNotification is OMITTED: it describes a per-account transport capability (true for
    // Codex account/rateLimits/updated, false/unknown for Claude statusline). A generic reactive
    // event does not establish that capability — hard-coding false would fabricate it.
    // At-limit exhaustion is an actionable switch trigger; stream/stop errors are advisory.
    automationUse: input.kind === "at_limit" ? "allow_switch_decision" : "advisory_only",
    // No usedPercent — a reactive event is exhaustion evidence, not a remaining meter.
  };
}

// ── Usage-limit pool projection ────────────────────────────────────────────────────────

export interface UsageLimitPool {
  poolKey: string;
  provider: ProviderKind;
  seatSessions: string[];
  expiresAt: string;
  source: "provider-reset" | "config-fallback";
}

/**
 * Derive the provider/account pools whose fresh structured evidence says they are
 * exhausted. Claude statusline has no account ref, so its shipped one-account-per-host
 * invariant is one local pool. Codex uses the existing account binding. Nothing unknown,
 * stale, advisory, unbound, or already expired can create a park.
 */
export function deriveUsageLimitPools(input: {
  signals: ProviderSignal[];
  bindings: ProviderBinding[];
  now: Date;
  fallbackSeconds: number;
}): UsageLimitPool[] {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const eligible = input.signals.filter(
    (signal) => signalEligibleForAutomation(signal, input.now.toISOString()).eligible,
  );
  const exhausted = eligible.filter(
    (signal) =>
      (typeof signal.usedPercent === "number" && signal.usedPercent >= 100) ||
      (signal.sourceClass === "provider_event" && signal.authority === "reactive_error"),
  );

  const pools = new Map<string, { provider: ProviderKind; signals: ProviderSignal[] }>();
  for (const signal of exhausted) {
    const poolKey = signal.provider === "claude"
      ? "claude:local"
      : signal.accountRef
        ? `codex:${signal.accountRef}`
        : null;
    if (!poolKey) continue;
    const pool = pools.get(poolKey) ?? { provider: signal.provider, signals: [] };
    pool.signals.push(signal);
    pools.set(poolKey, pool);
  }

  const result: UsageLimitPool[] = [];
  for (const [poolKey, pool] of pools) {
    const statedResets = pool.signals
      .map((signal) => Date.parse(signal.resetsAt ?? ""))
      .filter((value) => Number.isFinite(value) && value > nowMs);
    const fallbackResets = pool.provider === "codex"
      ? pool.signals
          .map((signal) => Date.parse(signal.asOf) + input.fallbackSeconds * 1000)
          .filter((value) => Number.isFinite(value) && value > nowMs)
      : [];
    const expiryMs = statedResets.length > 0
      ? Math.max(...statedResets)
      : fallbackResets.length > 0
        ? Math.max(...fallbackResets)
        : null;
    if (expiryMs === null) continue;

    const seatSessions = pool.provider === "claude"
      ? input.signals
          .filter((signal) => signal.provider === "claude" && typeof signal.seatSession === "string")
          .map((signal) => signal.seatSession!)
      : input.bindings
          .filter((binding) => binding.accountId === pool.signals[0]!.accountRef)
          .map((binding) => binding.seatSession);
    const uniqueSeats = [...new Set(seatSessions)].sort();
    if (uniqueSeats.length === 0) continue;
    result.push({
      poolKey,
      provider: pool.provider,
      seatSessions: uniqueSeats,
      expiresAt: new Date(expiryMs).toISOString(),
      source: statedResets.length > 0 ? "provider-reset" : "config-fallback",
    });
  }
  return result.sort((a, b) => a.poolKey.localeCompare(b.poolKey));
}
