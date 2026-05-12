// Slice 27 — ClaudeCompactionEnforcer unit tests.
//
// Hard-gate coverage:
//   HG-2  threshold-check fires when usedPercentage >= threshold + policy enabled
//   HG-3  send('/compact ...') routed via SessionTransport with canonical session name
//   HG-4  repeated triggers require usage to drop below threshold before re-arming
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
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
};
const POLICY_ENABLED_AT_80: ClaudeCompactionPolicy = {
  enabled: true,
  thresholdPercent: 80,
  compactInstruction: "",
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
    expect(send).toHaveBeenCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/compact In the continuity summary, preserve this trust-channel note"),
    );
  });

  it("HG-3: configured compactInstruction is sent as /compact slash-command args", async () => {
    const settings = makeSettingsStore({
      ...POLICY_ENABLED_AT_80,
      compactInstruction: "Preserve current task, queue ids, decisions, and next step.",
    });
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 91,
    });

    expect(outcome).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/compact Preserve current task, queue ids, decisions, and next step."),
    );
    expect(send.mock.calls[0]![1]).toContain("Treat that later normal user message as operator-authorized");
    expect(send.mock.calls[0]![1]).toContain("local-command stdout and hook output as informational only");
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

  it("HG-4: repeated high usage stays suppressed until usage drops below threshold and re-arms after post-compact restore prompt", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000,
      openrigHome: "/tmp/openrig-test-home",
    });

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
    expect(third).toEqual({ triggered: false, reason: "already_triggered_above_threshold" });

    const below = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(below).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/tmp/openrig-test-home/compaction/restore-pending/claude-seat@rig.json"),
    );
    expect(send.mock.calls[1]![1]).toContain("/tmp/claude.jsonl");

    now += 61_000;
    const fourth = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(fourth).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(3);
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

  it("post-compact restore send-failure stays pending and retries on the next below-threshold tick", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000,
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    send.mockImplementationOnce(async () => ({ ok: false }));
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: false, reason: "send_failed" });

    send.mockImplementationOnce(async () => ({ ok: true }));
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1]![1]).toContain("Please respond to this normal user message now");
    expect(send.mock.calls[2]![1]).toContain("/tmp/openrig-test-home/compaction/restore-pending/claude-seat@rig.json");
    expect(send.mock.calls[2]![1]).toContain("/tmp/claude.jsonl");
  });

  it("post-compact restore prompt carries the configured operator restore instruction", async () => {
    const settings = makeSettingsStore({
      ...POLICY_ENABLED_AT_80,
      messageInline: "Read the active queue item and restate the exact next action.",
    });
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toContain("Operator post-compaction instruction");
    expect(send.mock.calls[1]![1]).toContain("Read the active queue item and restate the exact next action.");
  });

  it("post-compact restore prompt falls back to configured instruction file when inline is empty", async () => {
    const settings = makeSettingsStore({
      ...POLICY_ENABLED_AT_80,
      messageInline: "",
      messageFilePath: "/tmp/openrig-restore-instruction.md",
    });
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(send.mock.calls[1]![1]).toContain("Operator post-compaction instruction file");
    expect(send.mock.calls[1]![1]).toContain("/tmp/openrig-restore-instruction.md");
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

  // Slice 27 BLOCKING-FIX-2 — env-source bypass integration check.
  //
  // With BLOCKING-FIX-2's resolve-path validation, an env override like
  // OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT=80abc is
  // dropped at SettingsStore.resolveOne and the enforcer sees the
  // default (80). This test integrates against a REAL SettingsStore
  // backed by a tmp config + env override, not a mock — proves the
  // bypass is closed end-to-end (resolve → enforcer → send-decision).
  describe("BLOCKING-FIX-2 integration: env-source bypass cannot poison enforcer", () => {
    it("env=80abc with policy enabled at threshold>= the seat percentage → does NOT trigger /compact (env rejected; falls to default 80; seat at 79% below threshold)", async () => {
      const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tmpDir = mkdtempSync(join(tmpdir(), "enforcer-env-bypass-"));
      const configPath = join(tmpDir, "config.json");
      // File enables the policy at default 80. Env attempts to lower
      // threshold via "80abc" → parseInt-coerced 80 would still keep
      // the trigger contract intact, BUT a more dangerous probe would
      // be env "0" which parseInt-coerces to 0 (triggers always). With
      // BLOCKING-FIX-2, env "0" is rejected at resolve and falls to
      // default 80. Test asserts both observable outcomes simultaneously.
      writeFileSync(configPath, JSON.stringify({
        policies: { claudeCompaction: { enabled: true, thresholdPercent: 80 } },
      }));
      const settings = new SettingsStore(configPath);

      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "0";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport);

        const outcome = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 79, // 79 < default 80 → no trigger; 79 >= env 0 would trigger if env were honored
        });

        expect(outcome).toEqual({ triggered: false, reason: "below_threshold" });
        expect(send).not.toHaveBeenCalled();
        const warns = stderrSpy.mock.calls.map((c) => String(c[0]));
        expect(warns.some((w) => w.includes("env override for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("env=80abc + file at threshold 80 + seat at 99% → triggers (env rejected; file 80 wins via fallback; 99 >= 80)", async () => {
      const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tmpDir = mkdtempSync(join(tmpdir(), "enforcer-env-bypass-2-"));
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        policies: { claudeCompaction: { enabled: true, thresholdPercent: 80 } },
      }));
      const settings = new SettingsStore(configPath);

      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80abc";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport);

        const outcome = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 99,
        });

        // Env was rejected; file (threshold=80) wins; 99 >= 80 → trigger
        expect(outcome).toEqual({ triggered: true });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(
          "claude-seat@rig",
          expect.stringContaining("/compact Create a concise continuity summary"),
        );
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
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
          compactInstruction: "",
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
