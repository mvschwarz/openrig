import { describe, it, expect } from "vitest";
import { describeCheckIn, memberCheckInStatus, readWakeOutcome } from "../src/domain/connection-contract.js";
import { NUDGE_FAIL_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";

describe("readWakeOutcome: every recorded nudge result reads as a delivery fact", () => {
  // One row per form a producer writes today (queue-repository, hosted-wake, the destination resolver, the parked-owner
  // consumer). A new producer form belongs here too, or it reads unknown.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["verified", { fact: "accepted", route: "terminal", renderVerified: true }],
    ["delivered-ack-pending", { fact: "accepted", route: "terminal" }],
    ["retained:typing_guard", { fact: "held", route: "terminal", heldBy: "typing-guard" }],
    ["retained:draft_aware", { fact: "held", route: "terminal", heldBy: "draft-aware" }],
    ["wake-accepted:webhook (hook) answered 202; pickup is the member's claim on this row", { fact: "accepted", route: "hosted-trigger" }],
    ["indeterminate:webhook (hook) didn't answer within 5000 ms", { fact: "unknown", route: "hosted-trigger" }],
    // A webhook failure after the POST doesn't prove the member missed the ring; one before it does.
    ["failed:webhook (hook) answered 500", { fact: "failed-effect-unknown", route: "hosted-trigger", reporter: "outside-adapter" }],
    ["failed:webhook (hook) answered 302, a redirect, which isn't followed", { fact: "failed-effect-unknown", route: "hosted-trigger", reporter: "outside-adapter" }],
    ["failed:webhook (hook) couldn't be reached (ECONNRESET)", { fact: "failed-effect-unknown", route: "hosted-trigger" }],
    ["failed:webhook (hook) isn't set: no webhook URL to ring", { fact: "not-delivered", route: "hosted-trigger" }],
    ["failed:webhook (hook) not rung: its Authorization value (auth) isn't set", { fact: "not-delivered", route: "hosted-trigger" }],
    ["failed:webhook (hook) not rung: the URL is invalid (bad scheme)", { fact: "not-delivered", route: "hosted-trigger" }],
    ["gateway-owned: 'slack:U1@external' is a virtual @external destination", { fact: "unknown", route: "gateway" }],
    ["unroutable: 'm@r' is a hosted member with no wake trigger", { fact: "not-delivered", route: "none" }],
    ["indeterminate:wake send timed out", { fact: "unknown", route: "terminal" }],
    ["indeterminate:earlier delivery unconfirmed; retry failed:x", { fact: "unknown", route: "terminal" }],
    ["indeterminate: parked-owner wake delivery — timed out", { fact: "unknown", route: "terminal" }],
    ["failed:tmux session not found", { fact: "not-delivered", route: "terminal" }],
    ["failed:terminal-seat: 'sh@r' is a terminal seat", { fact: "not-delivered", route: "terminal" }],
    ["failed:wake not retained: disk full", { fact: "not-delivered", route: "terminal" }],
    [`${NUDGE_FAIL_PREFIX} — refused`, { fact: "not-delivered", route: "terminal" }],
  ];

  it.each(cases)("%s", (recorded, expected) => {
    const outcome = readWakeOutcome(recorded)!;
    expect(outcome).toMatchObject({ reporter: "openrig-observed", ...expected, recorded });
  });

  it("only a rendered terminal wake is render-verified; an unverified send is accepted, nothing more", () => {
    expect(readWakeOutcome("verified")?.renderVerified).toBe(true);
    expect(readWakeOutcome("delivered-ack-pending")?.renderVerified).toBeUndefined();
  });

  it("an unrecognised result reads unknown with no route, never success or failure", () => {
    for (const recorded of ["accepted-by-some-new-route", "claimed", "", "VERIFIED", "ok"]) {
      expect(readWakeOutcome(recorded)).toEqual({ fact: "unknown", reporter: "openrig-observed", route: null, recorded });
    }
  });

  it("no recorded attempt reads as no outcome", () => {
    expect(readWakeOutcome(null)).toBeNull();
    expect(readWakeOutcome(undefined)).toBeNull();
  });
});

