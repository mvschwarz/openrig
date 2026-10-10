import { describe, expect, it } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("finite telemetry app registration", () => {
  it("preserves legacy app construction and reports an unavailable epoch honestly", async () => {
    const db = createFullTestDb();
    try {
      // The shared fixture deliberately omits the lifecycle store and epoch.
      const { app } = createTestApp(db);
      const response = await app.request("/api/telemetry/v1/events");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "telemetry_read_unavailable" });
    } finally { db.close(); }
  });

  it("binds the real server registration to the supplied process boot epoch", async () => {
    const db = createFullTestDb();
    try {
      const { app } = createTestApp(db, { appDeps: { daemonBootEpoch: "fixture-process-boot" } });
      const response = await app.request("/api/telemetry/v1/events");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        source: { bootEpoch: "fixture-process-boot", sequenceSpaceId: null },
        rows: [],
        coverage: { gaps: [{ code: "historical_events_not_read", through: "0" }] },
      });
    } finally { db.close(); }
  });
});
