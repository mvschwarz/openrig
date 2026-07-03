// OPR.0.4.3.02 — session-admin mutation auth guard.
// The three state-mutating session-admin POSTs (reconcile / clear-attention /
// unclaim) must carry the SAME terminalAuthGuard() the resume-token write and
// the preview read already ship. This proves route coverage over the SHIPPED
// bearer middleware — no new auth model. Mirrors the shipped guard-test shape
// (resume-token-route.test.ts:122 + terminal-auth.test.ts): 401 without/with a
// wrong bearer, admitted (200) with the correct bearer, and loopback (null
// token) pass-through with NO header.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { sessionAdminRoutes } from "../src/routes/sessions.js";

const TOKEN = "secret-terminal-token-abc123";

// Minimal per-route dep stubs — just enough for each guarded handler to reach a
// deterministic ok:true (200) once the guard admits the request. The GUARD is
// what is under test; the handler business logic is covered elsewhere.
function stubDeps() {
  return {
    // reconcile → convergeOp(reconcile_session) calls claimService.reconcileSession
    claimService: { reconcileSession: async () => ({ ok: true, sessionName: "dev1-impl@test-rig", projectionDrift: [], continuity: "unverified" }) },
    podInstantiator: {}, // presence-checked only
    // clear-attention
    seatAttentionReconciler: { clearAttention: async () => ({ ok: true, from: "attention_required", clearedBy: "evidence" }) },
    // unclaim
    rigLifecycleService: { unclaimSession: async () => ({ ok: true, sessionName: "dev1-impl@test-rig", logicalId: "dev1.impl", rigId: "rig-1" }) },
  };
}

// Mount sessionAdminRoutes behind a context middleware that sets the terminal
// bearer token (null = loopback/no-token mode) plus the stubbed deps.
function mountApp(bearerToken: string | null): { request: (p: string, init?: RequestInit) => Promise<Response> } {
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
  return app;
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
        it("401 without the Authorization header", async () => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path);
          expect(res.status).toBe(401);
        });

        it("401 with a WRONG bearer token", async () => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path, { Authorization: "Bearer wrong-token" });
          expect(res.status).toBe(401);
        });

        it("200 (admitted) with the correct bearer token", async () => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path, { Authorization: `Bearer ${TOKEN}` });
          expect(res.status).toBe(200);
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
