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
});
