// B1 — the crash-cart conductor ROUTE (ASYNC on-commit shape). The route starts the
// fleet restore in the BACKGROUND and answers immediately with a fleet-attempt handle
// (202); the client POLLS the status endpoint for the rollup as rigs complete. These
// tests drive the REAL route: POST → 202 + id, then GET status until done, asserting the
// kernel-first sequence composed from the shipped restore. (Conductor logic is unit-tested
// in crash-cart-conductor.test.ts.)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { crashCartRoutes, __resetFleetAttempts } from "../src/routes/crash-cart.js";

beforeEach(() => __resetFleetAttempts());

function appWith(deps: { rigRepo: unknown; snapshotRepo: unknown; restoreOrchestrator: unknown; runtimeAdapters?: unknown; sessionRegistry?: unknown; tmuxAdapter?: unknown; claimService?: unknown }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, deps.rigRepo as never);
    c.set("snapshotRepo" as never, deps.snapshotRepo as never);
    c.set("restoreOrchestrator" as never, deps.restoreOrchestrator as never);
    if (deps.runtimeAdapters !== undefined) c.set("runtimeAdapters" as never, deps.runtimeAdapters as never);
    if (deps.sessionRegistry !== undefined) c.set("sessionRegistry" as never, deps.sessionRegistry as never);
    if (deps.tmuxAdapter !== undefined) c.set("tmuxAdapter" as never, deps.tmuxAdapter as never);
    if (deps.claimService !== undefined) c.set("claimService" as never, deps.claimService as never);
    await next();
  });
  app.route("/api/crash-cart", crashCartRoutes);
  return app;
}

type StatusBody = {
  done: boolean;
  cancelled: boolean;
  rollup: { sequence: Array<{ rigId: string; outcome: string }>; counts: Record<string, number>; attention_required: unknown[] };
  verdict: string;
};

