import { describe, it, expect, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import {
  loadCrashCartDiscovery,
  DaemonLiveError,
  DaemonStateChangedError,
  CrashCartReadError,
} from "../src/domain/crash-cart-discovery.js";

// Crash-cart C2 — the compose orchestrator: fail-closed guard FIRST, then copy-then-read, read the
// discovery view, and ALWAYS clean up the scratch copy. All IO injected → hermetic.

function seededDb(): BetterSqlite3.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('r1','alpha')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1','r1','worker')").run();
  return db;
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    openrigHome: "/scratch/.openrig",
    readDaemonJson: () => ({ pid: 9, port: 7433, db: "/scratch/.openrig/openrig.sqlite" }),
    isProcessAlive: () => false,
    probeHealthz: async () => "refused" as const,
    openrigUrl: undefined as string | undefined,
    copyFile: vi.fn(),
    exists: () => true,
    makeScratchDir: vi.fn(() => "/scratch/tmp/cc-xyz"),
    removeScratchDir: vi.fn(),
    openDb: vi.fn(() => seededDb()),
    ...over,
  };
}

describe("loadCrashCartDiscovery — fail-closed FIRST, always clean up", () => {
  it.each(["timeout", "not-openrig"] as const)("a %s recheck cannot reach scratch creation or copying", async (result) => {
    const deps = baseDeps({ probeHealthz: async () => result });
    await expect(loadCrashCartDiscovery(deps)).rejects.toMatchObject({ state: "unverified" });
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
    expect(deps.copyFile).not.toHaveBeenCalled();
    expect(deps.openDb).not.toHaveBeenCalled();
  });
  it("a startup appearing before discovery keeps the selected target unverified", async () => {
    const deps = baseDeps({ readProcessEvidence: () => ({ mayBeRunning: true, pidState: "start pending" }) });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(DaemonStateChangedError);
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
    expect(deps.copyFile).not.toHaveBeenCalled();
  });
  it("an empty private instance does not borrow the unrelated default daemon's identity", async () => {
    const probeHealthz = vi.fn(async (url: string) => url.includes(":7433/") ? "answered" as const : "refused" as const);
    const deps = baseDeps({ readDaemonJson: () => undefined, exists: () => false,
      openrigUrl: "http://127.0.0.1:17433", probeHealthz });
    const result = await loadCrashCartDiscovery(deps);
    expect(result.discovery.foundOnHost).toEqual([]);
    expect(result.discovery.header.hostId).toBeNull();
    expect(probeHealthz).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:17433/healthz");
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
  it("an explicit target does not override a recorded live owner of the local database", async () => {
    const deps = baseDeps({ openrigUrl: "http://127.0.0.1:17433", isProcessAlive: () => true,
      readProcessEvidence: () => ({ mayBeRunning: false, pidState: "explicit target; no matching local record" }) });
    await expect(loadCrashCartDiscovery(deps)).rejects.toThrow("daemon.json pid 9 is still alive");
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
  it("uses the configured database before the first recorded daemon boot", async () => {
    const deps = baseDeps({ readDaemonJson: () => undefined, configuredDbPath: "/private/custom.sqlite" });
    const result = await loadCrashCartDiscovery(deps);
    expect(result.dbPath.path).toBe("/private/custom.sqlite");
    expect(deps.copyFile).toHaveBeenCalledWith("/private/custom.sqlite", "/scratch/tmp/cc-xyz/custom.sqlite");
  });
  it("does not turn a permission failure into an empty instance", async () => {
    const deps = baseDeps({ readDaemonJson: () => undefined, exists: () => { throw new Error("EACCES"); } });
    await expect(loadCrashCartDiscovery(deps)).rejects.toThrow("EACCES");
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
  it("a missing recorded database remains a read failure, not first setup", async () => {
    const deps = baseDeps({ exists: () => false });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(CrashCartReadError);
  });
  it("refuses (DaemonLiveError) before making any scratch dir or copy when the daemon is live", async () => {
    const deps = baseDeps({ isProcessAlive: () => true });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(DaemonLiveError);
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
    expect(deps.copyFile).not.toHaveBeenCalled();
    expect(deps.removeScratchDir).not.toHaveBeenCalled();
  });

  it("happy path: returns the discovery view and cleans up the scratch dir", async () => {
    const deps = baseDeps();
    const { discovery, dbPath } = await loadCrashCartDiscovery(deps);
    expect(dbPath.path).toBe("/scratch/.openrig/openrig.sqlite");
    expect(discovery.foundOnHost).toHaveLength(1);
    expect(discovery.foundOnHost[0].rigId).toBe("r1");
    expect(discovery.header.stopReason).toBeNull();
    expect(deps.makeScratchDir).toHaveBeenCalledTimes(1);
    expect(deps.removeScratchDir).toHaveBeenCalledWith("/scratch/tmp/cc-xyz");
  });

  it("cleans up the scratch dir even when the read throws", async () => {
    const deps = baseDeps({
      openDb: () => {
        throw new Error("open failed");
      },
    });
    await expect(loadCrashCartDiscovery(deps)).rejects.toThrow("open failed");
    expect(deps.removeScratchDir).toHaveBeenCalledWith("/scratch/tmp/cc-xyz");
  });

  it("refuses a relative daemon.json db path (cannot locate daemon-down)", async () => {
    const deps = baseDeps({ readDaemonJson: () => ({ pid: 9, port: 7433, db: "openrig.sqlite" }) });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(CrashCartReadError);
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
});
