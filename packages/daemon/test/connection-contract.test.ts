import { describe, it, expect } from "vitest";
import { readWakeOutcome } from "../src/domain/connection-contract.js";
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
