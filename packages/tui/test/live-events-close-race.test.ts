import { expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { subscribeActivityEvents } from "../src/live-events.js";

it("cancels an HTTP activity stream that finishes opening after subscription shutdown", async () => {
  let respond!: () => void;
  let reportArrival!: () => void;
  let reportClose!: () => void;
  const arrived = new Promise<void>((resolve) => { reportArrival = resolve; });
  const closed = new Promise<void>((resolve) => { reportClose = resolve; });
  const server = http.createServer((_req, res) => {
    res.once("close", reportClose);
    respond = () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
    };
    reportArrival();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const onEvent = vi.fn();
  const onStatus = vi.fn();
  const sub = subscribeActivityEvents({ open: () => fetch(url), onEvent, onStatus });
  try {
    await arrived; // the real HTTP request is pending, headers not sent yet
    sub.close();
    respond();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("leaked"), 500); }),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe("closed");
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  } finally {
    sub.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
