import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import { projectRigToGraph } from "../domain/graph-projection.js";

export const rigsRoutes = new Hono();

function getRepo(c: { get: (key: string) => unknown }): RigRepository {
  return c.get("rigRepo" as never) as RigRepository;
}

function getSessionRegistry(c: { get: (key: string) => unknown }): SessionRegistry {
  return c.get("sessionRegistry" as never) as SessionRegistry;
}

rigsRoutes.post("/", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const name = body["name"];
  if (!name || typeof name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  const rig = getRepo(c).createRig(name);
  return c.json(rig, 201);
});

rigsRoutes.get("/", (c) => {
  const rigs = getRepo(c).listRigs();
  return c.json(rigs);
});

rigsRoutes.get("/:id", (c) => {
  const rig = getRepo(c).getRig(c.req.param("id"));
  if (!rig) {
    return c.json({ error: "rig not found" }, 404);
  }
  return c.json(rig);
});

rigsRoutes.get("/:id/graph", (c) => {
  const rig = getRepo(c).getRig(c.req.param("id"));
  if (!rig) {
    return c.json({ error: "rig not found" }, 404);
  }
  const sessions = getSessionRegistry(c).getSessionsForRig(c.req.param("id"));
  return c.json(projectRigToGraph({ ...rig, sessions }));
});

rigsRoutes.delete("/:id", (c) => {
  const rigId = c.req.param("id");
  const repo = getRepo(c);
  const eventBus = c.get("eventBus" as never) as EventBus;

  // Only emit event + delete if rig exists
  const rig = repo.getRig(rigId);
  if (!rig) {
    return c.body(null, 204);
  }

  // Atomic: event persist + rig delete in one transaction
  // Uses eventBus.db (same handle as rigRepo.db — enforced by shared AppDeps)
  const txn = eventBus.db.transaction(() => {
    const persisted = eventBus.persistWithinTransaction({
      type: "rig.deleted",
      rigId,
    });
    repo.deleteRig(rigId);
    return persisted;
  });

  try {
    const persistedEvent = txn();
    eventBus.notifySubscribers(persistedEvent);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: "delete failed" }, 500);
  }
});
