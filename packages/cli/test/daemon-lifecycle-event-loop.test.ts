import { describe, it, expect, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  getDaemonStatus,
  STATE_FILE,
  type LifecycleDeps,
  type DaemonState,
} from "../src/daemon-lifecycle.js";

// OPR.0.4.3.21 — getDaemonStatus reads event-loop wedge evidence from the
// enriched /healthz body and reports process-present/UNHEALTHY honestly.

function mockDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() }) as unknown as ChildProcess),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    sleep: async () => {},
    ...overrides,
  };
}

const RUNNING_STATE: DaemonState = {
  pid: 4242,
  port: 7433,
  host: "127.0.0.1",
  db: "x.db",
  startedAt: "2026-07-02T00:00:00Z",
};

function runningDeps(fetchImpl: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>): LifecycleDeps {
  return mockDeps({
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(RUNNING_STATE) : null)),
    isProcessAlive: vi.fn(() => true),
    fetch: vi.fn(fetchImpl),
  });
}

describe("getDaemonStatus — event-loop evidence", () => {
  it("healthy enriched body -> healthy:true, evidence attached, no reason", async () => {
    const evidence = { lagMeanMs: 3, lagP99Ms: 9, utilization: 0.2, lastTickAgeMs: 40, healthy: true };
    const status = await getDaemonStatus(
      runningDeps(async () => ({ ok: true, json: async () => ({ status: "ok", eventLoop: evidence }) })),
    );
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(true);
    expect(status.reason).toBeUndefined();
    expect(status.eventLoop).toEqual(evidence);
  });

  it("starved loop that still answers healthz -> process-present/unhealthy with reason event-loop-starved + evidence", async () => {
    const evidence = { lagMeanMs: 900, lagP99Ms: 1200, utilization: 0.99, lastTickAgeMs: 1500, healthy: false };
    const status = await getDaemonStatus(
      runningDeps(async () => ({ ok: true, json: async () => ({ status: "ok", eventLoop: evidence }) })),
    );
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe("event-loop-starved");
    expect(status.eventLoop).toEqual(evidence);
    expect(status.pid).toBe(4242);
    expect(status.port).toBe(7433);
  });

  it("wedge: pid alive but healthz times out -> running (NOT stopped), unhealthy, reason unresponsive, pid+port present", async () => {
    const status = await getDaemonStatus(
      runningDeps(async () => { throw new Error("healthz probe timed out"); }),
    );
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe("unresponsive");
    expect(status.pid).toBe(4242);
    expect(status.port).toBe(7433);
  });

  it("monitor-less daemon (plain {status:ok}) -> healthy, no reason, no evidence", async () => {
    const status = await getDaemonStatus(
      runningDeps(async () => ({ ok: true, json: async () => ({ status: "ok" }) })),
    );
    expect(status.healthy).toBe(true);
    expect(status.reason).toBeUndefined();
    expect(status.eventLoop).toBeUndefined();
  });
});
