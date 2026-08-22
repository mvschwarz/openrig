import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { classifyProbeError, probeHealthz } from "../src/domain/crash-cart-probes.js";

// A GUARANTEED-refused local port: bind an ephemeral port, capture it, close → connecting now refuses
// (real RST). This is a REAL socket refusal — not a hand-built error — so the test buys the actual Node
// rejection shape (guard round-6 / r1: a stubbed error shape is a claim about Node; buy it with a socket).
async function refusedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

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

  // GUARD round-6 blocker: real Node/Undici fetch nests the refusal in `cause`; the outer error is a bare
  // TypeError "fetch failed" with code undefined. Checking only the outer error mislabels a dead daemon.
  it("NESTED cause.code ECONNREFUSED (the real undici fetch shape) → refused", () => {
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65534"), { code: "ECONNREFUSED" }),
    });
    expect(classifyProbeError(wrapped)).toBe("refused");
  });
  it("AggregateError cause (multi-address host) carrying ECONNREFUSED in .errors → refused", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [Object.assign(new Error("v6"), { code: "ECONNREFUSED" }), Object.assign(new Error("v4"), { code: "ECONNREFUSED" })],
    });
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause: agg });
    expect(classifyProbeError(wrapped)).toBe("refused");
  });
  it("a nested connect-timeout is still timeout (conservatism preserved, not weakened to down)", () => {
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
    expect(classifyProbeError(wrapped)).toBe("timeout");
  });

  // GUARD round-7 blocker: a MIXED multi-address AggregateError (one address refused, another timed out)
  // is AMBIGUOUS. Refusal must NOT win by precedence — a timeout never promotes to a confirmed down, so
  // the cart never offers RESTORE EVERYTHING on partial evidence.
  it("MIXED aggregate (ECONNREFUSED + ETIMEDOUT) → timeout, never a promoted down", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [
        Object.assign(new Error("v6 refused"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("v4 timed out"), { code: "ETIMEDOUT" }),
      ],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("timeout");
  });
  it("refused requires ALL terminal attempts to be refusal — a refused + unknown sibling stays timeout", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [{ code: "ECONNREFUSED" }, { code: "EHOSTUNREACH" }],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("timeout");
  });
  it("a refused + abort sibling stays timeout (abort never co-promotes a down)", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), Object.assign(new Error("aborted"), { name: "AbortError" })],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("timeout");
  });
  it("an all-refused multi-address aggregate is still refused (the fix does not over-narrow)", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("refused");
  });
});

describe("probeHealthz — PRODUCTION PATH: a REAL refused socket, not a fabricated error", () => {
  it("real global fetch against a closed local port → refused (the shape the crash-cart probe actually sees)", async () => {
    const port = await refusedPort();
    const r = await probeHealthz(`http://127.0.0.1:${port}/healthz`, {
      fetch: (u, init) => fetch(u, init as RequestInit),
      timeoutMs: 1500,
    });
    // Before the cause-walking fix this returned "timeout" → "unverified" → no cockpit. The daemon-down
    // signal must survive Node's cause-nesting for the crash-cart to reach the cockpit + RESTORE.
    expect(r).toBe("refused");
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
