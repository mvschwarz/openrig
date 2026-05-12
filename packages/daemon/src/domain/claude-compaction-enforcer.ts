import type { SessionTransport } from "./session-transport.js";
import type { SettingsStore } from "./user-settings/settings-store.js";

/**
 * Slice 27 — Claude auto-compaction policy enforcer.
 *
 * Decides per-seat whether ContextMonitor should send `/compact` based on
 * operator-configured policy (`policies.claude_compaction.*` settings).
 * Decoupled from ContextMonitor's scheduling concern so it can be tested
 * + composed independently.
 *
 * Risk class: compaction lifecycle is load-bearing (banked permission-layer
 * foot-gun rule extends to any agent-runtime trigger). Defensive contract:
 *
 * - Opt-in default-off: `enabled=false` → never triggers. Verified by
 *   regression test HG-5.
 * - Runtime filter: triggers only when runtime === "claude-code". Codex
 *   compacts cleanly via its own runtime per agent-startup-guide; other
 *   runtimes are out of scope.
 * - Dedup: in-memory per-session window (default 60s) prevents a
 *   flapping percentage from firing repeated /compact sends. State is
 *   intentionally NOT persisted; daemon restart resets the window which
 *   is the safer-failure direction (might re-compact once on restart in
 *   rare cases, won't lock out forever).
 * - Send-failure graceful-degrade: returns { triggered: false } with a
 *   reason; does not throw. The dedup timestamp is only set on
 *   successful send, so a transient send failure can retry on the next
 *   polling tick.
 */
export const DEDUP_WINDOW_MS_DEFAULT = 60_000;

export interface EnforcerInput {
  sessionName: string;
  runtime: string | null;
  usedPercentage: number | null;
}

export type EnforcerOutcome =
  | { triggered: true }
  | { triggered: false; reason: EnforcerSkipReason };

export type EnforcerSkipReason =
  | "runtime_filter"
  | "no_usage_data"
  | "disabled"
  | "below_threshold"
  | "dedup_window"
  | "send_failed"
  | "invalid_policy";

export class ClaudeCompactionEnforcer {
  private readonly settingsStore: SettingsStore;
  private readonly sessionTransport: SessionTransport;
  private readonly dedupWindowMs: number;
  private readonly lastAutoCompactAt = new Map<string, number>();

  constructor(
    settingsStore: SettingsStore,
    sessionTransport: SessionTransport,
    opts?: { dedupWindowMs?: number },
  ) {
    this.settingsStore = settingsStore;
    this.sessionTransport = sessionTransport;
    this.dedupWindowMs = opts?.dedupWindowMs ?? DEDUP_WINDOW_MS_DEFAULT;
  }

  /**
   * Inspect a single observation and trigger /compact when policy says so.
   * Safe to call on every poll tick; non-eligible inputs return early
   * with a skip reason and never touch SessionTransport.
   */
  async maybeAutoCompact(input: EnforcerInput): Promise<EnforcerOutcome> {
    if (input.runtime !== "claude-code") {
      return { triggered: false, reason: "runtime_filter" };
    }
    if (input.usedPercentage == null) {
      return { triggered: false, reason: "no_usage_data" };
    }

    const policy = this.settingsStore.resolveClaudeCompactionPolicy();
    if (!policy.enabled) {
      return { triggered: false, reason: "disabled" };
    }
    // Defense in depth: the CLI + daemon set() paths reject invalid
    // threshold values, but a hand-edited ~/.openrig/config.json could
    // still inject 0, 101, NaN, or a non-integer. The enforcer treats
    // out-of-contract policy as disabled (safer-failure direction) so
    // compaction lifecycle remains operator-controlled even on bad
    // config. Mirrors the per-key constraint in
    // user-settings/settings-store.ts KEY_CONSTRAINTS.
    if (
      typeof policy.thresholdPercent !== "number"
      || !Number.isFinite(policy.thresholdPercent)
      || !Number.isInteger(policy.thresholdPercent)
      || policy.thresholdPercent < 1
      || policy.thresholdPercent > 100
    ) {
      return { triggered: false, reason: "invalid_policy" };
    }
    if (input.usedPercentage < policy.thresholdPercent) {
      return { triggered: false, reason: "below_threshold" };
    }

    const now = Date.now();
    const last = this.lastAutoCompactAt.get(input.sessionName);
    if (last !== undefined && now - last < this.dedupWindowMs) {
      return { triggered: false, reason: "dedup_window" };
    }

    const result = await this.sessionTransport.send(input.sessionName, "/compact");
    if (!result.ok) {
      return { triggered: false, reason: "send_failed" };
    }
    this.lastAutoCompactAt.set(input.sessionName, now);
    return { triggered: true };
  }
}
