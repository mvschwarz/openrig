import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { startSocketInbound, type SocketInboundHandle } from "../src/domain/gateway/slack/socket-inbound.js";

async function completion(handle: SocketInboundHandle): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.done.then(() => "resolved"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("pending"), 250); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

it("settles stopped backoff and immediate-stop loops, and preserves finite-connect completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-socket-stop-"));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "synthetic outage" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let handle: SocketInboundHandle | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const router = new InboundRouter({
      queue: { createQitem: async () => { throw new Error("unexpected inbound event"); } },
      seen: new SeenStore(join(home, "seen.jsonl")),
      deadLetter: new DeadLetterStore<SlackEvent>(join(home, "dead.jsonl")),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
    });
    const fetchImpl = (_url: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}`, init);
    for (const phase of ["backoff", "immediate", "finite"]) {
      handle = startSocketInbound("synthetic-app-token", router, { fetchImpl, ...(phase === "finite" ? { inboundMaxConnects: 1 } : {}) });
      if (phase !== "immediate") {
        await expect.poll(() => handle!.status().state).toBe("disconnected");
      }
      if (phase !== "finite") handle.stop();
      expect(await completion(handle)).toBe("resolved");
      handle.stop();
      expect(await completion(handle)).toBe("resolved");
      if (phase === "backoff") {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(requests).toBe(1); // canceled backoff never starts another connection
      }
    }
  } finally {
    handle?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

it("settles an already connected native WebSocket loop on repeated stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-socket-connected-"));
  const sockets = new Set<import("node:stream").Duplex>();
  const server = createServer((_req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${address.port}/socket` }));
  });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", () => socket.end(Buffer.from([0x88, 0x00])));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let handle: SocketInboundHandle | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const router = new InboundRouter({
      queue: { createQitem: async () => { throw new Error("unexpected inbound event"); } },
      seen: new SeenStore(join(home, "seen.jsonl")),
      deadLetter: new DeadLetterStore<SlackEvent>(join(home, "dead.jsonl")),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
    });
    handle = startSocketInbound("synthetic-app-token", router, {
      fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
    });
    await expect.poll(() => handle!.status().state).toBe("connected");
    handle.stop();
    handle.stop();
    expect(await completion(handle)).toBe("resolved");
  } finally {
    handle?.stop();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

it("abandons a native WebSocket whose upgrade never answers and opens a new one", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-socket-open-timeout-"));
  const held = new Set<import("node:stream").Duplex>();
  let upgrades = 0;
  const server = createServer((_req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${address.port}/socket` }));
  });
  // Accept the TCP connection and the upgrade request, then never answer it.
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    held.add(socket);
    socket.on("close", () => held.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let handle: SocketInboundHandle | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const router = new InboundRouter({
      queue: { createQitem: async () => { throw new Error("unexpected inbound event"); } },
      seen: new SeenStore(join(home, "seen.jsonl")),
      deadLetter: new DeadLetterStore<SlackEvent>(join(home, "dead.jsonl")),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
    });
    handle = startSocketInbound("synthetic-app-token", router, {
      fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
      openTimeoutMs: 200,
      inboundMaxConnects: 2,
    });
    await expect.poll(() => upgrades).toBe(1);
    expect(handle.status().state).toBe("connecting"); // the server holds the upgrade unanswered
    // The timeout abandons it and, after the first backoff, a second socket really dials.
    await expect.poll(() => upgrades, { timeout: 3000 }).toBe(2);
    await handle.done; // the second attempt times out too, ending the allowed attempts
    expect(handle.status()).toMatchObject({ generation: 2, state: "disconnected" });
  } finally {
    handle?.stop();
    for (const socket of held) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

it("retries when a native WebSocket handshake is refused, though Node fires no close for it", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-socket-refused-"));
  // A port with nothing listening: the handshake is refused at once.
  const vacant = createServer();
  vacant.listen(0, "127.0.0.1");
  await once(vacant, "listening");
  const vacantAddress = vacant.address();
  if (!vacantAddress || typeof vacantAddress === "string") throw new Error("missing fixture address");
  await new Promise<void>((resolve) => vacant.close(() => resolve()));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${vacantAddress.port}/socket` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let handle: SocketInboundHandle | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const router = new InboundRouter({
      queue: { createQitem: async () => { throw new Error("unexpected inbound event"); } },
      seen: new SeenStore(join(home, "seen.jsonl")),
      deadLetter: new DeadLetterStore<SlackEvent>(join(home, "dead.jsonl")),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
    });
    handle = startSocketInbound("synthetic-app-token", router, {
      fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
      openTimeoutMs: 60_000, // far beyond the test: the refusal alone must end the attempt
      inboundMaxConnects: 2,
    });
    await handle.done; // both attempts end on the refusal, without the timeout
    expect(handle.status()).toMatchObject({ generation: 2, state: "disconnected" });
  } finally {
    handle?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
