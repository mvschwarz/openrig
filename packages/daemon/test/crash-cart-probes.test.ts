import { describe, it, expect } from "vitest";
import { classifyProbeError, probeHealthz } from "../src/domain/crash-cart-probes.js";

// Crash-cart C3 — the REAL /healthz probe classification (feeds resolveDaemonState). A connection
// REFUSED is the only strong down signal; a timeout/abort is UNVERIFIED; a 2xx is answered; a non-2xx
// (or a foreign occupant) is not-openrig. fetch is injected so classification is deterministic.

describe("classifyProbeError — fetch rejection → probe result", () => {
  it("ECONNREFUSED → refused (the only strong down signal)", () => {
    expect(classifyProbeError({ code: "ECONNREFUSED" })).toBe("refused");
  });
  it("AbortError (timeout) → timeout", () => {
    expect(classifyProbeError({ name: "AbortError" })).toBe("timeout");
    expect(classifyProbeError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe("timeout");
    expect(classifyProbeError({ code: "ETIMEDOUT" })).toBe("timeout");
  });
  it("any other error → timeout (conservative: unverified, never a fabricated down)", () => {
    expect(classifyProbeError({ code: "EHOSTUNREACH" })).toBe("timeout");
    expect(classifyProbeError({})).toBe("timeout");
  });
});

describe("probeHealthz — injected fetch", () => {
  it("2xx → answered", async () => {
    const r = await probeHealthz("http://x/healthz", { fetch: async () => ({ ok: true, status: 200 }) as Response, timeoutMs: 500 });
    expect(r).toBe("answered");
  });
  it("non-2xx (foreign occupant) → not-openrig", async () => {
    const r = await probeHealthz("http://x/healthz", { fetch: async () => ({ ok: false, status: 404 }) as Response, timeoutMs: 500 });
    expect(r).toBe("not-openrig");
  });
  it("connection refused → refused", async () => {
    const r = await probeHealthz("http://x/healthz", {
      fetch: async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      timeoutMs: 500,
    });
    expect(r).toBe("refused");
  });
  it("abort/timeout → timeout", async () => {
    const r = await probeHealthz("http://x/healthz", {
      fetch: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      timeoutMs: 500,
    });
    expect(r).toBe("timeout");
  });
});
