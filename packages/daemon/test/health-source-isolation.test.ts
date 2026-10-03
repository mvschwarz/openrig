import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HealthProjectionService, type HealthObservationSource } from "../src/domain/health-detectors.js";
import { DEFAULT_HEALTH_POLICY } from "../src/domain/health-policy.js";
import { boundHealthEvidence, deriveHealthSourceFreshness } from "../src/domain/health-projection.js";
import { healthRoutes } from "../src/routes/health.js";

const at = "2026-10-03T12:00:00.000Z";
const working: HealthObservationSource = {
  name: "context", detectors: ["context.pressure"],
  read: () => [{ kind: "context-pressure", scope: { type: "seat", rigId: "rig", seatId: "seat" },
    episodeStartedAt: at, lastObservedAt: at, sourceName: "test", continuity: "same",
    source: boundHealthEvidence([{ type: "context-usage", sourceOrder: 0, observedAt: at,
      nodeId: "seat", sessionId: "session", usedPercentage: 99, available: true, fresh: true }],
      { source: "context-usage", startedAt: at, endedAt: at, limit: 1, retentionSeconds: 600 },
      deriveHealthSourceFreshness({ evaluatedAt: at, newestSourceAt: at, maxAgeSeconds: 600, available: true })) }],
};
it("serves the remaining sources over HTTP and names a failed source without invented counts", async () => {
  const broken = { name: "checkpoints", read: () => { throw new Error("broken checkpoint JSON"); } };
  const service = new HealthProjectionService([broken, working]);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("healthProjection" as never, service as never); await next(); });
  app.route("/", healthRoutes());
  const response = await app.request("/");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.records).toHaveLength(1);
  expect(body.records[0]).toMatchObject({ detector: "context.pressure", status: "active" });
  expect(body.coverage).toEqual([{ source: "checkpoints", status: "unavailable", partial: true,
    evaluatedAt: expect.any(String), reason: "broken checkpoint JSON" }]);
  expect((await app.request("/?limit=201")).status).toBe(400);
});
it("isolates a coverage-read error and discards the failed source's records", () => {
  const service = new HealthProjectionService([{ ...working, name: "broken-coverage", coverage: () => { throw new Error("coverage unavailable"); } }, working]);
  const result = service.list();
  expect(result.records).toHaveLength(1);
  expect(result.coverage?.[0]).toMatchObject({ source: "broken-coverage", status: "unavailable", reason: "coverage unavailable" });
});
it("never executes disabled context or checkpoint readers and clears prior failures", () => {
  let disabledDetectors: string[] = [];
  const read = vi.fn(() => { throw new Error("source offline"); });
  const sources = ["context.pressure", "process.ceremony-amplification"].map(detector => ({ name: detector, detectors: [detector], read }));
  const service = new HealthProjectionService(sources, () => ({ version: "test", policy: { ...DEFAULT_HEALTH_POLICY, disabledDetectors } }));
  expect(service.list().coverage).toHaveLength(2);
  read.mockClear();
  disabledDetectors = sources.map(s => s.name);
  expect(service.list().records).toEqual([]);
  expect(service.coverage()).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});
it("does not hide a global policy error as a successful source read", () => {
  const service = new HealthProjectionService(working, () => { throw new Error("policy corrupted"); });
  expect(() => service.list()).toThrow("policy corrupted");
});