// Kick the async verb and return the fleet-attempt id (asserts the on-commit 202).
async function kickFleet(app: Hono): Promise<string> {
  const res = await app.request("/api/crash-cart/restore-fleet", { method: "POST" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { fleetAttemptId: string; status: string };
  expect(body.status).toBe("started");
  expect(body.fleetAttemptId).toMatch(/^fleet-/);
  return body.fleetAttemptId;
}

async function getStatus(app: Hono, id: string): Promise<StatusBody> {
  const res = await app.request(`/api/crash-cart/restore-fleet/${id}`, { method: "GET" });
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

// Poll the status endpoint until the background fleet restore reports done.
async function pollUntilDone(app: Hono, id: string): Promise<StatusBody> {
  for (let i = 0; i < 200; i++) {
    const body = await getStatus(app, id);
    if (body.done) return body;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("fleet restore never reported done");
}

describe("POST /api/crash-cart/restore-fleet — the async conductor batch verb", () => {
  it("restores every rig kernel-first; the polled rollup carries the sequence", async () => {
    const restored: string[] = [];
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-alpha", name: "alpha" },
        { id: "r-kernel", name: "kernel" },
      ] },
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => ({ id: `snap-${rigId}` }) },
      restoreOrchestrator: {
        restore: vi.fn(async (snapshotId: string) => {
          restored.push(snapshotId);
          return { ok: true, result: { rigResult: "fully_restored" } };
        }),
      },
    });

    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);

    // kernel restored FIRST, then alpha
    expect(restored).toEqual(["snap-r-kernel", "snap-r-alpha"]);
    expect(body.rollup.sequence.map((r) => r.rigId)).toEqual(["r-kernel", "r-alpha"]);
    expect(body.rollup.sequence.every((r) => r.outcome === "fully_restored")).toBe(true);
    expect(body.rollup.counts.fully_restored).toBe(2);
    expect(body.verdict).toBe("all_fully_restored");
  });

  it("a rig with no usable snapshot is not_attempted; the fleet still proceeds", async () => {
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ] },
      // beta has no usable snapshot
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => (rigId === "r-beta" ? null : { id: `snap-${rigId}` }) },
      restoreOrchestrator: { restore: async () => ({ ok: true, result: { rigResult: "fully_restored" } }) },
    });
    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);
    expect(body.rollup.sequence.find((r) => r.rigId === "r-kernel")!.outcome).toBe("fully_restored");
    expect(body.rollup.sequence.find((r) => r.rigId === "r-beta")!.outcome).toBe("not_attempted");
    expect(body.rollup.counts).toEqual({ fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 });
  });

  // r1 ROOT discriminator — the route must answer ON-COMMIT, NOT block to fleet completion.
  // A real fleet restore is seconds-per-seat; a blocking c.json exceeds the client timeout and
  // discards the rollup. Here restore is GATED open: the POST must resolve (202) while restore
  // is still pending, and the status shows not-done — proof the response never waited on the fleet.
  it("answers on-commit — POST returns while the (slow) restore is still in flight", async () => {
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreEntered = false;
    const app = appWith({
      rigRepo: { listRigs: () => [{ id: "r-kernel", name: "kernel" }] },
      snapshotRepo: { findLatestRestoreUsable: () => ({ id: "snap-k" }) },
      restoreOrchestrator: {
        restore: async () => {
          restoreEntered = true;
          await restoreGate; // block until the test releases — stands in for a slow seat restore
          return { ok: true, result: { rigResult: "fully_restored" } };
        },
      },
    });

    const id = await kickFleet(app); // 202 returned even though restore has NOT completed
    // let the background microtask enter restore, then observe it is still pending
    await new Promise((r) => setTimeout(r, 0));
    const mid = await getStatus(app, id);
    expect(restoreEntered).toBe(true);
    expect(mid.done).toBe(false); // the fleet is STILL running; the route did not block on it

    releaseRestore(); // now let the slow restore finish
    const done = await pollUntilDone(app, id);
    expect(done.rollup.counts.fully_restored).toBe(1);
    expect(done.verdict).toBe("all_fully_restored");
  });

  // R2-H1 — route-altitude discriminator: the route MUST thread the app's runtimeAdapters
  // + fsOps into restore(), else the shipped orchestrator fail-closes a pod-aware resume to
  // awaiting-decision (seats can't return in their panes). Asserted after the background settles.
  it("R2-H1: passes the app's runtimeAdapters + fsOps to restore()", async () => {
    let receivedOpts: { adapters?: unknown; fsOps?: { exists?: unknown } } | undefined;
    const adapters = { codex: { runtime: "codex" } };
    const app = appWith({
      rigRepo: { listRigs: () => [{ id: "r-kernel", name: "kernel" }] },
      snapshotRepo: { findLatestRestoreUsable: () => ({ id: "snap-k" }) },
      runtimeAdapters: adapters,
      restoreOrchestrator: {
        restore: async (_id: string, opts: unknown) => {
          receivedOpts = opts as typeof receivedOpts;
          return { ok: true, result: { rigResult: "fully_restored" } };
        },
      },
    });
    const id = await kickFleet(app);
    await pollUntilDone(app, id);
    expect(receivedOpts?.adapters).toBe(adapters); // the app's adapters reach restore
    expect(typeof receivedOpts?.fsOps?.exists).toBe("function");
  });

  // H3 — cancel through the REAL route: stop-before-next-rig. Cancel while the kernel rig is
  // in flight (gated) → later rigs are not_attempted, and the status reflects cancelled.
  it("H3: cancel mid-fleet through the route → later rigs not_attempted", async () => {
    const attempted: string[] = [];
    let releaseKernel!: () => void;
    const kernelGate = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ] },
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => ({ id: `snap-${rigId}` }) },
      restoreOrchestrator: {
        restore: async (snapshotId: string) => {
          attempted.push(snapshotId);
          if (snapshotId === "snap-r-kernel") await kernelGate; // hold kernel in flight
          return { ok: true, result: { rigResult: "fully_restored" } };
        },
      },
    });

    const id = await kickFleet(app);
    await new Promise((r) => setTimeout(r, 0)); // kernel restore is now in flight
    // cancel while kernel is still restoring
    const cancelRes = await app.request(`/api/crash-cart/restore-fleet/${id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()) as { cancelled: boolean }).toEqual(expect.objectContaining({ cancelled: true }));

    releaseKernel(); // kernel (in-flight) completes; beta must NOT start
    const body = await pollUntilDone(app, id);
    expect(attempted).toEqual(["snap-r-kernel"]); // beta never restored
    expect(body.cancelled).toBe(true);
    expect(body.rollup.sequence.find((r) => r.rigId === "r-kernel")!.outcome).toBe("fully_restored");
    expect(body.rollup.sequence.find((r) => r.rigId === "r-beta")!.outcome).toBe("not_attempted");
  });

  // R6 / ARCH-RULING Q2 — the fleet verdict is DERIVED at read from the current counts, never a
  // stored field on the attempt. The status verdict must equal f(the rollup counts it returns).
  it("derives the verdict from the returned counts (not a stored second truth)", async () => {
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ] },
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => (rigId === "r-beta" ? null : { id: `snap-${rigId}` }) },
      restoreOrchestrator: { restore: async () => ({ ok: true, result: { rigResult: "fully_restored" } }) },
    });
    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);
    // 1 fully_restored + 1 not_attempted = mixed, and it is exactly f(counts) of what GET returned
    const c = body.rollup.counts;
    const total = c.fully_restored + c.partially_restored + c.failed + c.not_attempted;
    const expected =
      total === 0 || c.not_attempted === total
        ? "none_attempted"
        : c.fully_restored === total
          ? "all_fully_restored"
          : c.failed === total
            ? "all_failed"
            : "mixed";
    expect(body.verdict).toBe(expected);
    expect(body.verdict).toBe("mixed");
  });

  // AMENDMENT 2 (stamped, 72757e81) — THE ROUND-10 DOOR IN ROUTE FORM. Daemon-only crash:
  // DB says running, panes are ALIVE, restore() would 409. Through the REAL route the rig
  // must ADOPT (reconcile the surviving session, resume-verify the rest), land the
  // engineered non-resumable seat on triage with its EXACT --fresh need, and never call
  // restore(). This is the composition the round-10 fleet read as 3-failed/8-not_attempted.
  it("AMENDMENT 2 door: live panes → adopted via the shipped reconcile + subset verify; restore never called; triage carries the exact --fresh need", async () => {
    const reconciled: string[] = [];
    const subsetTargets: string[][] = [];
    let restoreCalled = false;
    const app = appWith({
      rigRepo: {
        listRigs: () => [{ id: "r-kernel", name: "kernel" }],
        getRig: () => ({
          rig: { name: "kernel" },
          nodes: [
            { id: "n1", logicalId: "dev.planner" },
            { id: "n2", logicalId: "dev.qa" },
          ],
        }),
      },
      snapshotRepo: { findLatestRestoreUsable: () => ({ id: "snap-k" }) },
      sessionRegistry: {
        getSessionsForRig: () => [
          { id: "s1", nodeId: "n1", sessionName: "dev-planner@kernel", status: "running" },
          { id: "s2", nodeId: "n2", sessionName: "dev-qa@kernel", status: "running" },
        ],
      },
      // dev.planner's pane survived; dev.qa's pane died with the crash.
      tmuxAdapter: { hasSession: async (name: string) => name === "dev-planner@kernel" },
      claimService: {
        reconcileSession: async ({ sessionName }: { sessionName: string }) => {
          reconciled.push(sessionName);
          return { ok: true, result: { sessionName } };
        },
      },
      restoreOrchestrator: {
        restore: async () => { restoreCalled = true; return { ok: false, code: "rig_not_stopped" }; },
        launchNodeSubset: async (_rigId: string, ids: string[]) => {
          subsetTargets.push(ids);
          return {
            ok: true,
            launched: [{
              nodeId: "n2", logicalId: "dev.qa", status: "awaiting-decision",
              error: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip.",
            }],
          };
        },
      },
    });

    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);

    expect(restoreCalled).toBe(false); // the 409 path is never entered on a live-panes rig
    expect(reconciled).toEqual(["dev-planner@kernel"]); // the surviving session is ADOPTED
    expect(subsetTargets).toEqual([["dev.qa"]]); // only the dead seat is resume-verified
    const kernel = body.rollup.sequence.find((r) => r.rigId === "r-kernel")!;
    expect(kernel.outcome).toBe("partially_restored");
    expect(body.rollup.attention_required).toEqual([
      { rigId: "r-kernel", seat: "dev.qa", need: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip." },
    ]);
    expect(body.verdict).toBe("mixed"); // f(counts): a lone partially_restored rig derives mixed
  });

  it("status/cancel of an unknown fleet-attempt id → 404", async () => {
    const app = appWith({
      rigRepo: { listRigs: () => [] },
      snapshotRepo: { findLatestRestoreUsable: () => null },
      restoreOrchestrator: { restore: async () => ({ ok: true }) },
    });
    expect((await app.request("/api/crash-cart/restore-fleet/nope", { method: "GET" })).status).toBe(404);
    expect((await app.request("/api/crash-cart/restore-fleet/nope/cancel", { method: "POST" })).status).toBe(404);
  });
});
