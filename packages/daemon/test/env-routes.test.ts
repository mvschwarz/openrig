import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { envRoutes } from "../src/routes/env.js";

function createApp(deps: {
  getServicesRecord: (rigId: string) => unknown;
  captureReceipt?: (rigId: string) => unknown;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, { getServicesRecord: deps.getServicesRecord });
    c.set("serviceOrchestrator" as never, deps.captureReceipt ? { captureReceipt: deps.captureReceipt } : undefined);
    c.set("composeAdapter" as never, undefined);
    await next();
  });
  app.route("/api/rigs/:rigId/env", envRoutes());
  return app;
}

describe("env routes", () => {
  it("GET /api/rigs/:rigId/env returns hasServices false when no record", async () => {
    const app = createApp({ getServicesRecord: () => null });
    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(false);
    expect(body["surfaces"]).toBeUndefined();
  });

  it("GET /api/rigs/:rigId/env returns surfaces from specJson for service-backed rigs", async () => {
    const specJson = JSON.stringify({
      kind: "compose",
      compose_file: "svc.compose.yaml",
      project_name: "test-svc",
      down_policy: "down",
      wait_for: [{ url: "http://127.0.0.1:8200/health" }],
      surfaces: {
        urls: [
          { name: "Vault UI", url: "http://127.0.0.1:8200/ui" },
          { name: "Vault API", url: "http://127.0.0.1:8200/v1" },
        ],
        commands: [
          { name: "Vault status", command: "vault status" },
        ],
      },
    });

    const app = createApp({
      getServicesRecord: () => ({
        rigId: "rig-1",
        kind: "compose",
        specJson,
        rigRoot: "/tmp",
        composeFile: "/tmp/svc.compose.yaml",
        projectName: "test-svc",
        latestReceiptJson: null,
        createdAt: "2026-04-09T00:00:00Z",
        updatedAt: "2026-04-09T00:00:00Z",
      }),
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(true);
    expect(body["kind"]).toBe("compose");

    const surfaces = body["surfaces"] as Record<string, unknown>;
    expect(surfaces).toBeDefined();
    const urls = surfaces["urls"] as Array<{ name: string; url: string }>;
    expect(urls).toHaveLength(2);
    expect(urls[0]!.name).toBe("Vault UI");
    expect(urls[0]!.url).toBe("http://127.0.0.1:8200/ui");
    const commands = surfaces["commands"] as Array<{ name: string; command: string }>;
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("Vault status");
  });

  const SERVICE_RECORD = {
    rigId: "rig-1",
    kind: "compose",
    specJson: JSON.stringify({ kind: "compose", compose_file: "svc.yaml" }),
    rigRoot: "/tmp",
    composeFile: "/tmp/svc.yaml",
    projectName: "test-svc",
    latestReceiptJson: JSON.stringify({ kind: "compose", services: [{ name: "vault", status: "running", health: "healthy" }], capturedAt: "2026-04-09T11:00:00Z" }),
    createdAt: "2026-04-09T00:00:00Z",
    updatedAt: "2026-04-09T00:00:00Z",
  };

  it("GET /env returns probeStatus=stale with probeError when captureReceipt throws", async () => {
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      captureReceipt: () => { throw new Error("compose ps failed: connection refused"); },
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(true);
    expect(body["probeStatus"]).toBe("stale");
    expect(body["probeError"]).toContain("connection refused");
    // Cached receipt is still returned
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(receipt["capturedAt"]).toBe("2026-04-09T11:00:00Z");
  });

  it("GET /env returns probeStatus=fresh when captureReceipt succeeds", async () => {
    const freshReceipt = { kind: "compose", services: [{ name: "vault", status: "running", health: "healthy" }], capturedAt: "2026-04-09T12:00:00Z" };
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      captureReceipt: () => freshReceipt,
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["probeStatus"]).toBe("fresh");
    expect(body["probeError"]).toBeUndefined();
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt["capturedAt"]).toBe("2026-04-09T12:00:00Z");
  });

  it("GET /env returns probeStatus=no_orchestrator when serviceOrchestrator is absent", async () => {
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      // no captureReceipt → serviceOrchestrator is undefined
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["probeStatus"]).toBe("no_orchestrator");
    expect(body["probeError"]).toBeUndefined();
    // Cached receipt still returned
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(receipt["capturedAt"]).toBe("2026-04-09T11:00:00Z");
  });

  it("GET /env returns probeStatus=stale when captureReceipt returns null", async () => {
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      captureReceipt: () => null,
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(true);
    // null probe is NOT fresh — services record may have disappeared
    expect(body["probeStatus"]).not.toBe("fresh");
    expect(body["probeStatus"]).toBe("stale");
    expect(body["probeError"]).toContain("no receipt");
    // Cached receipt preserved
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt["capturedAt"]).toBe("2026-04-09T11:00:00Z");
  });

  it("GET /env does not include probeStatus when hasServices is false", async () => {
    const app = createApp({ getServicesRecord: () => null });
    const res = await app.request("/api/rigs/rig-1/env");
    const body = await res.json() as Record<string, unknown>;
    expect(body["hasServices"]).toBe(false);
    expect(body["probeStatus"]).toBeUndefined();
  });
});
