// V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
//
// GET /api/kernel/status route tests. Verifies the route surfaces the
// tracker's state via a stable JSON envelope and 503s cleanly when no
// tracker is wired.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { kernelStatusRoutes } from "../src/routes/kernel-status.js";
import { KernelBootTracker } from "../src/domain/kernel-boot-tracker.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { RigRepository } from "../src/domain/rig-repository.js";

function mountWithTracker(tracker: KernelBootTracker | undefined) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("kernelBootTracker" as never, tracker);
    await next();
  });
  app.route("/api/kernel", kernelStatusRoutes);
  return app;
}

function makeTracker(opts: {
  rigs?: Array<{ id: string; name: string }>;
  sessionsByRig?: Record<string, Array<{ sessionName: string; runtime: string; startupStatus: string; logicalId?: string }>>;
} = {}) {
  const eventBus = { emit: () => undefined } as unknown as EventBus;
  // One node per session name; the runtime and the spec's `pod.member` (logicalId) live on the node row.
  const sessionRegistry = {
    getSessionsForRig: (rigId: string) => (opts.sessionsByRig?.[rigId] ?? []).map((s, i) => ({
      ...s, nodeId: s.sessionName, id: `session-${i}`, createdAt: `2026-10-08T00:00:0${i}Z`,
    })),
  } as unknown as SessionRegistry;
  const rigRepo = {
    listRigs: () => opts.rigs ?? [],
    findRigsByName: (name: string) => (opts.rigs ?? []).filter((r) => r.name === name),
    findUnarchivedRigsByName: (name: string) => (opts.rigs ?? []).filter((r) => r.name === name),
    getRig: (rigId: string) => ({
      nodes: (opts.sessionsByRig?.[rigId] ?? []).map((s) => ({ id: s.sessionName, logicalId: s.logicalId ?? s.sessionName, runtime: s.runtime })),
    }),
  } as unknown as RigRepository;
  return new KernelBootTracker({ eventBus, sessionRegistry, rigRepo, degradedTimeoutMs: 0 });
}

describe("GET /api/kernel/status", () => {
  it("returns 503 with a clear error when no tracker is wired", async () => {
    const app = mountWithTracker(undefined);
    const res = await app.request("/api/kernel/status");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("kernel_boot_tracker_unavailable");
    expect(body.message).toContain("Kernel-boot tracker not wired");
  });

  it("returns 200 with skipped envelope for a fresh tracker", async () => {
    const app = mountWithTracker(makeTracker());
    const res = await app.request("/api/kernel/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kernel_state).toBe("skipped");
    expect(body.agents).toEqual([]);
    expect(body.first_unready_since).toBeNull();
    expect(body.variant).toBeNull();
    expect(body.detail).toBeNull();
    expect(body.last_boot_failure).toBeNull();
  });

  it("returns 200 with auth_blocked envelope when tracker is auth-blocked", async () => {
    const tracker = makeTracker();
    tracker.setAuthBlocked("Error: ...\nReason: ...\nFix: ...");
    const app = mountWithTracker(tracker);
    const res = await app.request("/api/kernel/status");
    const body = await res.json();
    expect(body.kernel_state).toBe("auth_blocked");
    expect(body.detail).toContain("Error:");
  });

  it("projects agents[] with snake_case keys from tracker getStatus()", async () => {
    const rigId = "rig-kernel-route-1";
    const tracker = makeTracker({
      rigs: [{ id: rigId, name: "kernel" }],
      sessionsByRig: {
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" },
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "pending" },
        ],
      },
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await new Promise<void>((r) => setImmediate(r));
    const app = mountWithTracker(tracker);
    const res = await app.request("/api/kernel/status");
    const body = await res.json();
    expect(body.kernel_state).toBe("partial_ready");
    expect(body.variant).toBe("rig.yaml");
    expect(body.agents).toHaveLength(2);
    expect(body.agents[0]).toMatchObject({
      session_name: "advisor-lead@kernel",
      runtime: "claude-code",
      startup_status: "ready",
    });
    expect(body.first_unready_since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    tracker.stop();
  });

  it("reports ready with last_boot_failure once a failed boot's expected seats are all ready (#1042)", async () => {
    const rigId = "rig-kernel-route-recovered";
    const sessions = [
      { sessionName: "operator-agent@kernel", runtime: "claude-code", startupStatus: "ready", logicalId: "operator.agent" },
      { sessionName: "queue-worker@kernel", runtime: "codex", startupStatus: "ready", logicalId: "queue.worker" },
    ];
    const tracker = makeTracker({ rigs: [{ id: rigId, name: "kernel" }], sessionsByRig: { [rigId]: sessions } });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "failed", stages: [], errors: ["startup gate timed out after 30s"], warnings: [],
    } as never), ["operator.agent", "queue.worker"]);
    await new Promise<void>((r) => setImmediate(r));
    const body = await (await mountWithTracker(tracker).request("/api/kernel/status")).json();
    expect(body.kernel_state).toBe("ready");
    expect(body.detail).toBeNull();
    expect(body.last_boot_failure).toMatchObject({ state: "bootstrap_failed", detail: "startup gate timed out after 30s" });
    tracker.stop();
  });
});
