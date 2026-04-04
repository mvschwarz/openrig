import { Hono } from "hono";
import type { DiscoveryCoordinator } from "../domain/discovery-coordinator.js";
import type { DiscoveryRepository } from "../domain/discovery-repository.js";
import type { ClaimService } from "../domain/claim-service.js";
import { generateDraftRig } from "../domain/draft-rig-generator.js";

export const discoveryRoutes = new Hono();

const CONFIDENCE_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  highest: 3,
};

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
  const runtimeHintQuery = c.req.query("runtimeHint");
  const minConfidence = c.req.query("minConfidence");
  const runtimeHints = runtimeHintQuery
    ? new Set(runtimeHintQuery.split(",").map((part) => part.trim()).filter(Boolean))
    : null;

  const sessions = (status ? discoveryRepo.listDiscovered(status) : discoveryRepo.listDiscovered())
    .filter((session) => {
      if (runtimeHints && !runtimeHints.has(session.runtimeHint)) return false;
      if (minConfidence) {
        const minRank = CONFIDENCE_RANK[minConfidence] ?? 0;
        const sessionRank = CONFIDENCE_RANK[session.confidence] ?? 0;
        if (sessionRank < minRank) return false;
      }
      return true;
    });
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

// POST /api/discovery/draft-rig — generate candidate rig spec from discovered sessions
discoveryRoutes.post("/draft-rig", (c) => {
  const { discoveryRepo } = getDeps(c);
  const sessions = discoveryRepo.listDiscovered("active");
  const result = generateDraftRig(sessions);
  c.header("Content-Type", "text/yaml");
  return c.body(result.yaml);
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

  const result = await claimService.claim({ discoveredId: id, rigId, logicalId });

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

// POST /api/discovery/:id/bind — bind discovered session to existing logical node
discoveryRoutes.post("/:id/bind", async (c) => {
  const { claimService } = getDeps(c);
  const id = c.req.param("id")!;
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigId = typeof body["rigId"] === "string" ? body["rigId"] : "";
  const logicalId = typeof body["logicalId"] === "string" ? body["logicalId"] : "";

  if (!rigId) {
    return c.json({ error: "rigId is required" }, 400);
  }
  if (!logicalId) {
    return c.json({ error: "logicalId is required" }, 400);
  }

  const result = await claimService.bind({ discoveredId: id, rigId, logicalId });
  if (result.ok) {
    return c.json(result, 201);
  }

  switch (result.code) {
    case "not_found":
    case "rig_not_found":
    case "node_not_found":
      return c.json(result, 404);
    case "not_active":
    case "already_bound":
    case "runtime_mismatch":
      return c.json(result, 409);
    default:
      return c.json(result, 500);
  }
});

// POST /api/discovery/:id/adopt — UI-friendly composite adopt route
discoveryRoutes.post("/:id/adopt", async (c) => {
  const { claimService } = getDeps(c);
  const id = c.req.param("id")!;
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigId = typeof body["rigId"] === "string" ? body["rigId"] : "";
  const target = body["target"] && typeof body["target"] === "object" ? body["target"] as Record<string, unknown> : null;

  if (!rigId) {
    return c.json({ error: "rigId is required" }, 400);
  }
  if (!target) {
    return c.json({ error: "target is required" }, 400);
  }

  const kind = typeof target["kind"] === "string" ? target["kind"] : "";
  if (kind === "node") {
    const logicalId = typeof target["logicalId"] === "string" ? target["logicalId"] : "";
    if (!logicalId) {
      return c.json({ error: "target.logicalId is required" }, 400);
    }
    const result = await claimService.bind({ discoveredId: id, rigId, logicalId });
    if (result.ok) {
      return c.json({ ...result, action: "bind", logicalId }, 201);
    }

    switch (result.code) {
      case "not_found":
      case "rig_not_found":
      case "node_not_found":
        return c.json(result, 404);
      case "not_active":
      case "already_bound":
      case "runtime_mismatch":
        return c.json(result, 409);
      default:
        return c.json(result, 500);
    }
  }

  if (kind === "pod") {
    const podId = typeof target["podId"] === "string" ? target["podId"] : "";
    const podNamespace = typeof target["podNamespace"] === "string" ? target["podNamespace"] : "";
    const memberName = typeof target["memberName"] === "string" ? target["memberName"] : "";
    if (!podId) {
      return c.json({ error: "target.podId is required" }, 400);
    }
    if (!podNamespace) {
      return c.json({ error: "target.podNamespace is required" }, 400);
    }
    if (!memberName) {
      return c.json({ error: "target.memberName is required" }, 400);
    }

    const result = await claimService.createAndBindToPod({
      discoveredId: id,
      rigId,
      podId,
      podNamespace,
      memberName,
    });
    if (result.ok) {
      return c.json({ ...result, action: "create_and_bind", logicalId: `${podNamespace}.${memberName}` }, 201);
    }

    switch (result.code) {
      case "not_found":
      case "rig_not_found":
      case "pod_not_found":
        return c.json(result, 404);
      case "not_active":
      case "duplicate_logical_id":
      case "invalid_member_name":
      case "invalid_pod_namespace":
        return c.json(result, 409);
      default:
        return c.json(result, 500);
    }
  }

  return c.json({ error: `Unsupported target kind "${kind}"` }, 400);
});
