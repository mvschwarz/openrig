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
import { SPEC_VALIDATION_CAPABILITIES } from "../src/domain/rigspec-schema.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import * as monitorModule from "../src/domain/model-divergence/model-divergence-monitor.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";

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

describe("ModelDivergenceMonitor — ONE process census per pass (perf-process-census, row 20260825035200)", () => {
  it("N unresolved seats trigger EXACTLY ONE process enumeration for the whole checkOnce pass, not one per seat", async () => {
    const seats: PinnedSeat[] = Array.from({ length: 5 }, (_, i) => ({
      ...SEAT, nodeId: `n${i}`, sessionName: `seat${i}@r`, generation: `g${i}`,
    }));
    let scans = 0;
    let reads = 0;
    let clock = 0;
    // The production census: one enumeration underneath, cycle-scoped per pass, with a freshness
    // window (default 2s). Inject the clock so the second pass sits PAST freshness and must re-scan —
    // otherwise the freshness reuse would (correctly) collapse two nearby passes onto one scan too.
    const census = new ProcessCensus({ list: async () => { scans += 1; return []; }, now: () => clock });
    const { monitor } = makeMonitor({
      listPinnedSeats: () => seats,
      processCensus: census,
      // every seat is UNRESOLVED (never settles) and pulls the process table via the
      // pass-scoped census, exactly as the live claude/codex current-generation readers do.
      readEffectiveModel: async (_seat, cycle) => {
        reads += 1;
        await cycle!.listProcesses();
        return { ok: false as const, reason: "pending — no live record this pass" };
      },
    });

    await monitor.checkOnce();
    expect(reads).toBe(5);   // all five unresolved seats were read...
    expect(scans).toBe(1);   // ...but the whole pass did a SINGLE enumeration (not 5)

    // A second pass past the freshness window still does ONE scan for all five seats, never per seat.
    clock = 10_000;
    await monitor.checkOnce();
    expect(reads).toBe(10);
    expect(scans).toBe(2);
  });

  it("checkOnce threads a poll-scoped cycle to every seat when a processCensus is present (load-bearing wiring)", async () => {
    let everySeatGotACycle = true;
    const census = new ProcessCensus({ list: async () => [] });
    const { monitor } = makeMonitor({
      listPinnedSeats: () => [{ ...SEAT }, { ...SEAT, nodeId: "n2", sessionName: "b@r", generation: "g2" }],
      processCensus: census,
      readEffectiveModel: async (_seat, cycle) => {
        if (!cycle) everySeatGotACycle = false;
        return { ok: false as const, reason: "pending" };
      },
    });
    await monitor.checkOnce();
    expect(everySeatGotACycle).toBe(true);
  });
});

describe("ModelDivergenceMonitor — per-seat throw isolation (row 3f66664a, defense-in-depth)", () => {
  it("a seat whose check THROWS is reported as a detector error and does NOT suppress the remaining seats' checks", async () => {
    const thrower: PinnedSeat = { ...SEAT, sessionName: "thrower@r", nodeId: "nT" };
    const diverger: PinnedSeat = { ...SEAT, sessionName: "diverger@r", nodeId: "nD" };
    const warns: string[] = [];
    // The throwing seat is FIRST — before the fix its throw aborts the whole
    // pass, so the diverging seat AFTER it is never checked (silent truncation).
    const { monitor, recorded } = makeMonitor({
      listPinnedSeats: () => [thrower, diverger],
      readEffectiveModel: (seat: PinnedSeat) => {
        if (seat.sessionName === "thrower@r") throw new Error("boom: this seat's comparison threw");
        return { ok: true as const, model: "gpt-5.4-mini" }; // diverges from the codex pin
      },
      warn: (m: string) => warns.push(m),
    });

    const fired = await monitor.checkOnce();

    // the diverging seat AFTER the thrower is still checked + proclaimed
    expect(fired.map((p) => p.sessionName)).toContain("diverger@r");
    expect((recorded as Array<{ sessionName: string }>).map((p) => p.sessionName)).toContain("diverger@r");
    // the throwing seat is reported as a detector error, loudly
    expect(warns.some((w) => w.includes("thrower@r") && /threw/i.test(w))).toBe(true);
  });
});

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

