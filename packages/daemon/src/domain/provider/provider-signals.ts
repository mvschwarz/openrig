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
