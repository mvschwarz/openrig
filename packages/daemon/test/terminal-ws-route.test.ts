import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve, type ServerType } from "@hono/node-server";
import http from "node:http";
import * as fs from "node:fs";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";

const TOKEN = "test-ws-route-token";
const PORT = 19876;

let server: ServerType;

beforeAll(async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tmuxAdapter" as never, {
      hasSession: async () => true,
      setWindowOption: async () => ({ ok: true }),
      startPipePane: async () => ({ ok: true }),
      stopPipePane: async () => ({ ok: true }),
      sendKeys: async () => ({ ok: true }),
      sendText: async () => ({ ok: true }),
      resizeWindow: async () => ({ ok: true }),
    });
    await next();
  });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: TOKEN });
  server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
  injectWebSocket(server);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
});

afterAll(() => {
  server?.close();
});

function rawUpgrade(path: string, extraHeaders?: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": Buffer.from("test-key-12345678").toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...extraHeaders,
      },
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("upgrade", (_res, _socket, _head) => {
      resolve({ statusCode: 101, body: "" });
      _socket.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

describe("terminal WebSocket route (production path)", () => {
  it("valid token WS upgrade does NOT return 404 (the QA blocker regression)", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=${TOKEN}`,
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode, `expected non-404, got ${result.statusCode}: ${result.body}`).not.toBe(404);
  });

  it("missing token returns 401", async () => {
    const result = await rawUpgrade(
      "/api/terminal/test-session",
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode).toBe(401);
  });

  it("bad Origin returns 403", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=${TOKEN}`,
      { Origin: "http://evil.example.com" },
    );
    expect(result.statusCode).toBe(403);
  });

  it("wrong token returns 401", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=wrong`,
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode).toBe(401);
  });
});

describe("terminal WebSocket input ordering", () => {
  const ORDER_PORT = 19878;
  const ORDER_TOKEN = "order-test-token";
  let orderServer: ServerType;
  const textCompletions: string[] = [];

  beforeAll(async () => {
    const app3 = new Hono();
    app3.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => true,
        setWindowOption: async () => ({ ok: true }),
        startPipePane: async () => ({ ok: true }),
        stopPipePane: async () => ({ ok: true }),
        sendKeys: async () => ({ ok: true }),
        sendText: async (_name: string, text: string) => {
          await new Promise((resolve) => setTimeout(resolve, text === "e" ? 30 : 0));
          textCompletions.push(text);
          return { ok: true };
        },
        resizeWindow: async () => ({ ok: true }),
      });
      await next();
    });
    const { injectWebSocket: inject3, upgradeWebSocket: upgrade3 } = createNodeWebSocket({ app: app3 });
    registerTerminalWs(app3, upgrade3 as never, { bearerToken: ORDER_TOKEN });
    orderServer = serve({ fetch: app3.fetch, port: ORDER_PORT, hostname: "127.0.0.1" });
    inject3(orderServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    orderServer?.close();
  });

  it("serializes rapid text messages before calling tmux", async () => {
    textCompletions.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${ORDER_PORT}/api/terminal/order-test?token=${ORDER_TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket failed to open"));
    });

    for (const text of ["e", "c", "h", "o"]) {
      ws.send(JSON.stringify({ type: "text", text }));
    }

    await vi.waitFor(() => {
      expect(textCompletions.join("")).toBe("echo");
    }, { timeout: 1000 });
    ws.close();
  });
});

describe("terminal WebSocket lifecycle (session death)", () => {
  const LIFECYCLE_PORT = 19877;
  const LIFECYCLE_TOKEN = "lifecycle-test-token";
  let lifecycleServer: ServerType;
  let sessionAlive = true;
  const stopPipePaneCalls: string[] = [];

  beforeAll(async () => {
    const app2 = new Hono();
    app2.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => sessionAlive,
        setWindowOption: async () => ({ ok: true }),
        startPipePane: async () => ({ ok: true }),
        stopPipePane: async (name: string) => { stopPipePaneCalls.push(name); return { ok: true }; },
        sendKeys: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        resizeWindow: async () => ({ ok: true }),
      });
      await next();
    });
    const { injectWebSocket: inject2, upgradeWebSocket: upgrade2 } = createNodeWebSocket({ app: app2 });
    registerTerminalWs(app2, upgrade2 as never, { bearerToken: LIFECYCLE_TOKEN, livenessIntervalMs: 100 });
    lifecycleServer = serve({ fetch: app2.fetch, port: LIFECYCLE_PORT, hostname: "127.0.0.1" });
    inject2(lifecycleServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    lifecycleServer?.close();
  });

  it("session death closes the WebSocket with code 1001", async () => {
    sessionAlive = true;
    stopPipePaneCalls.length = 0;

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${LIFECYCLE_PORT}/api/terminal/death-test?token=${LIFECYCLE_TOKEN}`);
      ws.onopen = () => {
        sessionAlive = false;
      };
      ws.onclose = (evt) => {
        resolve({ code: evt.code, reason: evt.reason });
      };
      ws.onerror = () => {
        resolve({ code: 0, reason: "error" });
      };
    });

    const result = await closePromise;
    expect(result.code).toBe(1001);
    expect(result.reason).toContain("tmux session terminated");
    await vi.waitFor(() => {
      expect(stopPipePaneCalls).toContain("death-test");
    }, { timeout: 2000 });
  }, 10000);
});