describe("modelsMatch — pin canonicalized through the ONE shipped map, then EXACT (f7dfca0c)", () => {
  it("exact ids match case-insensitively", () => {
    expect(modelsMatch("gpt-5.6-luna", " GPT-5.6-Luna ")).toBe(true);
    expect(modelsMatch("claude-fable-5-1", "claude-fable-5-1")).toBe(true);
  });

  it("SINGLE MAPPING HOME: the deleted migration bridge stays deleted; the monitor consults the advisory's map", async () => {
    // The bridge's own deletion contract completed at f7dfca0c. The monitor module must export
    // NO alias map of its own — CANONICAL_MODEL_PINS in spec-validation-advisory.ts is the one
    // mapping home for spec validation AND the runtime detector. A resurrected local map is the
    // two-registries failure mode; reviewers key on this pin.
    const monitorMod = await import("../src/domain/model-divergence/model-divergence-monitor.js");
    expect("CLAUDE_ALIAS_MIGRATION_BRIDGE" in monitorMod).toBe(false);
    const advisory = await import("../src/domain/spec-validation-advisory.js");
    expect(advisory.CANONICAL_MODEL_PINS.fable).toBe("claude-fable-5-1");
    expect(modelsMatch("fable", advisory.CANONICAL_MODEL_PINS.fable)).toBe(true); // same data drives both
    // r2 BLOCKING-1 structural half: the map must stay null-prototype so arbitrary string pins
    // can never read inherited Object members (behavioral pins cover both consumers).
    expect(Object.getPrototypeOf(advisory.CANONICAL_MODEL_PINS)).toBeNull();
  });

  it("OPR.0.5.3.3: model-pin-canonicalization capability stays REGISTERED (spec advisory contract)", () => {
    expect(SPEC_VALIDATION_CAPABILITIES.has("model-pin-canonicalization")).toBe(true);
  });

  it("r2's ambiguity discriminators stay false: one pin can never bless multiple distinct models", () => {
    expect(modelsMatch("codex", "gpt-5.6-codex")).toBe(false);
    expect(modelsMatch("codex", "gpt-5.1-codex-mini")).toBe(false);
    expect(modelsMatch("mini", "gpt-5.4-mini")).toBe(false);
  });

  it("genuine divergence fails: wrong family, partial ids", () => {
    expect(modelsMatch("fable", "claude-opus-5")).toBe(false);
    expect(modelsMatch("gpt-5.6-luna", "gpt-5.6")).toBe(false);
    expect(modelsMatch("gpt-5.1-codex-mini", "gpt-5.4-mini")).toBe(false);
  });
});

