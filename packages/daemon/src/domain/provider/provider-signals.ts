// Slice-04 (OPR.0.5.0.4) — signals[] normalization (the §2 detection design, encoded).
// Authority: locked packet 3ffa3c22 IMPLEMENTATION-PRD §2 + the 2026-07-31 RESEARCH verdict.
// Honesty rules enforced here: feature-probe-negative and empty reads become EXPLICIT
// `unknown` rows (never silent zeros, never missing rows); only a real structured read is
// `allow_switch_decision` (BR-2).

import type { ProviderSignal } from "./provider-types.js";

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
  accountRef: string;
  /** API-key accounts never emit subscription windows (Pro/Max only). */
  accountKind: "subscription" | "api_key";
  /** false = the statusline cache has not been written yet (before the first API response). */
  cachePresent: boolean;
  /** Present only when the cache exists and carried a rate_limits object. */
  reading?: ClaudeStatuslineReading;
  asOf: string;
  staleAfter?: string;
}

export const CLAUDE_UNKNOWN_REASON = {
  api_key_no_subscription_windows: "claude_api_key_no_subscription_windows",
  no_statusline_cache_yet: "claude_no_statusline_cache_yet",
  empty_reading: "claude_statusline_cache_had_no_windows",
} as const;

function claudeUnknownSignal(
  accountRef: string,
  asOf: string,
  unknownReason: string,
  staleAfter?: string,
): ProviderSignal {
  return {
    provider: "claude",
    accountRef,
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
 * - API-key account → explicit unknown row (no subscription windows exist).
 * - subscription before first response (no cache) → explicit unknown row.
 * - subscription with windows → one `provider_statusline` row per window (five_hour, and
 *   seven_day normalized to "weekly"); a genuine 0 survives as 0.
 * - subscription with cache but no windows → explicit unknown row (never fabricated zeros).
 */
export function claudeStatuslineSignals(input: ClaudeSignalInput): ProviderSignal[] {
  const { accountRef, accountKind, cachePresent, reading, asOf, staleAfter } = input;

  if (accountKind === "api_key") {
    return [
      claudeUnknownSignal(accountRef, asOf, CLAUDE_UNKNOWN_REASON.api_key_no_subscription_windows, staleAfter),
    ];
  }
  if (!cachePresent) {
    return [claudeUnknownSignal(accountRef, asOf, CLAUDE_UNKNOWN_REASON.no_statusline_cache_yet, staleAfter)];
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
      accountRef,
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
    return [claudeUnknownSignal(accountRef, asOf, CLAUDE_UNKNOWN_REASON.empty_reading, staleAfter)];
  }
  return rows;
}
