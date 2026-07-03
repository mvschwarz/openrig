import { describe, it, expect } from "vitest";
import type { UseQueryResult } from "@tanstack/react-query";
import { deriveDaemonHealthSignal, type DaemonHealthPayload } from "../src/hooks/useDaemonHealth.js";

// OPR.0.4.3.21 — controlPlaneUnhealthy is true ONLY on a positive signal: a
// failed health poll (wedged loop can't answer) OR an event-loop verdict of
// healthy:false. Unknown/first-load must NOT read as unhealthy.

function query(partial: Partial<UseQueryResult<DaemonHealthPayload>>): UseQueryResult<DaemonHealthPayload> {
  return partial as UseQueryResult<DaemonHealthPayload>;
}

describe("deriveDaemonHealthSignal", () => {
  it("unhealthy when the health poll errored (wedged loop can't answer /healthz)", () => {
    const s = deriveDaemonHealthSignal(query({ isError: true, data: undefined }));
    expect(s.controlPlaneUnhealthy).toBe(true);
  });

  it("unhealthy when healthz answered but the event-loop verdict is healthy:false", () => {
    const s = deriveDaemonHealthSignal(query({
      isError: false,
      data: { status: "ok", eventLoop: { lagMeanMs: 900, lagP99Ms: 1200, utilization: 0.99, lastTickAgeMs: 1500, healthy: false } },
    }));
    expect(s.controlPlaneUnhealthy).toBe(true);
    expect(s.evidence?.healthy).toBe(false);
  });

  it("healthy when healthz answered with a healthy event-loop verdict", () => {
    const s = deriveDaemonHealthSignal(query({
      isError: false,
      data: { status: "ok", eventLoop: { lagMeanMs: 2, lagP99Ms: 5, utilization: 0.1, lastTickAgeMs: 20, healthy: true } },
    }));
    expect(s.controlPlaneUnhealthy).toBe(false);
  });

  it("NOT unhealthy on the unknown/first-load state (no data, no error)", () => {
    const s = deriveDaemonHealthSignal(query({ isError: false, data: undefined }));
    expect(s.controlPlaneUnhealthy).toBe(false);
    expect(s.evidence).toBeNull();
  });

  it("healthy against a monitor-less daemon (plain {status:ok}, no eventLoop)", () => {
    const s = deriveDaemonHealthSignal(query({ isError: false, data: { status: "ok" } }));
    expect(s.controlPlaneUnhealthy).toBe(false);
  });
});
