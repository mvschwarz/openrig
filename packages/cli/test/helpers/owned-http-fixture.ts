import { createServer, type Server } from "node:http";
import { randomInt } from "node:crypto";
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

/** Windows can assign port 0 a low port that fetch refuses (for example 6566).
 * Bind a bounded high-port candidate instead, registering only the actual listener. */
export async function listenOwnedHttpFixture(server: Server, options: { host?: string } = { host: "127.0.0.1" }): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        try { server.listen(randomInt(49152, 65536), options.host); }
        catch (error) { server.off("error", failed); failed(error as Error); }
      });
      allowOwnedHttpFixture(server);
      return;
    } catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt === 15) throw error;
    }
  }
}

/** Bind a fetch-compatible port and close it before handing it to a refusal test.
 * As with any released port, this cannot reserve it against another process. */
export async function closedOwnedHttpPort(): Promise<number> {
  const server = createServer();
  try {
    await listenOwnedHttpFixture(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owned refusal fixture lacks a TCP address");
    return address.port;
  } finally {
    if (server.listening) await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
}