// OPR.0.4.0.38 - the broker behaviors at the real WebSocket route: multiple
// subscribers of one session share ONE pipe and a fanned-out stream, and a
// client resize message never reaches the pane (FR-7 fixed geometry).
describe("terminal WebSocket broker (multi-subscriber route)", () => {
  const BROKER_PORT = 19879;
  const BROKER_TOKEN = "broker-test-token";
  let brokerServer: ServerType;
  const startPipePaneCalls: string[] = [];
  const resizeWindowCalls: Array<{ cols: number; rows: number }> = [];
  let capturedOutputPath: string | null = null;

  beforeAll(async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => true,
        setWindowOption: async () => ({ ok: true }),
        resizeWindow: async (_n: string, cols: number, rows: number) => {
          resizeWindowCalls.push({ cols, rows });
          return { ok: true };
        },
        startPipePane: async (name: string, outputPath: string) => {
          startPipePaneCalls.push(name);
          capturedOutputPath = outputPath;
          return { ok: true };
        },
        stopPipePane: async () => ({ ok: true }),
        sendKeys: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        capturePaneScreen: async () => null,
        getPaneCursorPosition: async () => null,
      });
      await next();
    });
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: BROKER_TOKEN });
    brokerServer = serve({ fetch: app.fetch, port: BROKER_PORT, hostname: "127.0.0.1" });
    injectWebSocket(brokerServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    brokerServer?.close();
  });

  function openWs(session: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${BROKER_PORT}/api/terminal/${session}?token=${BROKER_TOKEN}`);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("ws failed to open"));
    });
  }

  it("two subscribers of one session share ONE pipe-pane and both receive fanned-out output", async () => {
    startPipePaneCalls.length = 0;
    capturedOutputPath = null;
    const aRecv: string[] = [];
    const bRecv: string[] = [];

    const a = await openWs("fanout-session");
    a.onmessage = (e) => { if (typeof e.data === "string") aRecv.push(e.data); };
    const b = await openWs("fanout-session");
    b.onmessage = (e) => { if (typeof e.data === "string") bRecv.push(e.data); };

    // Give the second attach a beat to register on the existing broker.
    await new Promise<void>((r) => setTimeout(r, 80));
    expect(startPipePaneCalls.filter((n) => n === "fanout-session")).toHaveLength(1);
    expect(capturedOutputPath).toBeTruthy();

    fs.appendFileSync(capturedOutputPath!, "FANOUT-BYTES");
    await vi.waitFor(() => {
      expect(aRecv.join("")).toContain("FANOUT-BYTES");
      expect(bRecv.join("")).toContain("FANOUT-BYTES");
    }, { timeout: 1500 });

    a.close();
    b.close();
  }, 10000);

  it("a client resize message never resizes the pane (FR-7): only the one canonical geometry call", async () => {
    resizeWindowCalls.length = 0;
    const ws = await openWs("resize-session");
    // One canonical-geometry resize happens at broker open.
    await vi.waitFor(() => {
      expect(resizeWindowCalls).toHaveLength(1);
    }, { timeout: 1000 });
    expect(resizeWindowCalls[0]).toEqual({ cols: 90, rows: 27 });

    ws.send(JSON.stringify({ type: "resize", cols: 200, rows: 9 }));
    // Give the message time to (not) be processed.
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(resizeWindowCalls).toHaveLength(1); // unchanged - the resize was ignored

    ws.close();
  }, 10000);
});

// OPR.0.4.0.38 - the detach-during-attach race (dev1-guard watchpoint #4): a
// WebSocket that closes WHILE the async broker attach is still in flight must
// not leave a phantom subscriber holding the pipe open.
describe("terminal WebSocket detach-during-attach race", () => {
  const RACE_PORT = 19880;
  const RACE_TOKEN = "race-test-token";
  let raceServer: ServerType;
  const stopPipePaneCalls: string[] = [];
  let capturedOutputPath: string | null = null;

  beforeAll(async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => true,
        setWindowOption: async () => ({ ok: true }),
        resizeWindow: async () => ({ ok: true }),
        // Slow pipe-start widens the attach window so the client close lands
        // while attach is still pending.
        startPipePane: async (_name: string, outputPath: string) => {
          capturedOutputPath = outputPath;
          await new Promise((r) => setTimeout(r, 120));
          return { ok: true };
        },
        stopPipePane: async (name: string) => { stopPipePaneCalls.push(name); return { ok: true }; },
        sendKeys: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        capturePaneScreen: async () => null,
        getPaneCursorPosition: async () => null,
      });
      await next();
    });
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: RACE_TOKEN });
    raceServer = serve({ fetch: app.fetch, port: RACE_PORT, hostname: "127.0.0.1" });
    injectWebSocket(raceServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    raceServer?.close();
  });

  it("closing the WS mid-attach still tears the broker down (stops pipe, deletes temp - no leak)", async () => {
    stopPipePaneCalls.length = 0;
    capturedOutputPath = null;

    const ws = new WebSocket(`ws://127.0.0.1:${RACE_PORT}/api/terminal/race-session?token=${RACE_TOKEN}`);
    // Close immediately on open - while the server's attach is still awaiting the
    // 120ms startPipePane.
    ws.onopen = () => { ws.close(); };
    await new Promise<void>((resolve) => { ws.onclose = () => resolve(); });

    // Once attach resolves, the route must re-detach the closed subscriber, which
    // (being the last/only one) tears the broker down: stop pipe + unlink temp.
    await vi.waitFor(() => {
      expect(stopPipePaneCalls).toContain("race-session");
      expect(capturedOutputPath).toBeTruthy();
      expect(fs.existsSync(capturedOutputPath!)).toBe(false);
    }, { timeout: 2000 });
  }, 10000);
});
