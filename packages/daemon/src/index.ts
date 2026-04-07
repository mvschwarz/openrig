import { serve } from "@hono/node-server";
import { readOpenRigEnv } from "./openrig-compat.js";
import { createDaemon } from "./startup.js";

export async function startServer(port?: number) {
  const p = port ?? parseInt(readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") ?? "7433", 10);
  const dbPath = readOpenRigEnv("OPENRIG_DB", "RIGGED_DB") ?? "openrig.sqlite";

  const { app } = await createDaemon({ dbPath });

  const h = readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST") ?? "127.0.0.1";

  return serve({ fetch: app.fetch, port: p, hostname: h }, (info) => {
    console.log(`OpenRig daemon listening on http://localhost:${info.port}`);
  });
}

// Only start the server when this file is executed directly (not imported).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  startServer();
}
