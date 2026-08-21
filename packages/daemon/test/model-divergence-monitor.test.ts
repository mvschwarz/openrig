// B8 / slice-07 A3 — the model-divergence detector + four-channel proclamation.
// RED-first shape per the PRD: a pinned seat whose EFFECTIVE model differs boots fine AND all four
// channels carry the proclamation (three deliveries + the named Slack deferral); silence on any
// channel is the failure. Cause-agnostic: nothing here inspects WHY the models differ.

import { describe, it, expect, vi } from "vitest";
import {
  ModelDivergenceMonitor,
  SLACK_DEFERRAL_LINE,
  PENDING_VISIBILITY_POLLS,
  modelsMatch,
  formatProclamation,
  type PinnedSeat,
} from "../src/domain/model-divergence/model-divergence-monitor.js";

const SEAT: PinnedSeat = {
  nodeId: "n1",
  sessionName: "dev-impl@r",
  rigId: "rig-1",
  rigName: "r",
  runtime: "codex",
  pinnedModel: "gpt-5.1-codex-mini",
  generation: "gen-1",
};

function makeMonitor(overrides?: Partial<ConstructorParameters<typeof ModelDivergenceMonitor>[0]>) {
  const sent: Array<{ target: string; message: string }> = [];
  const recorded: unknown[] = [];
  const monitor = new ModelDivergenceMonitor({
    listPinnedSeats: () => [SEAT],
    readEffectiveModel: () => ({ ok: true as const, model: "gpt-5.4-mini" }), // specimen #1's silent fallback
    sendToSession: async (target, message) => { sent.push({ target, message }); return { ok: true }; },
    resolveOrchSeats: () => ["orch-lead@r", "orch-advisor@r"],
    resolveOperatorSeat: () => "operator-admin@kernel",
    resolveOversightSeat: () => "watch-lead@oversight",
    recordProclamation: (p) => { recorded.push(p); },
    warn: () => {},
    ...overrides,
  });
  return { monitor, sent, recorded };
}

