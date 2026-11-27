// #3991 round 4: guarded-delivery restart recovery finishes inside createDaemon, before the hook bridge's sweep is armed.
// That sweep is the first thing in a new process that can take a claim, and it starts before the server binds, so a
// recovery after it (post-bind, as before) could settle a live fallback's claim on a slow start and overwrite the
// result that fallback then reaches. A message only queued for the bridge isn't a claim: it stays queued.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import { DraftAwareDelivery } from "../src/domain/draft-aware-delivery.js";
import { DRAFT_HELD_ELIGIBLE_TAG, OutboxHandler } from "../src/domain/outbox-handler.js";
import { HOOK_BRIDGE_CHANNEL } from "../src/domain/hook-bridge.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("guarded-delivery recovery at daemon start", () => {
  it("settles the previous process's claims before the hook bridge's sweep is armed, and keeps a message only queued for the bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "startup-recovery-"));
    const dbPath = join(root, "openrig.sqlite");
    // The previous process's rows, as it left them.
    const seed = createDb(dbPath); migrate(seed, ALL_MIGRATIONS);
    const outbox = new OutboxHandler(seed);
    const put = (id: string, receipt: object | null, tags: string[] = []) => {
      outbox.record({ outboxId: id, senderSession: "pm@team", destinationSession: "dev-impl@team", body: `body ${id}` });
      seed.prepare("UPDATE outbox_entries SET delivery_state='sending', guard_delivery=?, tags=? WHERE outbox_id=?")
        .run(receipt ? JSON.stringify(receipt) : null, JSON.stringify(tags), id);
    };
    put("only-queued", { channel: HOOK_BRIDGE_CHANNEL, state: "queued", queuedAt: "2026-11-27T09:00:00.000Z" });
    put("waiter-claimed", { channel: HOOK_BRIDGE_CHANNEL, state: "claimed", queuedAt: "2026-11-27T09:00:00.000Z", armId: "arm-1", batchId: "batch-1" });
    put("handed-back", null, [DRAFT_HELD_ELIGIBLE_TAG]);
    put("guarded-attempt", { attempt: "typing" });
    seed.close();

    const order: string[] = [];
    const recover = DraftAwareDelivery.prototype.recover;
    vi.spyOn(DraftAwareDelivery.prototype, "recover").mockImplementation(function (this: DraftAwareDelivery) {
      order.push("recover");
      return recover.call(this);
    });
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 5_000 && String(fn).includes("sweepHookBridge")) order.push("bridge sweep armed");
      return realSetInterval(fn, ms, ...rest);
    }) as typeof setInterval);

    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({ dbPath, tmuxExec: async () => "", cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
      // Recovery ran once, before the sweep that can take a claim was armed.
      expect(order).toEqual(["recover", "bridge sweep armed"]);
      const state = (id: string) => daemon!.db.prepare("SELECT delivery_state AS state, json_extract(guard_delivery,'$.state') AS receipt FROM outbox_entries WHERE outbox_id=?").get(id);
      expect(state("only-queued")).toEqual({ state: "sending", receipt: "queued" });   // still owed, for the bridge to deliver
      expect(state("waiter-claimed")).toMatchObject({ state: "indeterminate" });     // may have reached the seat: uncertain
      expect(state("handed-back")).toMatchObject({ state: "indeterminate" });        // may have been typed: uncertain
      expect(state("guarded-attempt")).toMatchObject({ state: "indeterminate" });
    } finally {
      daemon?.eventLoopMonitor.stop(); daemon?.contextMonitor.stop(); daemon?.deps.seatActivityService?.stop(); daemon?.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
