import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { ServiceOrchestrator } from "../domain/service-orchestrator.js";
import type { ComposeServicesAdapter } from "../adapters/compose-services-adapter.js";

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    serviceOrchestrator: c.get("serviceOrchestrator" as never) as ServiceOrchestrator | undefined,
    composeAdapter: c.get("composeAdapter" as never) as ComposeServicesAdapter | undefined,
  };
}

export function envRoutes(): Hono {
  const app = new Hono();

  // GET /api/rigs/:rigId/env — env status with fresh receipt
  app.get("/", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const { rigRepo, serviceOrchestrator } = getDeps(c);
    const record = rigRepo.getServicesRecord(rigId);
    if (!record) {
      return c.json({ ok: true, hasServices: false });
    }

    // Refresh receipt with honest probe tracking
    let receipt = record.latestReceiptJson ? JSON.parse(record.latestReceiptJson) : null;
    let probeStatus: "fresh" | "stale" | "no_orchestrator" = "no_orchestrator";
    let probeError: string | undefined;
    if (serviceOrchestrator) {
      try {
        const fresh = await serviceOrchestrator.captureReceipt(rigId);
        if (fresh) {
          receipt = fresh;
          probeStatus = "fresh";
        } else {
          probeStatus = "stale";
          probeError = "Probe returned no receipt — services record may no longer exist";
        }
      } catch (err) {
        probeStatus = "stale";
        probeError = (err as Error).message;
      }
    }

    // Parse surfaces from specJson (best-effort)
    let surfaces: unknown = undefined;
    try {
      const spec = JSON.parse(record.specJson) as Record<string, unknown>;
      if (spec["surfaces"]) surfaces = spec["surfaces"];
    } catch { /* safe default */ }

    return c.json({
      ok: true,
      hasServices: true,
      kind: record.kind,
      composeFile: record.composeFile,
      projectName: record.projectName,
      receipt,
      probeStatus,
      ...(probeError ? { probeError } : {}),
      ...(surfaces ? { surfaces } : {}),
    });
  });

  // GET /api/rigs/:rigId/env/logs — service logs
  app.get("/logs", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const { rigRepo, composeAdapter } = getDeps(c);
    const record = rigRepo.getServicesRecord(rigId);
    if (!record) {
      return c.json({ error: "No services configured for this rig" }, 404);
    }

    if (!composeAdapter) {
      return c.json({ error: "Compose adapter not available" }, 500);
    }

    const service = c.req.query("service");
    const tailStr = c.req.query("tail");
    const tail = tailStr ? parseInt(tailStr, 10) : 100;

    let spec: { profiles?: string[] } = {};
    try { spec = JSON.parse(record.specJson); } catch { /* empty */ }

    const result = await composeAdapter.logs({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
      service: service || undefined,
      tail,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({ ok: true, output: result.output });
  });

  // POST /api/rigs/:rigId/env/down — tear down services
  app.post("/down", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const { rigRepo, serviceOrchestrator } = getDeps(c);
    const record = rigRepo.getServicesRecord(rigId);
    if (!record) {
      return c.json({ error: "No services configured for this rig" }, 404);
    }

    if (!serviceOrchestrator) {
      return c.json({ error: "Service orchestrator not available" }, 500);
    }

    const body = await c.req.json<{ volumes?: boolean }>().catch(() => ({} as { volumes?: boolean }));

    // Override down policy if --volumes requested
    if (body.volumes) {
      let spec: { downPolicy?: string } = {};
      try { spec = JSON.parse(record.specJson); } catch { /* empty */ }
      // Force down_and_volumes regardless of spec policy
    }

    const result = await serviceOrchestrator.teardown(rigId);

    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500);
    }

    return c.json({ ok: true });
  });

  return app;
}
