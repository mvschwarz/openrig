import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { RigDeliveryDrainStore } from "../domain/rig-delivery-drain.js";
import { WatchdogJobsRepository } from "../domain/watchdog-jobs-repository.js";

export const rigDeliveryDrainRoutes = new Hono();
rigDeliveryDrainRoutes.use("*", async (c, next) => {
  const rigs = c.get("rigRepo" as never) as RigRepository;
  if (!rigs.getRig(c.req.param("rigId")!)) return c.json({ error: "rig_not_found" }, 404);
  await next();
});
rigDeliveryDrainRoutes.get("/", c => {
  const rigs = c.get("rigRepo" as never) as RigRepository;
  const jobs = (c.get("watchdogJobsRepo" as never) as WatchdogJobsRepository | undefined) ?? new WatchdogJobsRepository(rigs.db);
  return c.json(new RigDeliveryDrainStore(rigs.db).status(c.req.param("rigId")!, jobs));
});
rigDeliveryDrainRoutes.post("/", async c => {
  const body = await c.req.json().catch(() => null) as { drainId?: unknown; owner?: unknown; reviewAt?: unknown } | null;
  if (!body || typeof body.drainId !== "string" || !body.drainId.trim() || typeof body.owner !== "string"
    || !body.owner.includes("@") || typeof body.reviewAt !== "string" || !Number.isFinite(Date.parse(body.reviewAt))) {
    return c.json({ error: "drainId, owner address and reviewAt timestamp are required" }, 400);
  }
  const rigs = c.get("rigRepo" as never) as RigRepository;
  const jobs = (c.get("watchdogJobsRepo" as never) as WatchdogJobsRepository | undefined) ?? new WatchdogJobsRepository(rigs.db);
  const store = new RigDeliveryDrainStore(rigs.db);
  store.begin(c.req.param("rigId")!, body as { drainId: string; owner: string; reviewAt: string }, jobs);
  return c.json(store.status(c.req.param("rigId")!, jobs));
});
rigDeliveryDrainRoutes.post("/end", async c => {
  const body = await c.req.json().catch(() => null) as { drainId?: unknown } | null;
  if (!body || typeof body.drainId !== "string" || !body.drainId.trim()) return c.json({ error: "drainId is required" }, 400);
  const rigs = c.get("rigRepo" as never) as RigRepository;
  const jobs = (c.get("watchdogJobsRepo" as never) as WatchdogJobsRepository | undefined) ?? new WatchdogJobsRepository(rigs.db);
  const store = new RigDeliveryDrainStore(rigs.db);
  const rigId = c.req.param("rigId")!;
  const result = store.end(rigId, body.drainId, jobs);
  const queue = c.get("queueRepo" as never) as QueueRepository | undefined;
  if (result.fresh && queue) queueMicrotask(() => {
    // END releases only untouched notices. It adds no retry of failed, uncertain, in-flight or delivered input.
    void queue.drainPendingWakeIntents({ eligible: entry => entry.deliveryState === "pending"
      && store.rigForSession(entry.destinationSession) === rigId }).catch(error => console.error("Delivery-drain END wake pass:", error));
  });
  return c.json({ ...store.status(rigId, jobs), ended: result.fresh, releaseScheduled: result.fresh && !!queue });
});
