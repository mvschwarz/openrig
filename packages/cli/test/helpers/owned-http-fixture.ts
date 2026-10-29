import type { Server } from "node:http";
import { allowFetchTarget } from "../fetch-guard.js";

/** Register only the loopback origins of this test's already-bound HTTP server.
 * The OS may choose a low ephemeral port; the guard itself remains unchanged. */
export function allowOwnedHttpFixture(server: Server): void {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned HTTP fixture has not bound a TCP port");
  const hosts = address.address === "::" ? ["127.0.0.1", "[::1]", "localhost"]
    : address.address === "0.0.0.0" ? ["127.0.0.1", "localhost"]
      : address.address === "::1" ? ["[::1]"] : address.address.startsWith("127.") ? [address.address] : [];
  if (!hosts.length) throw new Error("Owned HTTP fixture did not bind a loopback-compatible address");
  for (const host of hosts) allowFetchTarget(`http://${host}:${address.port}`);
}