describe("memberCheckInStatus: a hosted member's check-in status", () => {
  const now = new Date("2026-11-12T12:00:00.000Z");
  const seenAgo = (minutes: number) => ({ state: "seen" as const, at: new Date(now.getTime() - minutes * 60_000).toISOString() });
  const status = (checkInMinutes: number | null, checkIn: Parameters<typeof memberCheckInStatus>[0]["checkIn"], revokedAt?: string) =>
    memberCheckInStatus({ checkInMinutes, checkIn, now, ...(revokedAt ? { revokedAt } : {}) }).status;

  it("with a stated cadence, one rule: checking in up to exactly twice it, overdue a moment after", () => {
    const at = (ms: number) => ({ state: "seen" as const, at: new Date(now.getTime() - ms).toISOString() });
    expect(status(60, seenAgo(5))).toBe("checking-in");
    expect(status(60, seenAgo(90))).toBe("checking-in"); // past one cadence is not yet overdue
    expect(status(60, at(2 * 60 * 60_000))).toBe("checking-in");
    expect(status(60, at(2 * 60 * 60_000 + 1))).toBe("check-in-overdue");
    expect(status(1, at(2 * 60_000 + 1))).toBe("check-in-overdue"); // any positive cadence works the same way
  });

  it("a stated cadence that can't be used reads unknown with its reason, ahead of every other reading", () => {
    expect(memberCheckInStatus({ checkInMinutes: null, cadenceProblem: "check_in_minutes \"60\" isn't a positive whole number of minutes",
      checkIn: seenAgo(5), now })).toMatchObject({ status: "unknown", reason: expect.stringContaining("check_in_minutes") });
    expect(memberCheckInStatus({ checkInMinutes: 60, checkIn: { state: "unknown" }, now })).toMatchObject({ status: "unknown", reason: "its check-ins couldn't be read" });
  });

  it("with no stated cadence it reads unknown with its last check-in, never on request, idle or overdue", () => {
    expect(memberCheckInStatus({ checkInMinutes: null, checkIn: seenAgo(5), now }))
      .toMatchObject({ status: "unknown", reason: "no check-in cadence declared", lastCheckInAt: seenAgo(5).at });
    expect(status(null, seenAgo(10_000))).toBe("unknown");
  });

  it("on request only when its setup says so, whatever its last check-in's age", () => {
    const onRequest = (checkIn: Parameters<typeof memberCheckInStatus>[0]["checkIn"]) =>
      memberCheckInStatus({ checkInMinutes: null, onRequest: true, checkIn, now });
    expect(onRequest(seenAgo(5)).status).toBe("on-request");
    expect(onRequest(seenAgo(10_000))).toMatchObject({ status: "on-request", onRequest: true });
    expect(onRequest({ state: "never" }).status).toBe("no-check-in-yet");
    expect(memberCheckInStatus({ checkInMinutes: undefined, checkIn: seenAgo(5), now })).toMatchObject({ lastCheckInAt: seenAgo(5).at, expectedMinutes: null });
  });

  it("no recorded check-in reads never, with or without a cadence; an unreadable record reads unknown, never idle or overdue", () => {
    expect(status(60, { state: "never" })).toBe("no-check-in-yet");
    expect(memberCheckInStatus({ checkInMinutes: null, checkIn: { state: "never" }, now })).toMatchObject({ status: "no-check-in-yet", expectedMinutes: null });
    expect(status(60, { state: "unknown" })).toBe("unknown");
    expect(status(60, { state: "seen", at: "not a time" })).toBe("unknown");
  });

  it("disconnected comes only from a recorded revocation, ahead of everything else; silence never produces it", () => {
    expect(status(60, seenAgo(5), "2026-11-12T11:00:00.000Z")).toBe("disconnected");
    expect(status(60, seenAgo(100_000))).toBe("check-in-overdue");
    expect(status(null, { state: "never" })).not.toBe("disconnected");
  });
});

describe("describeCheckIn: one line, with its evidence", () => {
  const base = { lastCheckInAt: "2026-11-12T13:05:00.000Z", expectedMinutes: 60, onRequest: false };
  it("overdue carries its last check-in, its expected cadence and the suspected reason", () => {
    expect(describeCheckIn({ ...base, status: "check-in-overdue" }))
      .toBe("overdue: last check-in 2026-11-12T13:05:00.000Z, expected every 60 min; its schedule may be off or waiting for an approval");
    expect(describeCheckIn({ ...base, status: "checking-in" })).toBe("checking in: last check-in 2026-11-12T13:05:00.000Z, expected every 60 min");
  });
  it("names what setup says when there's no check-in, and gives an unknown its reason and last check-in", () => {
    expect(describeCheckIn({ ...base, status: "no-check-in-yet", lastCheckInAt: null })).toBe("no check-in yet; expected every 60 min");
    expect(describeCheckIn({ ...base, status: "no-check-in-yet", lastCheckInAt: null, expectedMinutes: null, onRequest: true }))
      .toBe("no check-in yet; checks in when a person asks it");
    expect(describeCheckIn({ ...base, status: "no-check-in-yet", lastCheckInAt: null, expectedMinutes: null }))
      .toBe("no check-in yet; no check-in cadence declared");
    expect(describeCheckIn({ ...base, status: "on-request", expectedMinutes: null, onRequest: true }))
      .toBe("on request: it checks its queue when a person asks it; last check-in 2026-11-12T13:05:00.000Z");
    expect(describeCheckIn({ ...base, status: "unknown", expectedMinutes: null, reason: "no check-in cadence declared" }))
      .toBe("unknown (no check-in cadence declared); last check-in 2026-11-12T13:05:00.000Z");
  });
});
