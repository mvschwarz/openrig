import { describe, it, expect } from "vitest";
import { precheckSwitch } from "../src/domain/provider/provider-policy.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";

// Slice-04 (OPR.0.5.0.4) — the §1 precheck contract (proof item 7, unit portion). precheck
// returns { safe: true } | { safe: false, reasons[] } so the UI/automation never offers an
// unsafe switch. Reasons at minimum: would_strand_live_conversation, target_needs_reauth
// (validate-at-use), signal_unknown_or_stale, rebind_unsupported_for_runtime. Every unsafe
// condition is explicit and fail-visible; reasons combine.

const NOW = "2026-08-03T12:00:00.000Z";
const FRESH = "2026-08-03T12:05:00.000Z";
const STALE = "2026-08-03T11:55:00.000Z";

const FRESH_KNOWN_SIGNAL: ProviderSignal = {
  provider: "codex",
  accountRef: "acct-1",
  sourceClass: "provider_structured_read",
  authority: "account_cross_device",
  window: "primary",
  usedPercent: 96,
  asOf: NOW,
  staleAfter: FRESH,
  supportsNotification: true,
  automationUse: "allow_switch_decision",
};

describe("precheckSwitch — §1 switch-safety gate", () => {
  it("a codex target with active auth, no live conversation, fresh known signal is SAFE", () => {
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: FRESH_KNOWN_SIGNAL,
      now: NOW,
    });
    expect(r.safe).toBe(true);
  });

  it("a claude target is rebind_unsupported_for_runtime (rig auth is codex-only)", () => {
    const r = precheckSwitch({ targetProvider: "claude", targetAuthState: "active", seatHasLiveConversation: false });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("rebind_unsupported_for_runtime");
  });

  it("a target needing reauth is target_needs_reauth (validate-at-use)", () => {
    const r = precheckSwitch({ targetProvider: "codex", targetAuthState: "needs_reauth", seatHasLiveConversation: false });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("target_needs_reauth");
  });

  it("a target with UNKNOWN auth fails closed under the DISTINCT target_auth_unknown reason", () => {
    const r = precheckSwitch({ targetProvider: "codex", targetAuthState: "unknown", seatHasLiveConversation: false });
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reasons).toContain("target_auth_unknown");
      // unknown is NOT relabeled as a re-auth need.
      expect(r.reasons).not.toContain("target_needs_reauth");
    }
  });

  it("a live conversation on the seat is would_strand_live_conversation", () => {
    const r = precheckSwitch({ targetProvider: "codex", targetAuthState: "active", seatHasLiveConversation: true });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("would_strand_live_conversation");
  });

  it("an unknown/stale triggering signal is signal_unknown_or_stale (reuses the BR-2 predicate)", () => {
    const staleSignal: ProviderSignal = { ...FRESH_KNOWN_SIGNAL, staleAfter: STALE };
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: staleSignal,
      now: NOW,
    });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("signal_unknown_or_stale");
  });

  it("an advisory (non-unknown, non-stale) triggering signal does NOT add signal_unknown_or_stale", () => {
    const advisory: ProviderSignal = { ...FRESH_KNOWN_SIGNAL, automationUse: "advisory_only" };
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: advisory,
      now: NOW,
    });
    // advisory is a BR-2 concern, NOT an unknown/stale precheck concern — this switch is safe.
    expect(r.safe).toBe(true);
  });

  it("fail-closed: an untyped caller passing a trigger WITHOUT now is unsafe (signal_unknown_or_stale)", () => {
    // Deliberate untyped/JS-style call (the paired union forbids this for typed callers): a
    // triggering signal is present but `now` is omitted. A missing clock cannot prove freshness,
    // so it must NOT silently return safe.
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: FRESH_KNOWN_SIGNAL,
    } as unknown as Parameters<typeof precheckSwitch>[0]);
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("signal_unknown_or_stale");
  });

  it("multiple unsafe conditions combine into all their reasons", () => {
    const r = precheckSwitch({
      targetProvider: "claude",
      targetAuthState: "needs_reauth",
      seatHasLiveConversation: true,
    });
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reasons).toContain("rebind_unsupported_for_runtime");
      expect(r.reasons).toContain("target_needs_reauth");
      expect(r.reasons).toContain("would_strand_live_conversation");
    }
  });
});
