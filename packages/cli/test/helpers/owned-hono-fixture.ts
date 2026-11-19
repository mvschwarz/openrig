import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { listenOwnedHttpFixture } from "./owned-http-fixture.js";

/** Return Hono's request adapter on a bound, registered, fetch-compatible listener. */
export async function serveOwnedHonoFixture(fetch: Parameters<typeof getRequestListener>[0]): Promise<Server> {
  const server = createServer(getRequestListener(fetch));
  await listenOwnedHttpFixture(server);
  return server;
}
