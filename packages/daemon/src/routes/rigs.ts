import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";

export const rigsRoutes = new Hono();

function getRepo(c: { get: (key: string) => unknown }): RigRepository {
  return c.get("rigRepo" as never) as RigRepository;
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

rigsRoutes.delete("/:id", (c) => {
  getRepo(c).deleteRig(c.req.param("id"));
  return c.body(null, 204);
});