describe("ModelDivergenceMonitor — the cause-agnostic comparison", () => {
  it("DIVERGENCE (the founder RED case): pinned != effective fires ONE proclamation with all four channels accounted for", async () => {
    const { monitor, sent, recorded } = makeMonitor();
    const fired = await monitor.checkOnce();

    expect(fired).toHaveLength(1);
    const p = fired[0]!;
    expect(p.pinnedModel).toBe("gpt-5.1-codex-mini");
    expect(p.effectiveModel).toBe("gpt-5.4-mini");

    // Three live deliveries: both orch seats + operator + oversight.
    expect(sent.map((s) => s.target)).toEqual(["orch-lead@r", "orch-advisor@r", "operator-admin@kernel", "watch-lead@oversight"]);
    for (const s of sent) {
      expect(s.message).toContain("pinned=gpt-5.1-codex-mini");
      expect(s.message).toContain("effective=gpt-5.4-mini");
    }
    // The Slack channel is present as its NAMED deferral (DS2: no shadow path, no silence).
    const slack = p.channels.find((c) => c.channel === "slack")!;
    expect(slack.status).toBe("deferred");
    expect(slack.detail).toBe(SLACK_DEFERRAL_LINE);
    // Every channel outcome is on the durable record.
    expect(recorded).toHaveLength(1);
    expect(p.channels.filter((c) => c.status === "delivered")).toHaveLength(4);
  });

  it("every-occurrence at the GENERATION grain: one generation never re-proclaims; a NEW generation does", async () => {
    const seats: PinnedSeat[] = [{ ...SEAT }];
    const { monitor, recorded } = makeMonitor({ listPinnedSeats: () => seats });
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(recorded).toHaveLength(1); // no spam within a generation

    seats[0] = { ...SEAT, generation: "gen-2" }; // the successor occupant diverges too
    await monitor.checkOnce();
    expect(recorded).toHaveLength(2); // every occurrence = every occupant
  });

  it("MATCH settles the generation silently; PENDING (no signal yet) keeps checking until a read exists", async () => {
    let effective: string | null = null;
    const { monitor, recorded } = makeMonitor({ readEffectiveModel: () => (effective ? { ok: true as const, model: effective } : { ok: false as const, reason: "no signal" }) });

    await monitor.checkOnce();
    expect(recorded).toHaveLength(0); // pending — never assumed, never settled

    effective = "gpt-5.1-codex-mini";
    await monitor.checkOnce();
    expect(recorded).toHaveLength(0); // match — settled silently

    effective = "gpt-5.4-mini"; // a later flip within the SAME generation stays settled (one verdict per occupant)
    await monitor.checkOnce();
    expect(recorded).toHaveLength(0);
  });

  it("unreachable channels are NAMED failures/deferrals on the record — never silence", async () => {
    const { monitor } = makeMonitor({
      sendToSession: async () => ({ ok: false, error: "route down" }),
      resolveOperatorSeat: () => null,
      resolveOversightSeat: () => null,
    });
    const [p] = await monitor.checkOnce();
    const byChannel = Object.fromEntries(p!.channels.map((c) => [c.channel + ":" + (c.target ?? "-"), c]));
    expect(byChannel["orchestrator:orch-lead@r"]).toMatchObject({ status: "failed", detail: "route down" });
    expect(byChannel["operator:-"]).toMatchObject({ status: "failed", detail: "no operator seat configured" });
    expect(byChannel["oversight:-"]).toMatchObject({ status: "deferred" });
    expect(byChannel["slack:-"]).toMatchObject({ status: "deferred", detail: SLACK_DEFERRAL_LINE });
    expect(p!.channels).toHaveLength(5); // 2 orch + operator + oversight + slack — all accounted for
  });

  it("a proclamation-record failure warns and never blocks the deliveries", async () => {
    const warn = vi.fn();
    const { monitor, sent } = makeMonitor({
      recordProclamation: () => { throw new Error("db locked"); },
      warn,
    });
    const fired = await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(sent.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  it("r1 finding — OBSERVABLE PENDING: a pinned seat with no signal is named ONCE as unchecked after the threshold, never skipped silently forever", async () => {
    const warn = vi.fn();
    const { monitor } = makeMonitor({ readEffectiveModel: () => ({ ok: false as const, reason: "sidecar record belongs to session aaaa…, live occupant is bbbb… (stale-generation record)" }), warn });
    for (let i = 0; i < PENDING_VISIBILITY_POLLS + 5; i++) await monitor.checkOnce();
    const unchecked = warn.mock.calls.filter((c) => String(c[0]).includes("UNCHECKED"));
    expect(unchecked).toHaveLength(1); // named once, not spammed
    expect(String(unchecked[0]![0])).toContain("dev-impl@r");
    expect(String(unchecked[0]![0])).toContain("gpt-5.1-codex-mini");
    // D-a — the READER's named reason rides the warning and the pending surface verbatim.
    expect(String(unchecked[0]![0])).toContain("stale-generation record");
    expect(monitor.pendingSeats()).toHaveLength(1);
    expect(monitor.pendingSeats()[0]!.polls).toBe(PENDING_VISIBILITY_POLLS + 5);
    expect(monitor.pendingSeats()[0]!.reason).toContain("stale-generation");
  });

  it("a late-arriving signal clears the pending state and settles normally", async () => {
    let effective: string | null = null;
    const { monitor, recorded } = makeMonitor({ readEffectiveModel: () => (effective ? { ok: true as const, model: effective } : { ok: false as const, reason: "no signal" }) });
    await monitor.checkOnce();
    expect(monitor.pendingSeats()).toHaveLength(1);
    effective = "gpt-5.1-codex-mini";
    await monitor.checkOnce();
    expect(monitor.pendingSeats()).toHaveLength(0);
    expect(recorded).toHaveLength(0); // match — settled
  });

  it("no pin = no detector involvement at all", async () => {
    const read = vi.fn(() => ({ ok: true as const, model: "anything" }));
    const { monitor, recorded } = makeMonitor({ listPinnedSeats: () => [], readEffectiveModel: read });
    await monitor.checkOnce();
    expect(read).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("the diagnosis rides as information, never as the trigger", async () => {
    const { monitor } = makeMonitor({ diagnose: () => "runtime returned 400 invalid_request_error" });
    const [p] = await monitor.checkOnce();
    expect(p!.diagnosis).toContain("400");
    expect(formatProclamation(p!)).toContain("Diagnosis (informational)");
  });
});

describe("modelsMatch", () => {
  it("exact case-insensitive trim; no alias fuzziness", () => {
    expect(modelsMatch("gpt-5.6-luna", " GPT-5.6-Luna ")).toBe(true);
    expect(modelsMatch("gpt-5.6-luna", "gpt-5.6")).toBe(false);
    expect(modelsMatch("claude-fable-5", "claude-fable-5")).toBe(true);
  });
});
