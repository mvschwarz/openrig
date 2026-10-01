import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// The child keeps Node's normal unhandled-rejection behavior. Use the built daemon
// in package tests; the native source audit may supply its own checkout explicitly.
const [phase, home, sourceRoot] = process.argv.slice(2);
const moduleRoot = sourceRoot ? join(sourceRoot, "packages/daemon/src") : fileURLToPath(new URL("../../dist/", import.meta.url));
const load = (path) => import(pathToFileURL(join(moduleRoot, path + (sourceRoot ? ".ts" : ".js"))));
const { startSocketInbound } = await load("domain/gateway/slack/socket-inbound");
const { InboundRouter } = await load("domain/gateway/slack/inbound");
const { SeenStore, DeadLetterStore, InboundReceiptStore } = await load("domain/gateway/slack/state-store");
const { makeQueuePorts } = await load("domain/gateway/slack/queue-access");
const { createDb } = await load("db/connection");
const { migrate } = await load("db/migrate");
const { ALL_MIGRATIONS } = await load("db/all-migrations");
const { QueueRepository } = await load("domain/queue-repository");
const { EventBus } = await load("domain/event-bus");
const deadDir = join(home, "dead");
mkdirSync(deadDir);
const dead = new DeadLetterStore(join(deadDir, "letters.jsonl"));
const seen = new SeenStore(join(home, "seen.jsonl"));
const db = createDb(join(home, "state.sqlite"));
migrate(db, ALL_MIGRATIONS);
const repo = new QueueRepository(db, new EventBus(db));
const router = new InboundRouter({
  queue: makeQueuePorts(repo), seen, deadLetter: dead, destination: "operator-agent@kernel",
  resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
});
const event = { type: "message", user: "U-FIXTURE", channel: "C-FIXTURE", text: "durable recovery", ts: "1000.1" };
let faults = 0;
let requests = 0;
const sockets = new Set();
const server = createServer((_request, response) => {
  requests++;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${server.address().port}/socket` }));
});
server.on("upgrade", (request, socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.once("data", () => socket.end(Buffer.from([0x88, 0])));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const inject = () => { dead.append(event, 1); chmodSync(deadDir, 0o500); };
if (phase === "onopen") inject();
let handle;
try {
  handle = startSocketInbound("synthetic-app-token", router, {
    retryIntervalMs: 30,
    receipts: new InboundReceiptStore(join(home, "receipts.jsonl")),
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init),
    log: (message) => {
      if (!message.includes("dead-letter retry failed")) return;
      assert.match(message, /EACCES|EPERM/);
      assert.equal(dead.readAll().length, 1, "failed rewrite must retain the owed disk entry");
      faults++;
      if (faults === 2) chmodSync(deadDir, 0o700);
    },
  });
  const deadline = Date.now() + 5000;
  while (handle.status().state !== "connected" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(handle.status().state, "connected");
  if (phase === "periodic") inject();
  while ((faults < 2 || dead.readAll().length > 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(faults, 2, "both errors logged without terminating the child");
  assert.equal(dead.readAll().length, 0, "next scheduled pass recovers after the real fault clears");
  assert.equal(repo.list({ limit: 100 }).length, 1, "seen delivery is not duplicated by retry");
  assert.ok(seen.load().has(event.ts));
  assert.equal(handle.status().state, "connected");
  assert.equal(requests, 1, "recovery does not require reconnecting");
  console.log(JSON.stringify({ phase, faults, remaining: 0, rows: 1, state: "connected", requests }));
} finally {
  chmodSync(deadDir, 0o700);
  handle?.stop();
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
