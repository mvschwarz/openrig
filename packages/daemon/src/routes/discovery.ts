import { Hono } from "hono";
import type { DiscoveryCoordinator } from "../domain/discovery-coordinator.js";
import type { DiscoveryRepository } from "../domain/discovery-repository.js";
import type { ClaimService } from "../domain/claim-service.js";

export const discoveryRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    discoveryCoordinator: c.get("discoveryCoordinator" as never) as DiscoveryCoordinator,
    discoveryRepo: c.get("discoveryRepo" as never) as DiscoveryRepository,
    claimService: c.get("claimService" as never) as ClaimService,
  };
}

// POST /api/discovery/scan — trigger one-shot scan
discoveryRoutes.post("/scan", async (c) => {
  const { discoveryCoordinator } = getDeps(c);
  try {
    const sessions = await discoveryCoordinator.scanOnce();
    return c.json({ sessions }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message ?? "scan failed" }, 500);
  }
});

// GET /api/discovery — list discovered sessions
discoveryRoutes.get("/", (c) => {
  const { discoveryRepo } = getDeps(c);
  const status = c.req.query("status") as "active" | "vanished" | "claimed" | undefined;
  const sessions = status ? discoveryRepo.listDiscovered(status) : discoveryRepo.listDiscovered();
  return c.json(sessions);
});

// GET /api/discovery/:id — detail
discoveryRoutes.get("/:id", (c) => {
  const { discoveryRepo } = getDeps(c);
  const id = c.req.param("id")!;
  const session = discoveryRepo.getDiscoveredSession(id);
  if (!session) return c.json({ error: "Discovered session not found" }, 404);
  return c.json(session);
});

// POST /api/discovery/:id/claim — claim into rig
discoveryRoutes.post("/:id/claim", async (c) => {
  const { claimService } = getDeps(c);
  const id = c.req.param("id")!;
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigId = typeof body["rigId"] === "string" ? body["rigId"] : "";
  const logicalId = typeof body["logicalId"] === "string" ? body["logicalId"] : undefined;

  if (!rigId) {
    return c.json({ error: "rigId is required" }, 400);
  }

  const result = claimService.claim({ discoveredId: id, rigId, logicalId });

  if (result.ok) {
    return c.json(result, 201);
  }

  switch (result.code) {
    case "not_found":
    case "rig_not_found":
      return c.json(result, 404);
    case "not_active":
    case "duplicate_logical_id":
      return c.json(result, 409);
    default:
      return c.json(result, 500);
  }
});
