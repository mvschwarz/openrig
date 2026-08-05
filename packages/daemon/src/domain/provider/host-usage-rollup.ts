// Slice-04 S-A (OPR.0.5.0.4, founder re-center amendment A2) — HOST-LEVEL USAGE ROLLUP.
//
// Usage is metered per account and this deployment runs ONE account per host, so a
// usage-limit park is a HOST-level event. This module aggregates the seat-sourced
// signal rows (C3 Claude statusline lane, sealed 5b56a2a4 · C4 Codex reactive lane,
// sealed 6508330d) into ONE honest state row per (host, provider):
//
//   ok | nearing | limited (until resets_at when known) | explicit_unknown
//
// THE THREE BINDING HONESTY CONDITIONS (PM pattern check, verbatim-class):
//   (i)  host==account is a DEPLOYMENT INVARIANT and every row SAYS so in its
//        provenance — it is never presented as source-derived account
//        classification (the C3 Option-A bar stands: the statusline carries no
//        account identity and none is fabricated here). Rollup keys are
//        (host, provider) ONLY; no account id/ref ever appears in a row.
//   (ii) CONFLICTING seat windows on one host falsify the invariant for that
//        host: they surface as a first-class `conflicting_seat_windows` anomaly
//        plus an explicit_unknown host state — never a silent merge, never an
//        averaged/fabricated number. The conflicting facts stay visible.
//   (iii) usage-limit granularity rides ONLY what the C3 rows already carry
//        (window / usedPercent / resetsAt / asOf) — nothing coerced, nothing
//        invented. Codex has NO remaining-meter lane yet (C2 is a later seam),
//        so codex state derives from fresh reactive EXHAUSTION evidence only,
//        and its absence is an explicit unknown — never "ok" by silence.
//
// The single-daemon scope IS the host scope: rows carry host="local" (the
// reserved local host id). Multi-host aggregation is explicitly out of scope
// (the PRD's MH-lane later).

import type { ProviderKind, ProviderSignal, SignalWindow } from "./provider-types.js";

/** Nearing = the shipped default advisory threshold on the C3-carried percentage. */
export const NEARING_THRESHOLD_PERCENT = 80;

/** Same-window resets_at spread tolerated as sampling skew before it is a CONFLICT.
 *  Two seats on ONE account can read the same window seconds apart; two different
 *  accounts' reset schedules differ by far more than this. */
export const CONFLICTING_RESETS_EPSILON_MS = 120_000;

export type HostUsageState = "ok" | "nearing" | "limited" | "explicit_unknown";

export interface HostUsageWindowFact {
  window: SignalWindow | "unknown";
  usedPercent?: number;
  resetsAt?: string;
  asOf: string;
  /** The contributing seat (topology identity, never an account identity). */
  seatSession?: string;
}

export interface HostUsageConflictAnomaly {
  kind: "conflicting_seat_windows";
  window: SignalWindow | "unknown";
  seats: string[];
  evidence: string;
  asOf: string;
}

export interface HostUsageRow {
  /** The reserved LOCAL host id — this daemon's own scope (MH aggregation is out of scope). */
  host: "local";
  provider: ProviderKind;
  state: HostUsageState;
  /** For `limited`: when the limit lifts, when the source carried it. Honest absence otherwise. */
  resetsAt?: string;
  /** (iii) exactly the C3-carried granularity — never normalized-away, never invented. */
  windows: HostUsageWindowFact[];
  provenance: {
    basis: "one_account_per_host_deployment_invariant";
    note: string;
  };
  anomalies: HostUsageConflictAnomaly[];
  /** Contributing evidence refs: seat sessions (C3) / labeled reactive events (C4). */
  evidenceSeats: string[];
  unknownReason?: string;
  asOf: string;
}

const PROVENANCE_NOTE =
  "host==account is a deployment invariant of this rig (one account per host), declared by the operator — " +
  "it is not source-derived account classification, and no account identity is read or emitted.";

export interface HostUsageRollupInput {
  signals: ProviderSignal[];
  /** Deployment presence for codex (auth profiles on disk) — presence without a meter is an
   *  explicit unknown, never an omitted row (the blindside must be visible). */
  codexProfilesPresent: boolean;
  now: string;
}

export function rollupHostUsage(input: HostUsageRollupInput): HostUsageRow[] {
  const rows: HostUsageRow[] = [];

  const claude = rollupClaude(input);
  if (claude) rows.push(claude);

  const codex = rollupCodex(input);
  if (codex) rows.push(codex);

  return rows;
}

// ——— Claude: the C3 seat-keyed statusline lane (meter rows + explicit-unknown rows) ———

