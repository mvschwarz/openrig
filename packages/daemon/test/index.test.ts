import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { DAEMON_LISTEN_FAILED_EXIT_CODE } from "../src/daemon-shutdown.js";

const serveMock = vi.fn();
const createDaemonMock = vi.fn();
const createGuestActivityAppMock = vi.fn(() => ({ fetch: vi.fn() }));
const serverMock = Object.assign(new EventEmitter(), { prependListener: vi.fn() });
let signalListenersBefore: { SIGINT: Function[]; SIGTERM: Function[] };

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

vi.mock("../src/startup.js", () => ({
  createDaemon: createDaemonMock,
}));

vi.mock("../src/server.js", () => ({
  createGuestActivityApp: createGuestActivityAppMock,
}));

describe("daemon startServer", () => {
  beforeEach(() => {
    signalListenersBefore = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    serveMock.mockReset();
    serverMock.removeAllListeners();
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
    delete process.env.OPENRIG_GUEST_ACTIVITY_PORT;
    vi.restoreAllMocks();
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

  describe("a listener that fails to bind", () => {
    const bindFailure = (code: string, address: string) =>
      Object.assign(new Error(`listen ${code}: bind failed ${address}`), { code, syscall: "listen" });
    /** One emitter per serve() call, so a failure on one listener reaches only that listener's handlers. */
    const serversPerCall = (): EventEmitter[] => {
      const made: EventEmitter[] = [];
      serveMock.mockImplementation(() => {
        const server = Object.assign(new EventEmitter(), { prependListener: vi.fn() });
        made.push(server);
        return server;
      });
      return made;
    };
    const spies = () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const write = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);
      const lines = () => write.mock.calls.filter((call) => call[0] === 2).map((call) => String(call[1]));
      return { exit, lines };
    };

    it("logs one OPENRIG_LISTEN_FAILED line with the occupied-port guidance and exits with the listen-failure code on EADDRINUSE", async () => {
      process.env.OPENRIG_BIND_HOST = "127.0.0.1";
      const servers = serversPerCall();
      const { exit, lines } = spies();
      const { startServer } = await import("../src/index.js");
      await startServer(7441);
      expect(servers).toHaveLength(1);

      expect(() => servers[0]!.emit("error", bindFailure("EADDRINUSE", "127.0.0.1:7441"))).not.toThrow();

      expect(lines()).toEqual([
        "OPENRIG_LISTEN_FAILED EADDRINUSE 127.0.0.1:7441 Address already in use (EADDRINUSE) on port 7441. Inspect the listener before stopping it, or run 'rig daemon start --port <unused-port>'.\n",
      ]);
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(DAEMON_LISTEN_FAILED_EXIT_CODE);
    });

    it("names the errno and the bracketed address for another bind failure, without the --port hint", async () => {
      process.env.OPENRIG_BIND_HOST = "::1";
      const servers = serversPerCall();
      const { exit, lines } = spies();
      const { startServer } = await import("../src/index.js");
      await startServer(7441);

      servers[0]!.emit("error", bindFailure("EADDRNOTAVAIL", "::1:7441"));

      expect(lines()).toEqual(["OPENRIG_LISTEN_FAILED EADDRNOTAVAIL [::1]:7441 listen EADDRNOTAVAIL: bind failed ::1:7441\n"]);
      expect(exit).toHaveBeenCalledWith(DAEMON_LISTEN_FAILED_EXIT_CODE);
    });

    it("exits the same way when the guest activity listener fails, naming its host and port", async () => {
      process.env.OPENRIG_BIND_HOST = "127.0.0.1";
      process.env.OPENRIG_GUEST_ACTIVITY_PORT = "7442";
      const servers = serversPerCall();
      const { exit, lines } = spies();
      const { startServer } = await import("../src/index.js");
      await startServer(7441);
      expect(servers).toHaveLength(2);

      servers[0]!.emit("error", bindFailure("EADDRINUSE", "127.0.0.1:7442"));

      expect(lines()).toEqual(["OPENRIG_LISTEN_FAILED EADDRINUSE 127.0.0.1:7442 listen EADDRINUSE: bind failed 127.0.0.1:7442\n"]);
      expect(exit).toHaveBeenCalledWith(DAEMON_LISTEN_FAILED_EXIT_CODE);
    });

    it("leaves a server error after the listener is up on its usual path", async () => {
      process.env.OPENRIG_BIND_HOST = "127.0.0.1";
      const servers = serversPerCall();
      const { exit, lines } = spies();
      const { startServer } = await import("../src/index.js");
      await startServer(7441);

      servers[0]!.emit("listening");
      // With no 'error' listener left, the emitter throws it, as before this change, instead of reporting a bind failure.
      expect(() => servers[0]!.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }))).toThrow("accept EMFILE");
      expect(lines()).toEqual([]);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