describe("f7dfca0c — alias-pin false positives end AT THE DETECTOR via the one shipped canonical map", () => {
  // Founder-steered, desk-ruled: an alias-pinned seat running exactly the model its alias names
  // is NOT divergent — the ruled class re-proclaimed per generation and per daemon restart.
  // The pin canonicalizes through CANONICAL_MODEL_PINS (spec-validation-advisory.ts, the ONE
  // mapping home) and then compares EXACT. No token containment; r2's ambiguity discriminators
  // (one pin blessing multiple models) stay false in the neighbors above.
  it("RED-1: alias pin canonicalizes — fable matches claude-fable-5-1, with trim/case retained", () => {
    expect(modelsMatch("fable", "claude-fable-5-1")).toBe(true);
    expect(modelsMatch(" FABLE ", " Claude-Fable-5-1 ")).toBe(true);
  });

  it("control: alias pin vs a DIFFERENT canonical model still diverges (unknown aliases too)", () => {
    expect(modelsMatch("fable", "claude-opus-5")).toBe(false);
    expect(modelsMatch("fable", "claude-fable-6")).toBe(false);
    expect(modelsMatch("opus", "claude-opus-5")).toBe(false); // unmapped alias: no blessing
  });

  it("RED-2 (monitor level): an alias-pinned claude seat running its canonical model makes NO proclamation", async () => {
    const seat: PinnedSeat = { ...SEAT, runtime: "claude", pinnedModel: "fable" };
    const { monitor, recorded } = makeMonitor({
      listPinnedSeats: () => [seat],
      readEffectiveModel: () => ({ ok: true as const, model: "claude-fable-5-1" }),
    });
    expect(await monitor.checkOnce()).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("r2 BLOCKING-1: prototype-key pins are UNKNOWN aliases, not inherited Object members — they diverge, never throw", () => {
    // r2's discriminator: CANONICAL_MODEL_PINS[pin] on an ordinary object returns inherited
    // Object.prototype members for valid string pins like "constructor"/"__proto__" — `?? pin`
    // never runs and `.toLowerCase()` throws, aborting the WHOLE detector pass. Lookup must be
    // own-property-only.
    expect(modelsMatch("constructor", "claude-opus-5")).toBe(false);
    expect(modelsMatch("__proto__", "claude-opus-5")).toBe(false);
    expect(modelsMatch("hasOwnProperty", "claude-opus-5")).toBe(false);
  });

  it("r2 BLOCKING-1 (monitor level): a prototype-key pin proclaims RAW and does NOT blind later seats in the pass", async () => {
    const evil: PinnedSeat = { ...SEAT, nodeId: "n-evil", sessionName: "evil@r", runtime: "claude", pinnedModel: "constructor" };
    const later: PinnedSeat = { ...SEAT, nodeId: "n-later", sessionName: "later@r", pinnedModel: "gpt-5.1-codex-mini" };
    const { monitor, recorded } = makeMonitor({
      listPinnedSeats: () => [evil, later],
      readEffectiveModel: (seat: PinnedSeat) =>
        ({ ok: true as const, model: seat.sessionName === "evil@r" ? "claude-opus-5" : "gpt-5.4-mini" }),
    });
    const fired = await monitor.checkOnce();
    // Both divergences proclaim — the pass survives the adversarial pin, raw strings intact.
    expect(fired).toHaveLength(2);
    expect(fired[0]!.pinnedModel).toBe("constructor");
    expect(fired[0]!.effectiveModel).toBe("claude-opus-5");
    expect(fired[1]!.pinnedModel).toBe("gpt-5.1-codex-mini");
    expect(recorded).toHaveLength(2);
  });

  it("control (monitor level): alias pin on the WRONG model proclaims with RAW strings preserved", async () => {
    const seat: PinnedSeat = { ...SEAT, runtime: "claude", pinnedModel: "fable" };
    const { monitor } = makeMonitor({
      listPinnedSeats: () => [seat],
      readEffectiveModel: () => ({ ok: true as const, model: "claude-opus-5" }),
    });
    const fired = await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.pinnedModel).toBe("fable"); // raw pin, never the canonicalized form
    expect(fired[0]!.effectiveModel).toBe("claude-opus-5");
  });
});


describe("Claude context-window pins", () => {
  it.each([
    ["claude-opus-5-5[1m]", "claude-opus-5-5"],
    ["  Claude-Opus-5-5[1M] ", " CLAUDE-OPUS-5-5 "],
    ["fable[1m]", "claude-fable-5-1"],
    ["claude-opus-5-5", "claude-opus-5-5[1m]"],
    ["claude-opus-5-5[1m]", "claude-opus-5-5[1m]"],
  ])("matches %s to %s without proclaiming", async (pinnedModel, model) => {
    const { monitor, sent, recorded } = makeMonitor({
      listPinnedSeats: () => [{ ...SEAT, runtime: "claude-code", pinnedModel }],
      readEffectiveModel: () => ({ ok: true, model }),
    });
    expect(await monitor.checkOnce()).toEqual([]);
    expect(monitor.pendingSeats()).toEqual([]);
    expect(sent).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it.each([
    ["claude-code", "claude-opus-5-5[1m]", "claude-fable-5-1"],
    ["claude-code", "claude-opus-5-5[2m]", "claude-opus-5-5"],
    ["claude-code", "claude-opus-5-5[1m]-extra", "claude-opus-5-5"],
    ["claude-code", "opus[1m]", "claude-opus-5-5"],
    ["claude-code", "fable", "claude-fable-5"],
    ["codex", "claude-opus-5-5[1m]", "claude-opus-5-5"],
    ["pi", "claude-opus-5-5[1m]", "claude-opus-5-5"],
    ["omp", "claude-opus-5-5[1m]", "claude-opus-5-5"],
    [null, "claude-opus-5-5[1m]", "claude-opus-5-5"],
  ])("keeps real divergence for runtime=%s pin=%s effective=%s", async (runtime, pinnedModel, model) => {
    const { monitor, sent, recorded } = makeMonitor({
      listPinnedSeats: () => [{ ...SEAT, runtime, pinnedModel }],
      readEffectiveModel: () => ({ ok: true, model }),
    });
    const fired = await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ runtime, pinnedModel, effectiveModel: model });
    expect(recorded).toHaveLength(1);
    expect(sent).toHaveLength(4);
    for (const message of sent) {
      expect(message.message).toContain(`pinned=${pinnedModel}`);
      expect(message.message).toContain(`effective=${model}`);
    }
    expect(await monitor.checkOnce()).toEqual([]);
  });
});

// A pinned Claude id answers as its dated snapshot: herdr-researcher@lab, pinned to claude-haiku-4-5, reported
// claude-haiku-4-5-20251001 and was proclaimed divergent. The snapshot is the same model; a different one still diverges.
describe("Claude snapshot pins", () => {
  it.each([
    ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    ["  Claude-Haiku-4-5 ", " CLAUDE-HAIKU-4-5-20251001 "],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-sonnet-4-5[1m]", "claude-sonnet-4-5-20250929"],
    ["fable", "claude-fable-5-1-20261001"],
  ])("matches %s to %s without proclaiming", async (pinnedModel, model) => {
    const { monitor, sent, recorded } = makeMonitor({
      listPinnedSeats: () => [{ ...SEAT, runtime: "claude-code", pinnedModel }],
      readEffectiveModel: () => ({ ok: true, model }),
    });
    expect(await monitor.checkOnce()).toEqual([]);
    expect(sent).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it.each([
    ["claude-code", "claude-haiku-4-5", "claude-sonnet-4-5-20250929"],
    ["claude-code", "claude-haiku-4-5-20251001", "claude-haiku-4-5-20260101"],
    ["claude-code", "claude-haiku-4", "claude-haiku-4-5-20251001"],
    ["claude-code", "claude-haiku-4-5", "claude-haiku-4-5-20251001-extra"],
    ["claude-code", "haiku", "claude-haiku-4-5-20251001"],
    ["codex", "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    ["pi", "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    [null, "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
  ])("keeps real divergence for runtime=%s pin=%s effective=%s", async (runtime, pinnedModel, model) => {
    const { monitor, recorded } = makeMonitor({
      listPinnedSeats: () => [{ ...SEAT, runtime, pinnedModel }],
      readEffectiveModel: () => ({ ok: true, model }),
    });
    const fired = await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ runtime, pinnedModel, effectiveModel: model });
    expect(recorded).toHaveLength(1);
  });
});

// The settled set is in memory, so a daemon restart used to alert again on an unchanged divergence (five alerts in eleven
// minutes for two unchanged seats across one recovery). The occurrence id is content-derived, and the proclamation's own
// durable record keeps it.
describe("ModelDivergenceMonitor — a restart doesn't proclaim an unchanged divergence again", () => {
  it("a restarted monitor stays quiet for the same occurrence and alerts for a changed model or a new generation", async () => {
    const proclaimed = new Set<string>();
    const durable = {
      recordProclamation: (p: { occurrenceId?: string }) => { if (p.occurrenceId) proclaimed.add(p.occurrenceId); },
      wasProclaimed: (occurrenceId: string) => proclaimed.has(occurrenceId),
    };
    const first = makeMonitor(durable);
    expect(await first.monitor.checkOnce()).toHaveLength(1);

    const restarted = makeMonitor(durable);
    expect(await restarted.monitor.checkOnce()).toHaveLength(0);
    expect(restarted.sent).toHaveLength(0);
    expect(await restarted.monitor.checkOnce()).toHaveLength(0);

    const changed = makeMonitor({ ...durable, readEffectiveModel: () => ({ ok: true as const, model: "gpt-5.5-mini" }) });
    expect(await changed.monitor.checkOnce()).toHaveLength(1);
    const newOccupant = makeMonitor({ ...durable, listPinnedSeats: () => [{ ...SEAT, generation: "gen-2" }] });
    expect(await newOccupant.monitor.checkOnce()).toHaveLength(1);
  });

  it("an unreadable record still proclaims, and says why", async () => {
    const warnings: string[] = [];
    const { monitor } = makeMonitor({ wasProclaimed: () => { throw new Error("db locked"); }, warn: (m) => warnings.push(m) });
    expect(await monitor.checkOnce()).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/could not read earlier proclamations.*db locked/);
  });

  it("an alert no channel received is proclaimed again after a restart; a received one is not", async () => {
    const db = createFullTestDb();
    const bus = new EventBus(db);
    const proclaimedInEventLog = (monitorModule as { proclaimedInEventLog?: (d: typeof db) => (id: string, nodeId: string) => boolean }).proclaimedInEventLog!;
    const durable = {
      recordProclamation: (p: { rigId: string; nodeId: string; sessionName: string; runtime: string | null; pinnedModel: string; effectiveModel: string; diagnosis: string | null; occurrenceId?: string; channels: Array<{ channel: string; target: string | null; status: string; detail?: string }> }) => {
        bus.emit({ type: "seat.model_divergence", rigId: p.rigId, nodeId: p.nodeId, sessionName: p.sessionName, runtime: p.runtime,
          pinnedModel: p.pinnedModel, effectiveModel: p.effectiveModel, diagnosis: p.diagnosis, occurrenceId: p.occurrenceId, channels: p.channels });
      },
      wasProclaimed: proclaimedInEventLog(db),
    };
    const unreachable = { ...durable, sendToSession: async () => ({ ok: false, error: "no route" }) };
    expect(await makeMonitor(unreachable).monitor.checkOnce()).toHaveLength(1);
    expect(await makeMonitor(unreachable).monitor.checkOnce()).toHaveLength(1); // nobody received it, so a restart alerts again
    expect(await makeMonitor(durable).monitor.checkOnce()).toHaveLength(1);     // delivered this time
    expect(await makeMonitor(durable).monitor.checkOnce()).toHaveLength(0);     // and a restart stays quiet
    db.close();
  });

  it("proclaimedInEventLog answers from the persisted seat.model_divergence event, per node", () => {
    const db = createFullTestDb();
    const bus = new EventBus(db);
    const proclaimedInEventLog = (monitorModule as { proclaimedInEventLog?: (d: typeof db) => (id: string, nodeId: string) => boolean }).proclaimedInEventLog;
    expect(typeof proclaimedInEventLog).toBe("function");
    bus.emit({ type: "seat.model_divergence", rigId: "rig-1", nodeId: "n1", sessionName: "dev-impl@r", runtime: "codex",
      pinnedModel: "gpt-5.1-codex-mini", effectiveModel: "gpt-5.4-mini", diagnosis: null, occurrenceId: "occ-1", channels: [] });
    const was = proclaimedInEventLog!(db);
    expect(was("occ-1", "n1")).toBe(false); // no channel received it
    const event = (occurrenceId: string, status: string) => bus.emit({ type: "seat.model_divergence", rigId: "rig-1", nodeId: "n1",
      sessionName: "dev-impl@r", runtime: "codex", pinnedModel: "gpt-5.1-codex-mini", effectiveModel: "gpt-5.4-mini", diagnosis: null, occurrenceId,
      channels: [{ channel: "operator", target: "op@k", status: "failed" }, { channel: "slack", target: null, status: "deferred" }, { channel: "orchestrator", target: "orch-lead@r", status }] });
    event("occ-2", "delivered");
    event("occ-3", "retained");
    event("occ-4", "failed");
    expect(was("occ-2", "n1")).toBe(true);
    expect(was("occ-3", "n1")).toBe(true);
    expect(was("occ-4", "n1")).toBe(false);
    expect(was("occ-2", "n2")).toBe(false);
    db.close();
  });
});
