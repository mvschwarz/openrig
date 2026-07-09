// OPR.0.4.6.WF4 — guard blocker 1 regression. The instance-page Resume button is
// the only in-scope web mutation (route-from-web is deferred). It is a thin client
// of POST /api/workflow/:id/resume, which REQUIRES a structured `actorSession` and
// returns 400 without it (routes/workflow.ts:266). This regression fails on the
// prior empty-body POST.

import { describe, it, expect, vi, afterEach } from "vitest";
import { postResume } from "../src/components/workflow/WorkflowInstancePage.js";

afterEach(() => vi.unstubAllGlobals());

describe("WF-4 guard blocker 1: web Resume sends a structured actorSession", () => {
  it("POSTs a JSON body carrying actorSession (the shipped route 400s without it)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    await postResume("01ABC");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/workflow/01ABC/resume");
    expect(calls[0].init.method).toBe("POST");
    // The body must be JSON with a NON-empty actorSession — the exact contract
    // the route enforces (empty/absent → 400).
    const body = JSON.parse(String(calls[0].init.body));
    expect(typeof body.actorSession).toBe("string");
    expect(body.actorSession.length).toBeGreaterThan(0);
  });
});
