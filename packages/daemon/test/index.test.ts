import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const serveMock = vi.fn();
const createDaemonMock = vi.fn();
const serverMock = { prependListener: vi.fn() };
let signalListenersBefore: { SIGINT: Function[]; SIGTERM: Function[] };

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

vi.mock("../src/startup.js", () => ({
  createDaemon: createDaemonMock,
}));

describe("daemon startServer", () => {
  beforeEach(() => {
    signalListenersBefore = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    serveMock.mockReset();
    serverMock.prependListener.mockReset();
    serveMock.mockReturnValue(serverMock);
    createDaemonMock.mockReset();
    createDaemonMock.mockResolvedValue({
      app: { fetch: vi.fn() },
      contextMonitor: { start: vi.fn(), stop: vi.fn() },
      deps: {},
      injectWebSocket: vi.fn(),
    });
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
  });

  afterEach(() => {
    // startServer installs shutdown handlers; keep this mock-only fixture isolated.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListenersBefore[signal].includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
  });

  it("binds the daemon to loopback", async () => {
    const { startServer } = await import("../src/index.js");

    const server = await startServer(7441);

    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7441, hostname: "127.0.0.1" }),
      expect.any(Function)
    );
    expect(server).toBe(serverMock);
    expect(serverMock.prependListener).toHaveBeenCalledWith(
      "request", expect.any(Function),
    );
  });

  it("does not require a terminal bearer token for the default loopback bind", async () => {
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBearerToken: null }),
    );
  });

  it("uses the daemon bearer token for terminal routes on explicit public binds", async () => {
    process.env.OPENRIG_BIND_HOST = "0.0.0.0";
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "daemon-token";
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bearerToken: "daemon-token",
        terminalBearerToken: "daemon-token",
      }),
    );
  });
});
