import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { EventLoopMonitor, HEALTHZ_RESPONSIVENESS_BUDGET_MS } from "../src/domain/event-loop-monitor.js";
import { RouteTimingRecorder } from "../src/domain/route-timing-recorder.js";

function seedRigWithNodes(db: Database.Database, name: string, nodeCount: number): string {
  const rigId = `rig-${name}`;
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, name);
  for (let i = 0; i < nodeCount; i++) {
    const nodeId = `node-${rigId}-${i}`;
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(nodeId, rigId, `seat-${i}`);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`sess-${nodeId}`, nodeId, `tmux-${nodeId}`, "running", new Date().toISOString().replace("T", " ").slice(0, 19));
  }
  return rigId;
}

describe("OPR.0.4.3.21 — /healthz enrichment", () => {
  it("keeps the exact legacy body when no monitor is wired", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    db.close();
  });

  it("surfaces event-loop evidence + route timings when the monitor is wired", async () => {
    const db = createFullTestDb();
    const monitor = new EventLoopMonitor();
    const routeTimingRecorder = new RouteTimingRecorder();
    const { app } = createTestApp(db, { eventLoopMonitor: monitor, routeTimingRecorder });

    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      eventLoop: { lagMeanMs: number; lagP99Ms: number; utilization: number; lastTickAgeMs: number; healthy: boolean };
      routeTimings: Record<string, unknown>;
    };
    expect(body.status).toBe("ok");
    expect(typeof body.eventLoop.lagMeanMs).toBe("number");
    expect(typeof body.eventLoop.lastTickAgeMs).toBe("number");
    expect(typeof body.eventLoop.healthy).toBe("boolean");
    expect(body.routeTimings).toBeTypeOf("object");

    monitor.stop();
    db.close();
  });
});

describe("OPR.0.4.3.21 — backend stress proof (the gate)", () => {
  it(
    "keeps /healthz within the proven responsiveness budget under topology route load, and captures route + event-loop evidence",
    async () => {
      const db = createFullTestDb();
      const monitor = new EventLoopMonitor();
      const routeTimingRecorder = new RouteTimingRecorder();
      const { app } = createTestApp(db, { eventLoopMonitor: monitor, routeTimingRecorder });

      const rigIds: string[] = [];
      for (let r = 0; r < 6; r++) rigIds.push(seedRigWithNodes(db, `stress-${r}`, 4));

      // Fire a broad load across the expensive topology surfaces + repeatedly
      // probe /healthz. Assert EVERY healthz probe answered within the proven
      // budget while the hot paths were being hammered.
      const ROUNDS = 15;
      const healthLatenciesMs: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const load: Promise<unknown>[] = [];
        for (const rigId of rigIds) {
          load.push(app.request("/api/rigs/summary"));
          load.push(app.request(`/api/rigs/${rigId}/graph`));
          load.push(app.request(`/api/rigs/${rigId}/nodes`));
          load.push(app.request("/api/ps"));
        }
        const t0 = performance.now();
        const healthRes = await app.request("/healthz");
        healthLatenciesMs.push(performance.now() - t0);
        expect(healthRes.status).toBe(200);
        await Promise.all(load);
      }

      // /healthz stayed responsive within the PROVEN threshold throughout.
      const worst = Math.max(...healthLatenciesMs);
      expect(worst).toBeLessThan(HEALTHZ_RESPONSIVENESS_BUDGET_MS);

      // Event-loop evidence is captured and the loop was NOT starved by the load.
      const finalHealth = (await app.request("/healthz")).clone();
      const body = (await finalHealth.json()) as {
        eventLoop: { healthy: boolean };
        routeTimings: Record<string, { lastMs: number; maxMs: number; count: number }>;
      };
      expect(body.eventLoop.healthy).toBe(true);

      // Route-duration evidence was captured for the expensive routes the proof drove.
      const labels = Object.keys(body.routeTimings);
      expect(labels).toContain("GET /api/ps");
      expect(labels).toContain("GET /api/rigs/summary");
      expect(labels).toContain("GET /api/rigs/:id/graph");
      expect(labels).toContain("GET /api/rigs/:id/nodes");
      expect(body.routeTimings["GET /api/ps"]!.count).toBeGreaterThan(0);

      monitor.stop();
      db.close();
    },
  );
});
