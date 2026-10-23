import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createDb } from "../../src/db/connection.ts";
import { RigRepository } from "../../src/domain/rig-repository.ts";
import { rigsRoutes } from "../../src/routes/rigs.ts";

const db = createDb(process.argv[2]);
const repo = new RigRepository(db);
const transaction = db.transaction.bind(db);
db.transaction = (fn) => {
  const run = transaction(fn);
  return (...args) => {
    const value = run(...args);
    // The INSERT and correlation update have committed. Exit before the route can send a response.
    const committed = db.prepare("SELECT rig_id FROM operation_correlations WHERE rig_id IS NOT NULL LIMIT 1").get();
    if (committed) process.exit(37);
    return value;
  };
};
const app = new Hono();
app.use("*", async (c, next) => { c.set("rigRepo", repo); await next(); });
app.route("/api/rigs", rigsRoutes);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
  process.stdout.write(`PORT:${info.port}\n`);
});
