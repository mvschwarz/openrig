import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import type { ReadinessResult } from "../src/domain/runtime-adapter.js";

describe("ContextMonitor readiness write reservation", () => {
  let db: Database.Database;
  let writer: Database.Database;
  let home: string;
  let sessionId: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "readiness-wal-"));
    db = createDb(join(home, "state.sqlite")); migrate(db, ALL_MIGRATIONS);
    writer = createDb(join(home, "state.sqlite"));
    // These connections share an event loop: never wait for the fixture itself.
    db.pragma("busy_timeout = 0"); writer.pragma("busy_timeout = 0");
    db.exec("CREATE TABLE unrelated_write (value INTEGER); INSERT INTO unrelated_write VALUES (0)");
    const repo = new RigRepository(db); const registry = new SessionRegistry(db);
    const rig = repo.createRig("fixture");
    const node = repo.addNode(rig.id, "agent", { runtime: "codex" });
    const session = registry.registerSession(node.id, "dev-agent@fixture"); sessionId = session.id;
    registry.updateStatus(sessionId, "running"); registry.updateStartupStatus(sessionId, "failed");
    registry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%11" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (writer.inTransaction) writer.exec("ROLLBACK");
    writer.close(); db.close(); rmSync(home, { recursive: true, force: true });
  });
  function status() {
    return (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(sessionId) as { startup_status: string }).startup_status;
  }
  function monitor(checkReady: () => Promise<ReadinessResult>) {
    return new ContextMonitor(db, new ContextUsageStore(db, { stateDir: home, codexHomeDir: home }),
      undefined, undefined, { codex: { checkReady } });
  }
  const result = (ready: boolean): ReadinessResult => ready ? { ready: true } : { ready: false, code: "trust_gate" };

  it.each([true, false])("reserves the writer before revalidation, avoiding a lost ready=%s result", async ready => {
    let attempted = false; let writerOutcome: string | undefined; let probeInTransaction: boolean | undefined;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (!attempted && db.inTransaction && sql.includes("UPDATE sessions") && sql.includes("startup_status =")) {
        attempted = true;
        // Run a real second-connection write after the snapshot read, before the
        // monitor's write. DEFERRED allows this commit, then loses its upgrade.
        try { writer.prepare("UPDATE unrelated_write SET value = value + 1").run(); writerOutcome = "committed"; }
        catch (error) { writerOutcome = (error as { code?: string }).code; }
      }
      return prepare(sql);
    });
    await monitor(async () => { probeInTransaction = db.inTransaction; return result(ready); }).pollOnce();
    expect(attempted).toBe(true);
    expect(status()).toBe(ready ? "ready" : "attention_required");
    expect(writerOutcome).toBe("SQLITE_BUSY");
    expect(probeInTransaction).toBe(false);
    expect(db.inTransaction).toBe(false);
    // The competing writer can proceed immediately after the short reservation.
    writer.prepare("UPDATE unrelated_write SET value = value + 1").run();
    expect(writer.prepare("SELECT value FROM unrelated_write").get()).toEqual({ value: 1 });
  });

  it.each([true, false])("preserves a newer state committed before the ready=%s reservation", async ready => {
    await monitor(async () => {
      expect(db.inTransaction).toBe(false);
      writer.prepare("UPDATE sessions SET startup_status = 'pending' WHERE id = ?").run(sessionId);
      return result(ready);
    }).pollOnce();
    expect(status()).toBe("pending");
    expect(db.inTransaction).toBe(false);
    writer.prepare("UPDATE sessions SET startup_status = 'ready' WHERE id = ?").run(sessionId);
    expect(status()).toBe("ready");
  });

  it.each([true, false])("leaves ready=%s unknown on initial contention and recovers on a later poll", async ready => {
    const check = vi.fn(async () => result(ready)).mockImplementationOnce(async () => {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE unrelated_write SET value = value + 1").run();
      return result(ready);
    });
    const instance = monitor(check);
    await instance.pollOnce();
    expect(status()).toBe("failed");
    expect(db.inTransaction).toBe(false);
    writer.exec("COMMIT");
    await instance.pollOnce();
    expect(status()).toBe(ready ? "ready" : "attention_required");
    expect(check).toHaveBeenCalledTimes(2);
  });
});
