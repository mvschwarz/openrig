import { describe, it, expect } from "vitest";
import { resolveBindPlan } from "../src/domain/bind-plan.js";

// OPR.0.5.5.20 — bind intent has unambiguous provenance. The incident shape (operator
// baton qitem-20260827070400): a maintenance command in a managed environment carried
// OPENRIG_HOST=127.0.0.1; the daemon took single-bind and silently dropped Tailscale.

describe("S20 — resolveBindPlan: routing env is never bind intent", () => {
  it("INCIDENT SHAPE: injected routing env + no dedicated intent → DEFAULT multi-bind, both listeners, ignore is VISIBLE", () => {
    const plan = resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: "127.0.0.1", tailscaleIp: "100.95.124.60" });
    expect(plan.mode).toBe("default");
    expect(plan.hosts).toEqual(["127.0.0.1", "100.95.124.60"]); // the Tailscale listener SURVIVES
    expect(plan.tailscaleDetected).toBe(true);
    expect(plan.ignoredRoutingHost).toBe("127.0.0.1"); // never silent — the provenance line's input
  });

  it("dedicated intent takes the explicit single-bind branch (the operator's channel, byte-uninjectable by managed env)", () => {
    const plan = resolveBindPlan({ bindHostEnv: "100.95.124.51", routingHostEnv: "127.0.0.1", tailscaleIp: "100.95.124.51" });
    expect(plan.mode).toBe("explicit");
    expect(plan.hosts).toEqual(["100.95.124.51"]);
    expect(plan.ignoredRoutingHost).toBeUndefined(); // intent declared — nothing ignored
  });

  it("no env at all: default loopback-only without tailscale; loopback+tailscale when present", () => {
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined, tailscaleIp: null }))
      .toEqual({ mode: "default", hosts: ["127.0.0.1"], tailscaleDetected: false });
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined, tailscaleIp: "100.64.0.9" }).hosts)
      .toEqual(["127.0.0.1", "100.64.0.9"]);
  });

  it("whitespace-only dedicated env is ABSENT (never an accidental single-bind on an empty string)", () => {
    const plan = resolveBindPlan({ bindHostEnv: "   ", routingHostEnv: undefined, tailscaleIp: "100.64.0.9" });
    expect(plan.mode).toBe("default");
    expect(plan.hosts).toEqual(["127.0.0.1", "100.64.0.9"]);
  });
});
