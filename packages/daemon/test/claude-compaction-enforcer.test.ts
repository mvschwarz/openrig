// Slice 27 — ClaudeCompactionEnforcer unit tests.
//
// Hard-gate coverage:
//   HG-2  threshold-check fires when usedPercentage >= threshold + policy enabled
//   HG-3  send('/compact') routed via SessionTransport with canonical session name
//   HG-4  dedup window blocks repeated triggers within the configured interval
//   HG-5  opt-in default-off — with policy disabled the enforcer must NOT fire
//         (REGRESSION GATE for compaction lifecycle blast radius)
//
// Plus runtime-filter (claude-code only), below-threshold gating, missing
// usage data short-circuit, send-failure no-dedup-update semantics.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { ClaudeCompactionPolicy, SettingsStore } from "../src/domain/user-settings/settings-store.js";

function makeSettingsStore(policy: ClaudeCompactionPolicy): SettingsStore {
  return {
    resolveClaudeCompactionPolicy: vi.fn(() => policy),
  } as unknown as SettingsStore;
}

function makeSessionTransport(sendResult: { ok: boolean } = { ok: true }): {
  transport: SessionTransport;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => sendResult);
  return {
    transport: { send } as unknown as SessionTransport,
    send,
  };
}

const POLICY_DISABLED: ClaudeCompactionPolicy = {
  enabled: false,
  thresholdPercent: 80,
  messageInline: "",
  messageFilePath: "",
};
const POLICY_ENABLED_AT_80: ClaudeCompactionPolicy = {
  enabled: true,
  thresholdPercent: 80,
  messageInline: "",
  messageFilePath: "",
};

describe("ClaudeCompactionEnforcer", () => {
  let dateNow: () => number;
  beforeEach(() => {
    let t = 1_700_000_000_000;
    dateNow = vi.spyOn(Date, "now").mockImplementation(() => t) as unknown as () => number;
    void dateNow;
    // Advance the mock by re-defining via closures below where needed.
    vi.restoreAllMocks();
  });

  it("HG-5: opt-in default-off — disabled policy must NOT trigger send", async () => {
    const settings = makeSettingsStore(POLICY_DISABLED);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 99,
    });

    expect(outcome).toEqual({ triggered: false, reason: "disabled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("HG-2 + HG-3: fires when usedPercentage >= threshold AND policy enabled; sends '/compact' to the session", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 80,
    });

    expect(outcome).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("claude-seat@rig", "/compact");
  });

  it("HG-2 negative path: below-threshold usage does NOT trigger send", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 79,
    });

    expect(outcome).toEqual({ triggered: false, reason: "below_threshold" });
    expect(send).not.toHaveBeenCalled();
  });

  it("HG-4: dedup window blocks repeated trigger within interval (default 60s)", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, { dedupWindowMs: 60_000 });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const first = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 90,
    });
    expect(first).toEqual({ triggered: true });

    now += 30_000;
    const second = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(second).toEqual({ triggered: false, reason: "dedup_window" });

    now += 31_000;
    const third = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(third).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("runtime filter: only claude-code triggers (codex sessions return runtime_filter without invoking send)", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "codex-seat@rig",
      runtime: "codex",
      usedPercentage: 99,
    });

    expect(outcome).toEqual({ triggered: false, reason: "runtime_filter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("missing usage data short-circuits without invoking settings or send", async () => {
    const policySpy = vi.fn(() => POLICY_ENABLED_AT_80);
    const settings = { resolveClaudeCompactionPolicy: policySpy } as unknown as SettingsStore;
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: null,
    });

    expect(outcome).toEqual({ triggered: false, reason: "no_usage_data" });
    expect(policySpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("send-failure: returns send_failed without recording dedup (next tick can retry)", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport({ ok: false });
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, { dedupWindowMs: 60_000 });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const first = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(first).toEqual({ triggered: false, reason: "send_failed" });

    // Second tick 1s later: dedup must NOT block (no successful send was
    // recorded). Send is attempted again.
    now += 1_000;
    send.mockImplementationOnce(async () => ({ ok: true }));
    const second = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(second).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("dedup keyed per-session: two distinct seats do not block each other", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, { dedupWindowMs: 60_000 });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect(await enforcer.maybeAutoCompact({ sessionName: "a@rig", runtime: "claude-code", usedPercentage: 99 })).toEqual({ triggered: true });
    expect(await enforcer.maybeAutoCompact({ sessionName: "b@rig", runtime: "claude-code", usedPercentage: 99 })).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe("a@rig");
    expect(send.mock.calls[1]![0]).toBe("b@rig");
  });

  // Slice 27 BLOCKING-FIX — defense-in-depth at the enforcer.
  //
  // The CLI + daemon set() paths reject invalid threshold input, but a
  // hand-edited ~/.openrig/config.json could still inject 0, 101, NaN,
  // or a non-integer (the file read path passes the value through
  // without re-validation by design). The enforcer is the last
  // safety net before send: it MUST treat an out-of-contract
  // thresholdPercent as disabled (returns `invalid_policy`, no send).
  describe("BLOCKING-FIX: defense-in-depth on hand-edited bad policy values", () => {
    const cases: Array<{ name: string; thresholdPercent: number }> = [
      { name: "0 (would trigger on every tick)", thresholdPercent: 0 },
      { name: "101 (above range)", thresholdPercent: 101 },
      { name: "-1 (below range)", thresholdPercent: -1 },
      { name: "80.5 (non-integer)", thresholdPercent: 80.5 },
      { name: "NaN", thresholdPercent: Number.NaN },
      { name: "Infinity", thresholdPercent: Number.POSITIVE_INFINITY },
    ];

    for (const c of cases) {
      it(`treats threshold=${c.name} as invalid_policy; never sends`, async () => {
        const settings = makeSettingsStore({
          enabled: true,
          thresholdPercent: c.thresholdPercent,
          messageInline: "",
          messageFilePath: "",
        });
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport);

        const outcome = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 99, // would trigger if policy were valid
        });

        expect(outcome).toEqual({ triggered: false, reason: "invalid_policy" });
        expect(send).not.toHaveBeenCalled();
      });
    }
  });
});
