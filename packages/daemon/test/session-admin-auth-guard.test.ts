// OPR.0.4.3.02 — session-admin mutation auth guard.
// The three state-mutating session-admin POSTs (reconcile / clear-attention /
// unclaim) must carry the SAME terminalAuthGuard() the resume-token write and
// the preview read already ship. This proves route coverage over the SHIPPED
// bearer middleware — no new auth model. Mirrors the shipped guard-test shape
// (resume-token-route.test.ts:122 + terminal-auth.test.ts): 401 without/with a
// wrong bearer, admitted (200) with the correct bearer, and loopback (null
// token) pass-through with NO header.

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { sessionAdminRoutes } from "../src/routes/sessions.js";

const TOKEN = "secret-terminal-token-abc123";

// Minimal per-route dep stubs — just enough for each guarded handler to reach a
// deterministic ok:true (200) once the guard admits the request. The GUARD is
// what is under test; the handler business logic is covered elsewhere.
function stubDeps() {
  return {
    // reconcile → convergeOp(reconcile_session) calls claimService.reconcileSession
    claimService: { reconcileSession: vi.fn(async () => ({ ok: true, sessionName: "dev1-impl@test-rig", projectionDrift: [], continuity: "unverified" })) },
    podInstantiator: {}, // presence-checked only
    // clear-attention
    seatAttentionReconciler: { clearAttention: vi.fn(async () => ({ ok: true, from: "attention_required", clearedBy: "evidence" })) },
    // unclaim
    rigLifecycleService: { unclaimSession: vi.fn(async () => ({ ok: true, sessionName: "dev1-impl@test-rig", logicalId: "dev1.impl", rigId: "rig-1" })) },
  };
}

// Mount sessionAdminRoutes behind a context middleware that sets the terminal
// bearer token (null = loopback/no-token mode) plus the stubbed deps.
function mountApp(bearerToken: string | null) {
  const deps = stubDeps();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("terminalBearerToken" as never, bearerToken);
    c.set("claimService" as never, deps.claimService);
    c.set("podInstantiator" as never, deps.podInstantiator);
    c.set("seatAttentionReconciler" as never, deps.seatAttentionReconciler);
    c.set("rigLifecycleService" as never, deps.rigLifecycleService);
    await next();
  });
  app.route("/api/sessions", sessionAdminRoutes);
  return Object.assign(app, { effects: [deps.claimService.reconcileSession,
    deps.seatAttentionReconciler.clearAttention, deps.rigLifecycleService.unclaimSession] });
}

function post(app: { request: (p: string, init?: RequestInit) => Promise<Response> }, path: string, headers?: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({}),
  });
}

const ROUTES: Array<{ name: string; path: string }> = [
  { name: "reconcile", path: "/api/sessions/dev1-impl%40test-rig/reconcile" },
  { name: "clear-attention", path: "/api/sessions/dev1-impl%40test-rig/clear-attention" },
  { name: "unclaim", path: "/api/sessions/dev1-impl%40test-rig/unclaim" },
];

describe("session-admin mutation auth guard (OPR.0.4.3.02)", () => {
  describe("with a bearer token configured (non-loopback)", () => {
    for (const route of ROUTES) {
      describe(`POST .../${route.name}`, () => {
        it.each([
          ["missing", undefined, "missing Authorization header"],
          ["malformed", { Authorization: "Basic SYNTHETIC_HEADER_SECRET" }, "Authorization header must be 'Bearer <token>'"],
          ["wrong", { Authorization: "Bearer SYNTHETIC_OTHER_TOKEN" }, "bearer token does not match"],
        ] as const)("identifies the terminal gate for a %s credential without disclosing secrets or acting", async (_case, headers, reason) => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path, headers);
          expect(res.status).toBe(401);
          for (const effect of app.effects) expect(effect).not.toHaveBeenCalled();
          const body = await res.json();
          expect(Object.keys(body).sort()).toEqual(["error", "message", "what_failed", "what_to_do", "why_it_matters"]);
          expect(body.error).toBe("unauthorized");
          expect(body.what_failed).toBe(reason);
          expect.soft(body.message).toBe(`Terminal auth failed: ${reason}`);
          expect.soft(body.why_it_matters).toBe("Terminal and transport requests require the configured terminal bearer token to protect terminal access and input.");
          expect.soft(body.what_to_do).toBe("Use the daemon's terminal bearer token with `Authorization: Bearer <token>`: OPENRIG_TERMINAL_BEARER_TOKEN, or OPENRIG_AUTH_BEARER_TOKEN when terminal auth falls back to it.");
          for (const secret of [TOKEN, "SYNTHETIC_HEADER_SECRET", "SYNTHETIC_OTHER_TOKEN"]) expect(JSON.stringify(body)).not.toContain(secret);
        });

        it("200 (admitted) with the correct bearer token", async () => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path, { Authorization: `Bearer ${TOKEN}` });
          expect(res.status).toBe(200);
          expect(app.effects.flatMap(effect => effect.mock.calls)).toHaveLength(1);
        });
      });
    }
  });

  describe("loopback / no-token mode (terminalBearerToken = null)", () => {
    for (const route of ROUTES) {
      it(`POST .../${route.name} passes through with NO Authorization header`, async () => {
        const app = mountApp(null);
        const res = await post(app, route.path);
        expect(res.status).not.toBe(401);
        expect(res.status).toBe(200);
        expect(app.effects.flatMap(effect => effect.mock.calls)).toHaveLength(1);
      });
    }
  });

  describe("no regression: sibling routes keep their existing posture", () => {
    it("the already-guarded resume-token write still 401s without a bearer", async () => {
      const app = mountApp(TOKEN);
      const res = await post(app, "/api/sessions/dev1-impl%40test-rig/resume-token");
      expect(res.status).toBe(401);
    });

    it("the already-guarded GET preview still 401s without a bearer", async () => {
      const app = mountApp(TOKEN);
      const res = await app.request("/api/sessions/dev1-impl%40test-rig/preview");
      expect(res.status).toBe(401);
    });
  });
});
