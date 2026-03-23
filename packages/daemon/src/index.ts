import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { coreSchema } from "./db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "./db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "./db/migrations/003_events.js";
import { RigRepository } from "./domain/rig-repository.js";

export function startServer(port?: number) {
  const p = port ?? parseInt(process.env["RIGGED_PORT"] ?? "7433", 10);
  const dbPath = process.env["RIGGED_DB"] ?? "rigged.sqlite";

  const db = createDb(dbPath);
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema]);

  const rigRepo = new RigRepository(db);
  const app = createApp({ rigRepo });

  return serve({ fetch: app.fetch, port: p }, (info) => {
    console.log(`rigged daemon listening on http://localhost:${info.port}`);
  });
}

// Only start the server when this file is executed directly (not imported).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  startServer();
}
