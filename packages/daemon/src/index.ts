import { serve } from "@hono/node-server";
import { createDaemon } from "./startup.js";

export async function startServer(port?: number) {
  const p = port ?? parseInt(process.env["RIGGED_PORT"] ?? "7433", 10);
  const dbPath = process.env["RIGGED_DB"] ?? "rigged.sqlite";

  const { app } = await createDaemon({ dbPath });

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
