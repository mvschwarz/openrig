import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { seatRoutes } from "../src/routes/seat.js";
import { nodesRoutes } from "../src/routes/sessions.js";

const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const repo = new RigRepository(db);
  const rig = repo.createRig("owned-path-identity");
  for (const name of ["dev.%", "dev.%20", "dev. ", "dev.%2F", "dev./", "dev.é", "dev.normal"]) {
    repo.addNode(rig.id, name, { runtime: "terminal" });
  }
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("rigRepo" as never, repo); await next(); });
  app.route("/seat", seatRoutes);
  app.route("/rigs/:rigId/nodes", nodesRoutes);
  return { app, rig };
}

describe("route parameter identity is decoded once by Hono", () => {
  for (const name of ["dev.%", "dev.%20", "dev.%2F", "dev.é", "dev.normal"]) {
    it(`preserves node identity ${name} without retargeting another row`, async () => {
      const { app, rig } = fixture();
      const response = await app.request(`/rigs/${rig.id}/nodes/${encodeURIComponent(name)}`);
      expect(response.status).toBe(200);
      expect((await response.json()).logicalId).toBe(name);
    });
    it(`preserves the canonical seat reference ${name}`, async () => {
      const { app } = fixture();
      const ref = `${name}@owned-path-identity`;
      const response = await app.request(`/seat/status/${encodeURIComponent(ref)}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.logical_id).toBe(name);
      expect(body.seat_ref).toBe(ref);
    });
  }
});
