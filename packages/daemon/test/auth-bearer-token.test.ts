import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  AuthBearerTokenStartupError,
  assertBindAuthInvariant,
  authBearerTokenMiddleware,
  constantTimeEqual,
  isLoopbackBind,
} from "../src/middleware/auth-bearer-token.js";

describe("auth-bearer-token middleware (PL-005 Phase B)", () => {
  it("constantTimeEqual returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("constantTimeEqual returns false for different strings (same length)", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("constantTimeEqual returns false for different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("isLoopbackBind detects loopback host names", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("127.42.7.99")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("[::1]")).toBe(true);
  });

  it("isLoopbackBind treats non-loopback hosts as non-loopback", () => {
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("100.64.0.5")).toBe(false);
    expect(isLoopbackBind("10.0.0.1")).toBe(false);
    expect(isLoopbackBind("rig.local")).toBe(false);
  });

  it("isLoopbackBind treats empty/undefined as non-loopback (safety default)", () => {
    expect(isLoopbackBind("")).toBe(false);
    expect(isLoopbackBind(undefined)).toBe(false);
    expect(isLoopbackBind(null)).toBe(false);
  });

  // HARD-GATE audit row 8.
  it("HARD-GATE: assertBindAuthInvariant throws when non-loopback bind has empty bearer", () => {
    expect(() =>
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: null }),
    ).toThrow(AuthBearerTokenStartupError);
    expect(() =>
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: "" }),
    ).toThrow(AuthBearerTokenStartupError);
    expect(() =>
      assertBindAuthInvariant({ host: "100.64.0.5", bearerToken: null }),
    ).toThrow(AuthBearerTokenStartupError);
  });

  it("HARD-GATE: assertBindAuthInvariant passes when loopback bind even with empty bearer", () => {
    expect(() =>
      assertBindAuthInvariant({ host: "127.0.0.1", bearerToken: null }),
    ).not.toThrow();
    expect(() =>
      assertBindAuthInvariant({ host: "localhost", bearerToken: "" }),
    ).not.toThrow();
  });

  it("HARD-GATE: assertBindAuthInvariant passes when non-loopback has non-empty bearer", () => {
    expect(() =>
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: "secret" }),
    ).not.toThrow();
    expect(() =>
      assertBindAuthInvariant({ host: "100.64.0.5", bearerToken: "secret" }),
    ).not.toThrow();
  });

  describe("middleware integration", () => {
    function appWithMiddleware(token: string | null): Hono {
      const app = new Hono();
      app.use("*", authBearerTokenMiddleware({ expectedToken: token }));
      app.get("/", (c) => c.json({ ok: true }));
      return app;
    }

    it("loopback-only mode (token=null) passes all requests", async () => {
      const app = appWithMiddleware(null);
      const res = await app.request("/");
      expect(res.status).toBe(200);
    });

    it("returns 401 with three-part body when Authorization missing", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/");
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("unauthorized");
      expect(body.what_failed).toContain("missing Authorization header");
      expect(body.why_it_matters).toBeDefined();
      expect(body.what_to_do).toBeDefined();
    });

    it("returns 401 when Authorization is not Bearer scheme", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { what_failed: string };
      expect(body.what_failed).toContain("Bearer");
    });

    it("returns 401 when Bearer token does not match", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { what_failed: string };
      expect(body.what_failed).toContain("does not match");
    });

    it("returns 200 when Bearer token matches", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });

    it("accepts case-insensitive 'authorization' header (HTTP standard)", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });
  });
});
