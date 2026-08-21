// B1 — the crash-cart conductor ROUTE. Integration-ish: mount the route with a
// context providing mocked rigRepo/snapshotRepo/restoreOrchestrator, POST the batch
// verb, assert it returns the kernel-first per-rig sequence composed from the shipped
// restore. (The conductor logic itself is unit-tested in crash-cart-conductor.test.ts.)
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { crashCartRoutes } from "../src/routes/crash-cart.js";

function appWith(deps: { rigRepo: unknown; snapshotRepo: unknown; restoreOrchestrator: unknown }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, deps.rigRepo as never);
    c.set("snapshotRepo" as never, deps.snapshotRepo as never);
    c.set("restoreOrchestrator" as never, deps.restoreOrchestrator as never);
    await next();
  });
  app.route("/api/crash-cart", crashCartRoutes);
  return app;
}

describe("POST /api/crash-cart/restore-fleet — the conductor batch verb", () => {
  it("restores every rig kernel-first and returns the per-rig sequence", async () => {
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

    const res = await app.request("/api/crash-cart/restore-fleet", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sequence: Array<{ rigId: string; outcome: string }> };

    // kernel restored FIRST, then alpha
    expect(restored).toEqual(["snap-r-kernel", "snap-r-alpha"]);
    expect(body.sequence.map((r) => r.rigId)).toEqual(["r-kernel", "r-alpha"]);
    expect(body.sequence.every((r) => r.outcome === "fully_restored")).toBe(true);
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
    const res = await app.request("/api/crash-cart/restore-fleet", { method: "POST" });
    const body = (await res.json()) as { sequence: Array<{ rigId: string; outcome: string }> };
    expect(body.sequence.find((r) => r.rigId === "r-kernel")!.outcome).toBe("fully_restored");
    expect(body.sequence.find((r) => r.rigId === "r-beta")!.outcome).toBe("not_attempted");
  });
});
