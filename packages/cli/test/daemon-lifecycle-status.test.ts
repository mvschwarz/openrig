import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLifecycle, readDaemonLifecycle } from "../src/daemon-lifecycle-status.js";

describe("describeLifecycle — P7 atom 4 render classification", () => {
  it("no lifecycle record → unknown (pre-P7 daemon or never booted)", () => {
    expect(describeLifecycle(null).kind).toBe("unknown");
  });

  it("stopped_at present → clean-shutdown, last-seen = stopped_at", () => {
    const r = describeLifecycle({ bootEpoch: "e", startedAt: "T0", lastHeartbeatAt: "T1", stoppedAt: "T2" });
    expect(r.kind).toBe("clean-shutdown");
    expect(r.stoppedAt).toBe("T2");
    expect(r.lastSeen).toBe("T2");
  });

  it("NO stopped_at + heartbeat present → no-clean-shutdown, last-seen = last heartbeat (the kill-9 money case)", () => {
    const r = describeLifecycle({ bootEpoch: "e", startedAt: "T0", lastHeartbeatAt: "T1", stoppedAt: null });
    expect(r.kind).toBe("no-clean-shutdown");
    expect(r.lastSeen).toBe("T1");
    expect(r.stoppedAt).toBeNull();
  });

  it("NO stopped_at + NO heartbeat → no-clean-shutdown, last-seen falls back to started_at", () => {
    const r = describeLifecycle({ bootEpoch: "e", startedAt: "T0", lastHeartbeatAt: null, stoppedAt: null });
    expect(r.kind).toBe("no-clean-shutdown");
    expect(r.lastSeen).toBe("T0");
  });
});

describe("readDaemonLifecycle — crash-surviving SQLite read (real db)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the lifecycle row from a real db (the row survives even when the daemon is dead)", () => {
    dir = mkdtempSync(join(tmpdir(), "p7-life-"));
    const dbPath = join(dir, "openrig.sqlite");
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE daemon_lifecycle (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), boot_epoch TEXT NOT NULL, started_at TEXT NOT NULL, last_heartbeat_at TEXT, stopped_at TEXT);
       INSERT INTO daemon_lifecycle VALUES (1, 'ep', '2026-08-07T00:00:00Z', '2026-08-07T00:05:00Z', NULL);`,
    );
    db.close();

    const rec = readDaemonLifecycle(dbPath);
    expect(rec).not.toBeNull();
    expect(rec!.bootEpoch).toBe("ep");
    expect(rec!.lastHeartbeatAt).toBe("2026-08-07T00:05:00Z");
    expect(rec!.stoppedAt).toBeNull();
    // and the money classification
    expect(describeLifecycle(rec).kind).toBe("no-clean-shutdown");
  });

  it("returns null (→ unknown) when the db file is absent — never crashes rig status", () => {
    expect(readDaemonLifecycle("/nonexistent/openrig.sqlite")).toBeNull();
  });
});
