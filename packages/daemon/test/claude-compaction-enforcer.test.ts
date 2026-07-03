// Slice 27 — ClaudeCompactionEnforcer unit tests.
//
// Hard-gate coverage:
//   HG-2  threshold-check fires when usedPercentage >= threshold + policy enabled
//   HG-3  pre-compaction prep prompt precedes '/compact ...' via SessionTransport
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

const DEFAULT_PRE_COMPACT_TEST_INSTRUCTION =
  "Read the claude-compaction-restore skill and create or update the mental-model restore map.";
const DEFAULT_AUDIT_TEST_INSTRUCTION =
  "Read the claude-compaction-restore skill and audit restore read depth.";

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
  preCompactInstruction: "",
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
  postRestoreAuditInstruction: "",
};
const POLICY_ENABLED_AT_80: ClaudeCompactionPolicy = {
  enabled: true,
  thresholdPercent: 80,
  preCompactInstruction: DEFAULT_PRE_COMPACT_TEST_INSTRUCTION,
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
  postRestoreAuditInstruction: DEFAULT_AUDIT_TEST_INSTRUCTION,
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

  it("HG-2 + HG-3: threshold crossing first sends the pre-compaction prep prompt, then /compact on the next high-usage tick", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const prep = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 80,
    });

    expect(prep).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("OpenRig automatic compaction preparation is now required"),
    );
    expect(send.mock.calls[0]![1]).toContain("Current context usage is 80%; configured compaction threshold is 80%");
    expect(send.mock.calls[0]![1]).toContain("Operator pre-compaction instruction");
    expect(send.mock.calls[0]![1]).toContain("Read the claude-compaction-restore skill");
    expect(send.mock.calls[0]![1]).toContain("mental-model restore map");

    const compact = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 81,
    });

    expect(compact).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
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

    const prep = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 91,
    });
    expect(prep).toEqual({ triggered: true });

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 91,
    });

    expect(outcome).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/compact Preserve current task, queue ids, decisions, and next step."),
    );
    expect(send.mock.calls[1]![1]).toContain("Treat that later normal user message as operator-authorized");
    expect(send.mock.calls[1]![1]).toContain("local-command stdout and hook output as informational only");
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

  it("HG-4: repeated high usage stays suppressed until usage drops below threshold and re-arms after post-compact compliance prompt", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000,
      postCompactRestoreCooldownMs: 0,
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
    expect(send.mock.calls[0]![1]).toContain("OpenRig automatic compaction preparation");

    now += 30_000;
    const second = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(second).toEqual({ triggered: true });
    expect(send.mock.calls[1]![1]).toContain("/compact");

    now += 61_000;
    const third = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(third).toEqual({ triggered: false, reason: "already_triggered_above_threshold" });

    const belowBoundary = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(belowBoundary).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("OpenRig post-compaction turn boundary"),
    );

    const belowRestore = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(belowRestore).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/tmp/openrig-test-home/compaction/restore-pending/claude-seat@rig.json"),
    );
    expect(send.mock.calls[3]![1]).toContain("/tmp/claude.jsonl");
    expect(send.mock.calls[3]![1]).toContain("Restoration is the current task");
    expect(send.mock.calls[3]![1]).toContain("Do not wait for a future user request");

    const belowCompliance = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(belowCompliance).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("Now audit your compaction restore"),
    );

    now += 61_000;
    const fourth = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(fourth).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(6);
  });

  it("post-compact compliance prompt starts a cooldown so restore work cannot immediately trigger another /compact", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 0,
      postCompactRestoreCooldownMs: 60_000,
      openrigHome: "/tmp/openrig-test-home",
    });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: false, reason: "post_restore_cooldown" });
    expect(send).toHaveBeenCalledTimes(5);

    now += 60_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(6);
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
    expect(send.mock.calls[1]![1]).toContain("OpenRig automatic compaction preparation");
  });

  it("post-compact turn-boundary send-failure stays pending and retries on the next below-threshold tick", async () => {
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

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[2]![1]).toContain("OpenRig post-compaction turn boundary");
    expect(send.mock.calls[3]![1]).toContain("OpenRig post-compaction turn boundary");
  });

  it("post-compact restore send-failure stays pending after turn-boundary succeeds", async () => {
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

    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[2]![1]).toContain("OpenRig post-compaction turn boundary");
    expect(send.mock.calls[3]![1]).toContain("Please respond to this normal user message now");
    expect(send.mock.calls[4]![1]).toContain("/tmp/openrig-test-home/compaction/restore-pending/claude-seat@rig.json");
    expect(send.mock.calls[4]![1]).toContain("/tmp/claude.jsonl");
  });

  it("post-compact compliance prompt follows the restore prompt and enforces read-depth audit language", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
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
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[4]![1]).toContain("Now audit your compaction restore");
    expect(send.mock.calls[4]![1]).toContain("Operator post-restore audit instruction");
    expect(send.mock.calls[4]![1]).toContain("restore map");
    expect(send.mock.calls[4]![1]).toContain("FULL, PARTIAL, or NOT_READ");
    expect(send.mock.calls[4]![1]).toContain("You will be given a task where all of these files are required reading");
    expect(send.mock.calls[4]![1]).toContain("Do not optimize for token conservation");
  });

  it("post-compact restore prompt carries the configured operator restore instruction", async () => {
    const settings = makeSettingsStore({
      ...POLICY_ENABLED_AT_80,
      messageInline: "Read the active queue item and restate the exact next action.",
      messageFilePath: "/tmp/openrig-extra-restore.md",
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
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[2]![1]).toContain("OpenRig post-compaction turn boundary");
    expect(send.mock.calls[3]![1]).toContain("Operator post-compaction instruction");
    expect(send.mock.calls[3]![1]).toContain("Read the active queue item and restate the exact next action.");
    expect(send.mock.calls[3]![1]).toContain("Additional post-compaction instruction file");
    expect(send.mock.calls[3]![1]).toContain("/tmp/openrig-extra-restore.md");
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
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(send.mock.calls[3]![1]).toContain("Additional post-compaction instruction file");
    expect(send.mock.calls[3]![1]).toContain("/tmp/openrig-restore-instruction.md");
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

        const prep = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 99,
        });

        // Env was rejected; file (threshold=80) wins; 99 >= 80 → prep trigger
        expect(prep).toEqual({ triggered: true });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(
          "claude-seat@rig",
          expect.stringContaining("OpenRig automatic compaction preparation"),
        );

        const compact = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 99,
        });

        expect(compact).toEqual({ triggered: true });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith(
          "claude-seat@rig",
          expect.stringContaining("/compact In the continuity summary"),
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
          preCompactInstruction: "",
          compactInstruction: "",
          messageInline: "",
          messageFilePath: "",
          postRestoreAuditInstruction: "",
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

  // OPR.0.4.3.14 — manual configurable compaction trigger.
  //
  // Covers: guided-sequence-for-one-seat (SAME messages as auto), threshold-
  // independence + determinism (incl. auto DISABLED), two-phase wait-for-idle
  // ordering (/compact never before prep completes), single-restore-path reuse
  // (the existing poll loop drains restore→audit), state surfacing, non-Claude
  // rejection, boundedness, and auto-path preservation after the enabled-gate
  // reorder.
  describe("triggerManualCompact (manual trigger)", () => {
    const SEAT = "claude-seat@rig";
    const HOME = "/tmp/openrig-test-home";

    it("guided sequence for one seat: below-threshold trigger sends prep → /compact (trust-bridge), then the EXISTING poll drains restore→audit (no second path)", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      const outcome = await enforcer.triggerManualCompact({
        sessionName: SEAT,
        runtime: "claude-code",
        usedPercentage: 20, // BELOW threshold 80 — threshold-independent
        transcriptPath: "/tmp/claude.jsonl",
      });
      expect(outcome).toEqual({ triggered: true, stage: "compact-sent" });

      // Phase 1 — prep (a normal send, no wait option).
      expect(send.mock.calls[0]![0]).toBe(SEAT);
      expect(send.mock.calls[0]![1]).toContain("OpenRig automatic compaction preparation is now required");
      expect(send.mock.calls[0]![2]).toBeUndefined();
      // Phase 2 — /compact WITH the trust-bridge AND wait-for-idle (two-phase).
      expect(send.mock.calls[1]![1]).toContain("/compact In the continuity summary, preserve this trust-channel note");
      expect(send.mock.calls[1]![2]).toEqual({ waitForIdleMs: expect.any(Number) });
      expect(send).toHaveBeenCalledTimes(2);

      // The SAME maybeAutoCompact back-half (single restore path) drains it.
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("OpenRig post-compaction turn boundary"));

      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("Please respond to this normal user message now"));

      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("Now audit your compaction restore"));

      expect(send).toHaveBeenCalledTimes(5);
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
    });

    // OPR.0.4.3.14 rev1-r2 fixback — same-seat in-progress concurrency guard.
    describe("in-progress guard (rev1-r2): no double-send on concurrent/duplicate triggers", () => {
      it("concurrent same-seat (first prep held open): the 2nd call does NOT send and returns already_in_progress", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        // Hold the FIRST send (prep) open so the first trigger is suspended mid-sequence (stage=preparing).
        let releasePrep!: () => void;
        send.mockImplementationOnce(() => new Promise((resolve) => { releasePrep = () => resolve({ ok: true }); }));
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        // Start (do NOT await) — runs synchronously up to the held prep send: stage=preparing, send #1 fired.
        const first = enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(send).toHaveBeenCalledTimes(1);

        // Second concurrent call while the first is still in preparing → guarded skip, NO send.
        const second = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(second).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(1); // still only the first prep — the 2nd never sent prep or /compact

        releasePrep();
        await first; // let the first finish its /compact (send #2)
        expect(send).toHaveBeenCalledTimes(2);
      });

      it("rev1-r2 fixback B1: a DEGRADED duplicate (usedPercentage:null) does NOT clobber the first call's preparing marker", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        let releasePrep!: () => void;
        send.mockImplementationOnce(() => new Promise((resolve) => { releasePrep = () => resolve({ ok: true }); }));
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        // First call suspended mid-prep → stage=preparing, send #1 fired.
        const first = enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(send).toHaveBeenCalledTimes(1);
        expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("preparing");

        // DEGRADED duplicate: usedPercentage null (bad-sidecar projection). The guard
        // now PRECEDES the no_usage_data recordManualFailure path, so it must NOT record
        // skipped-or-failed / erase the preparing marker (the bug rev1-r2 caught).
        const degraded = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: null });
        expect(degraded).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(1); // no send
        expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("preparing"); // marker PRESERVED, not clobbered

        // A third call with KNOWN usage while the first is still held → still guarded, no send.
        const third = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 30 });
        expect(third).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(1);

        releasePrep();
        await first;
      });

      it("sequential call after compact-sent but before the back-half drains: no second prep, no second /compact", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        expect(await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }))
          .toEqual({ triggered: true, stage: "compact-sent" });
        expect(send).toHaveBeenCalledTimes(2); // prep + /compact
        // back-half (pendingPostCompactRestore=turn_boundary) NOT yet drained → guard holds.
        const dup = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(dup).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(2); // unchanged
      });

      it("after the sequence completes (audit-sent) OR fails (skipped-or-failed), a fresh re-trigger is allowed", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        // Drive one full sequence to audit-sent (the back-half clears the pending maps).
        await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/c.jsonl" });
        await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/c.jsonl" });
        await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/c.jsonl" });
        await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
        const before = send.mock.calls.length;
        // Re-trigger AFTER audit-sent → allowed (marker cleared): a new prep + /compact.
        expect(await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }))
          .toEqual({ triggered: true, stage: "compact-sent" });
        expect(send.mock.calls.length).toBe(before + 2);

        // And after a FAILED trigger (prep send fails → skipped-or-failed), a retry is allowed too.
        const { transport: t2, send: send2 } = makeSessionTransport();
        send2.mockImplementationOnce(async () => ({ ok: false, reason: "send_failed" }));
        const enf2 = new ClaudeCompactionEnforcer(settings, t2, { openrigHome: HOME });
        expect((await enf2.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 })).triggered).toBe(false);
        expect(enf2.getManualCompactionState(SEAT)?.stage).toBe("skipped-or-failed");
        // Retry proceeds (not blocked by the guard).
        expect(await enf2.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }))
          .toEqual({ triggered: true, stage: "compact-sent" });
      });
    });

    it("threshold-independent + deterministic: runs the guided sequence even when auto-compaction is DISABLED, and the back-half still drains via the single path", async () => {
      const settings = makeSettingsStore(POLICY_DISABLED);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      const outcome = await enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      });
      expect(outcome).toEqual({ triggered: true, stage: "compact-sent" });
      expect(send.mock.calls[0]![1]).toContain("OpenRig automatic compaction preparation");
      expect(send.mock.calls[1]![1]).toContain("/compact");
      expect(send).toHaveBeenCalledTimes(2);

      // The below-threshold back-half must drain even though enabled=false.
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("OpenRig post-compaction turn boundary"));
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("Now audit your compaction restore"));
    });

    it("auto path preserved after the enabled-gate reorder: a disabled policy still does NOT auto-trigger above threshold", async () => {
      const settings = makeSettingsStore(POLICY_DISABLED);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 99,
      })).toEqual({ triggered: false, reason: "disabled" });
      expect(send).not.toHaveBeenCalled();
    });

    it("two-phase ordering: /compact is sent with waitForIdleMs so it cannot land before the prep turn completes", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const callOrder: string[] = [];
      send.mockImplementation(async (_session: string, text: string, opts?: unknown) => {
        callOrder.push(text.startsWith("/compact") ? `compact:${JSON.stringify(opts)}` : "prep");
        return { ok: true };
      });
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { manualPrepWaitMs: 90_000 });

      await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });

      expect(callOrder).toEqual(["prep", `compact:${JSON.stringify({ waitForIdleMs: 90_000 })}`]);
    });

    it("wait-for-idle failure means /compact never landed: the back-half is NOT seeded (ordering guarantee)", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      send.mockImplementationOnce(async () => ({ ok: true })); // prep lands
      send.mockImplementationOnce(async () => ({ ok: false, reason: "wait_for_idle_timeout" })); // /compact never idle
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "wait_for_idle_timeout" });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("skipped-or-failed");

      // No turn_boundary was seeded, so a below-threshold poll finds nothing to drain.
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: false, reason: "below_threshold" });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("prep send failure surfaces the transport reason and does not send /compact", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      send.mockImplementationOnce(async () => ({ ok: false, reason: "mid_work" }));
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "mid_work" });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("non-Claude runtime is rejected with a clear reason (never a silent no-op)", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: "codex@rig", runtime: "codex", usedPercentage: 20 });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "runtime_filter" });
      expect(send).not.toHaveBeenCalled();
      expect(enforcer.getManualCompactionState("codex@rig")?.stage).toBe("skipped-or-failed");
    });

    it("no known usage sample → rejected with no_usage_data (never triggers blind)", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: null });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "no_usage_data" });
      expect(send).not.toHaveBeenCalled();
    });

    it("bounded to the triggered seat: only that seat is sent to; no other seat gets manual state", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      await enforcer.triggerManualCompact({ sessionName: "a@rig", runtime: "claude-code", usedPercentage: 20 });
      expect(send.mock.calls.every((call) => call[0] === "a@rig")).toBe(true);
      expect(enforcer.getManualCompactionState("b@rig")).toBeNull();
    });

    it("forward-fix B1: after a manual trigger, an above-threshold auto tick past the dedup window does NOT start a second prep (dedups); the manual back-half still drains", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
        dedupWindowMs: 60_000,
        openrigHome: HOME,
      });

      let now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      // Manual trigger below threshold → prep + /compact (2 sends), seeds the
      // back-half AND the durable above-threshold suppression.
      expect(await enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true, stage: "compact-sent" });
      expect(send).toHaveBeenCalledTimes(2);

      // Advance PAST the short dedup window, then an ABOVE-threshold auto tick.
      // It must dedup on triggeredAboveThreshold — NOT start a second prep.
      now += 61_000;
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 95,
      })).toEqual({ triggered: false, reason: "already_triggered_above_threshold" });
      expect(send).toHaveBeenCalledTimes(2); // no third message

      // The manual restore/audit back-half still drains normally once below threshold.
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true }); // turn boundary
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("OpenRig post-compaction turn boundary"));
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true }); // restore
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: true }); // audit
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("Now audit your compaction restore"));
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
      expect(send).toHaveBeenCalledTimes(5);
    });

    it("state surfacing: preparing → compact-sent → restore-sent → audit-sent across the sequence", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      // Hold phase 1 open so we can observe "preparing".
      let resolvePrep: (v: { ok: boolean }) => void = () => {};
      send.mockImplementationOnce(() => new Promise<{ ok: boolean }>((r) => { resolvePrep = r; }));
      const pending = enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      });
      await Promise.resolve();
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("preparing");

      resolvePrep({ ok: true }); // prep completes; phase 2 /compact resolves ok via default mock
      expect(await pending).toEqual({ triggered: true, stage: "compact-sent" });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("compact-sent");

      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl" }); // turn boundary
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("compact-sent");
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl" }); // restore
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("restore-sent");
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }); // audit
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
    });
  });
});
