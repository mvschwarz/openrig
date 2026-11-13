import { afterEach, describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { createFullTestDb } from "./helpers/test-app.js";
import { seedHostShaped } from "./helpers/seed-host-shaped.js";
import { buildStallApp } from "./fixtures/ps-stall-http-child.js";
import { configureSyncSiteRecorder, runSyncSiteWhenSlow } from "../src/domain/sync-site-wrap.js";

// The node inventory's synchronous steps named in the slow-operation log, so a stall during a nodes read is attributed
// to the step that ran. A fake recorder takes every call; the real recorder's slow threshold is pinned in
// slow-op-recorder.test.ts.
describe("the node inventory's synchronous steps in the slow-operation log", () => {
  const slow: Array<{ site: string; durationMs: number; outcome: string; at: number }> = [];
  /** Takes every record; the first one then holds the event loop for `holdMs`, after its own time was measured. */
  const record = (holdMs = 0) => configureSyncSiteRecorder({
    recordSlowSync(site: string, durationMs: number, outcome: "ok" | "failed"): void {
      slow.push({ site, durationMs, outcome, at: performance.now() });
      if (slow.length === 1 && holdMs > 0) { const until = performance.now() + holdMs; while (performance.now() < until) { /* hold */ } }
    },
  });
  afterEach(() => { configureSyncSiteRecorder(undefined); slow.length = 0; });

  function fixture() {
    const db = createFullTestDb();
    const shape = seedHostShaped(db);
    return { db, app: buildStallApp(db, true), rig: shape.activeRigIds[0]! };
  }
  const ids = (nodes: Array<{ logicalId: string }>) => nodes.map((n) => n.logicalId);

  it("names each default step once, in order, and serves the same nodes", async () => {
    const { db, app, rig } = fixture();
    try {
      const bare = await app.request(`/api/rigs/${rig}/nodes`);
      expect(bare.status).toBe(200);
      const bareNodes = await bare.json() as Array<{ logicalId: string }>;
      expect(bareNodes.length).toBeGreaterThan(0);

      record();
      const res = await app.request(`/api/rigs/${rig}/nodes`);
      expect(res.status).toBe(200);
      expect(ids(await res.json() as Array<{ logicalId: string }>)).toEqual(ids(bareNodes));
      expect(slow.map(({ site, outcome }) => ({ site, outcome }))).toEqual([
        { site: "nodes.inventory.build", outcome: "ok" },
        { site: "nodes.inventory.activity_sync", outcome: "ok" },
        { site: "nodes.inventory.terminal_work", outcome: "ok" },
      ]);
    } finally {
      db.close();
    }
  });

  it("leaves a full read's activity step unnamed: it awaits pane captures outside the turns", async () => {
    const { db, app, rig } = fixture();
    try {
      record();
      const res = await app.request(`/api/rigs/${rig}/nodes?full=true`);
      expect(res.status).toBe(200);
      expect(slow.map((s) => s.site)).toEqual(["nodes.inventory.build", "nodes.inventory.terminal_work"]);
    } finally {
      db.close();
    }
  });

  it("measures a step from its turn, so the wait behind another request's step isn't counted", async () => {
    const HOLD_MS = 400;
    const { db, app, rig } = fixture();
    try {
      record(HOLD_MS);
      const [a, b] = await Promise.all([app.request(`/api/rigs/${rig}/nodes`), app.request(`/api/rigs/${rig}/nodes`)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const builds = slow.filter((s) => s.site === "nodes.inventory.build");
      expect(builds).toHaveLength(2);
      // The second build began only after the first step's hold ended, and its own time doesn't include that wait.
      expect(builds[1]!.at - builds[1]!.durationMs).toBeGreaterThanOrEqual(builds[0]!.at + HOLD_MS - 1);
      for (const s of slow) expect(s.durationMs).toBeLessThan(HOLD_MS);
      expect(slow).toHaveLength(6);
    } finally {
      db.close();
    }
  });

  it("counts a returned promise's synchronous start, never its settling, and keeps its rejection", async () => {
    record();
    const failure = new Error("activity failed");
    const settled = runSyncSiteWhenSlow("test.async_start", () => new Promise((_, reject) => setTimeout(() => reject(failure), 300)));
    expect(slow.map(({ site, outcome }) => ({ site, outcome }))).toEqual([{ site: "test.async_start", outcome: "ok" }]);
    expect(slow[0]!.durationMs).toBeLessThan(300);
    await expect(settled).rejects.toBe(failure);
  });
});
