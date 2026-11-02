import http from "node:http";
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { listenOwnedHttpFixture } from "./helpers/owned-http-fixture.js";

it("binds a fetch-compatible owned loopback listener", async () => {
  const server = http.createServer((_req, res) => res.end("owned fixture"));
  try {
    await listenOwnedHttpFixture(server);
    const address = server.address() as { port: number; address: string };
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThanOrEqual(49152);
    expect(address.port).toBeLessThan(65536);
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("owned fixture");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it.each(["EADDRINUSE", "EACCES"])("retries %s without retaining error or listening handlers", async code => {
  const server = new EventEmitter();
  const ports: number[] = [];
  Object.assign(server, {
    listen(port: number, host: string) {
      expect(host).toBe("127.0.0.1"); ports.push(port);
      queueMicrotask(() => server.emit(ports.length === 1 ? "error" : "listening", Object.assign(new Error(code), { code })));
    },
    address: () => ({ address: "127.0.0.1", port: ports.at(-1) }),
  });
  await listenOwnedHttpFixture(server as http.Server);
  expect(ports).toHaveLength(2);
  expect(ports.every(port => port >= 49152 && port < 65536)).toBe(true);
  expect(server.listenerCount("error")).toBe(0);
  expect(server.listenerCount("listening")).toBe(0);
});

it("bounds busy-port retries", async () => {
  const server = new EventEmitter(); let attempts = 0;
  Object.assign(server, { listen() { attempts++; queueMicrotask(() => server.emit("error", Object.assign(new Error("busy"), { code: "EADDRINUSE" }))); } });
  await expect(listenOwnedHttpFixture(server as http.Server)).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(attempts).toBe(16);
  expect(server.listenerCount("error")).toBe(0);
  expect(server.listenerCount("listening")).toBe(0);
});
