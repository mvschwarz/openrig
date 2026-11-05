import type { Server } from "node:http";
import { allowFetchTarget } from "../../cli/test/fetch-guard.js";

/** Register the actual bound loopback fixture, regardless of OS port range. */
export function httpFixtureOrigin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error("Expected a bound IPv4 loopback HTTP fixture");
  const origin = `http://127.0.0.1:${address.port}`;
  allowFetchTarget(origin);
  return origin;
}
