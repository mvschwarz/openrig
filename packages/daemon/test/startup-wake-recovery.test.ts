// Production startup + real workflow exception creation, with a deferred terminal boundary.
import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { SessionTransport } from "../src/domain/session-transport.js";

it("does not reclaim a live exception wake started by the current startup sweep", async () => {
  const home = mkdtempSync(join(tmpdir(), "startup-wake-")), path = join(home, "db.sqlite");
  const seed = new Database(path); migrate(seed, ALL_MIGRATIONS);
  seed.exec("INSERT INTO rigs(id,name) VALUES ('rig','test')");
  const repo = new QueueRepository(seed, new EventBus(seed), { validateRig: () => true });
  const packet = await repo.create({ sourceSession: "lead@test", destinationSession: "worker@test", body: "work", nudge: false });
  new WorkflowInstanceStore(seed).create({ workflowName: "recovery", workflowVersion: "1", createdBySession: "lead@test", initialFrontier: [packet.qitemId], currentStepId: "work" });
  seed.prepare("UPDATE queue_items SET ts_created='2000-01-01T00:00:00Z' WHERE qitem_id=?").run(packet.qitemId);
  seed.close();
  let release!: () => void, settled!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { settled = resolve; });
  const exceptions: string[] = [];
  const send = vi.spyOn(SessionTransport.prototype, "send").mockImplementation(async (session, _text, opts) => {
    const id = opts?.auditPointer;
    if (id?.startsWith("qitem-recovery-")) {
      exceptions.push(id);
      if (exceptions.length === 1) { await pending; settled(); }
    }
    return { ok: true, verified: true, sessionName: session };
  });
  const route = vi.spyOn(WorkflowRuntime.prototype, "resolveExceptionRouteFor").mockReturnValue({
    position: "orchestrator", destinationSession: "reviewer@test", tier: "routine", humanRouted: false, resolvedVia: "workflow-declared",
  });
  const drain = vi.spyOn(QueueRepository.prototype, "drainPendingWakeIntents");
  const previous = process.env.OPENRIG_NO_KERNEL; process.env.OPENRIG_NO_KERNEL = "1";
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    daemon = await createDaemon({ dbPath: path, tmuxExec: async () => "", cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    expect(exceptions).toHaveLength(1);
    const id = "wake-intent-" + exceptions[0];
    expect(daemon.deps.outboxHandler!.getById(id)!.deliveryState).toBe("sending");
    // The recovery pass runs once the daemon listens (index.ts); run it here, while that live send is still pending.
    daemon.wakeRecovery.start();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    await drain.mock.results[0]!.value;
    expect(exceptions).toHaveLength(1);
    expect(daemon.deps.outboxHandler!.getById(id)!.deliveryState).toBe("sending");
    release(); await completed;
    await vi.waitFor(() => expect(daemon!.deps.outboxHandler!.getById(id)!.deliveryState).toBe("delivered"));
    expect(exceptions).toHaveLength(1);
  } finally {
    release(); if (exceptions.length) await completed;
    await daemon?.wakeRecovery.stop();
    send.mockRestore(); route.mockRestore(); drain.mockRestore();
    if (previous === undefined) delete process.env.OPENRIG_NO_KERNEL; else process.env.OPENRIG_NO_KERNEL = previous;
    daemon?.eventLoopMonitor.stop(); daemon?.contextMonitor.stop(); daemon?.db.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 60000);