function rollupClaude(input: HostUsageRollupInput): HostUsageRow | null {
  const lane = input.signals.filter((s) => s.provider === "claude");
  if (lane.length === 0) return null; // no claude deployment presence → no row

  const meterRows = lane.filter(
    (s) => s.sourceClass === "provider_statusline" && typeof s.usedPercent === "number",
  );

  const windows: HostUsageWindowFact[] = meterRows.map((s) => ({
    window: s.window ?? "unknown",
    usedPercent: s.usedPercent,
    resetsAt: s.resetsAt,
    asOf: s.asOf,
    seatSession: s.seatSession,
  }));
  const evidenceSeats = [...new Set(lane.map((s) => s.seatSession).filter((x): x is string => typeof x === "string"))];

  const base: Omit<HostUsageRow, "state"> = {
    host: "local",
    provider: "claude",
    windows,
    provenance: { basis: "one_account_per_host_deployment_invariant", note: PROVENANCE_NOTE },
    anomalies: [],
    evidenceSeats,
    asOf: input.now,
  };

  if (meterRows.length === 0) {
    // Only explicit-unknown seat rows (absent cache / pre-first-response / api-key):
    // the host state is honestly unknown, carrying the lane's own reason.
    const reason = lane.find((s) => s.unknownReason)?.unknownReason ?? "no_usable_claude_usage_rows";
    return { ...base, state: "explicit_unknown", unknownReason: reason };
  }

  // (ii) conflict detection per window: under host==account, every seat reading the SAME
  // window must see the SAME reset schedule (within sampling skew). A wider spread means
  // the seats are watching DIFFERENT accounts — the invariant is falsified for this host.
  const anomalies: HostUsageConflictAnomaly[] = [];
  const byWindow = new Map<string, ProviderSignal[]>();
  for (const s of meterRows) {
    const key = s.window ?? "unknown";
    byWindow.set(key, [...(byWindow.get(key) ?? []), s]);
  }
  for (const [windowKey, group] of byWindow) {
    const withResets = group.filter((s) => typeof s.resetsAt === "string");
    if (withResets.length < 2) continue;
    const times = withResets.map((s) => Date.parse(s.resetsAt!)).filter(Number.isFinite);
    if (times.length < 2) continue;
    if (Math.max(...times) - Math.min(...times) > CONFLICTING_RESETS_EPSILON_MS) {
      anomalies.push({
        kind: "conflicting_seat_windows",
        window: windowKey as SignalWindow | "unknown",
        seats: [...new Set(withResets.map((s) => s.seatSession).filter((x): x is string => typeof x === "string"))],
        evidence:
          `seats report divergent ${windowKey} reset schedules on one host: ` +
          withResets.map((s) => `${s.seatSession ?? "?"} resets_at=${s.resetsAt}`).join(" vs "),
        asOf: input.now,
      });
    }
  }
  if (anomalies.length > 0) {
    return {
      ...base,
      state: "explicit_unknown",
      anomalies,
      unknownReason:
        "conflicting_seat_windows: divergent reset schedules falsify the one-account-per-host invariant for this host",
    };
  }

  const maxUsed = Math.max(...meterRows.map((s) => s.usedPercent!));
  if (maxUsed >= 100) {
    const exhausted = meterRows.filter((s) => s.usedPercent! >= 100);
    const resets = exhausted
      .map((s) => s.resetsAt)
      .filter((x): x is string => typeof x === "string")
      .sort();
    return { ...base, state: "limited", ...(resets[0] !== undefined ? { resetsAt: resets[0] } : {}) };
  }
  if (maxUsed >= NEARING_THRESHOLD_PERCENT) return { ...base, state: "nearing" };
  return { ...base, state: "ok" };
}

// ——— Codex: the C4 reactive lane (exhaustion evidence only — no meter until C2) ———

function rollupCodex(input: HostUsageRollupInput): HostUsageRow | null {
  const lane = input.signals.filter((s) => s.provider === "codex");
  if (lane.length === 0 && !input.codexProfilesPresent) return null; // no deployment presence

  const nowMs = Date.parse(input.now);
  // At-limit exhaustion evidence = a reactive_error event row the C4 tap marked as an
  // actionable switch trigger (at_limit → allow_switch_decision; stream/stop errors are
  // advisory and are NOT usage evidence). Freshness is inclusive-expiry (BR-2 class).
  const freshAtLimit = lane.filter(
    (s) =>
      s.sourceClass === "provider_event" &&
      s.authority === "reactive_error" &&
      s.automationUse === "allow_switch_decision" &&
      typeof s.staleAfter === "string" &&
      Number.isFinite(Date.parse(s.staleAfter)) &&
      Number.isFinite(nowMs) &&
      nowMs < Date.parse(s.staleAfter),
  );

  const base: Omit<HostUsageRow, "state"> = {
    host: "local",
    provider: "codex",
    windows: [], // (iii): codex carries no remaining-meter granularity yet — nothing is invented
    provenance: { basis: "one_account_per_host_deployment_invariant", note: PROVENANCE_NOTE },
    anomalies: [],
    evidenceSeats: freshAtLimit.map((s) => `reactive_event asOf=${s.asOf}`),
    asOf: input.now,
  };

  if (freshAtLimit.length > 0) {
    const resets = freshAtLimit
      .map((s) => s.resetsAt)
      .filter((x): x is string => typeof x === "string")
      .sort();
    return { ...base, state: "limited", ...(resets[0] !== undefined ? { resetsAt: resets[0] } : {}) };
  }

  return {
    ...base,
    state: "explicit_unknown",
    unknownReason:
      "no usage meter for codex on this host yet (the app-server read lane is a later seam); no fresh at-limit evidence either way",
  };
}
