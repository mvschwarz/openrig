import { describe, it, expect, vi, beforeEach } from "vitest";

const serveMock = vi.fn();
const createDaemonMock = vi.fn();

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

vi.mock("../src/startup.js", () => ({
  createDaemon: createDaemonMock,
}));

describe("daemon startServer", () => {
  beforeEach(() => {
    serveMock.mockReset();
    createDaemonMock.mockReset();
    createDaemonMock.mockResolvedValue({ app: { fetch: vi.fn() } });
  });

  it("binds the daemon to loopback", async () => {
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7441, hostname: "127.0.0.1" }),
      expect.any(Function)
    );
  });
});
