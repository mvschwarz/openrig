import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { hostsRoutes } from "../src/routes/hosts.js";

const { execFileMock, connectMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, connect: connectMock };
});

type SocketEvent = "connect" | "timeout" | "error";
interface SocketTrace {
  events: string[];
  writes: number;
  ends: number;
  destroys: number;
}
interface ProbeTrace {
  execFileCalls: Array<{ command: string; args: string[]; timeout: number | undefined }>;
  connects: Array<{ host: string | undefined; port: number | undefined; timeout: number | undefined }>;
  sockets: SocketTrace[];
}

class FakeSocket extends EventEmitter {
  constructor(private readonly trace: SocketTrace) {
    super();
  }

  destroy(): this {
    this.trace.events.push("destroy");
    this.trace.destroys += 1;
    return this;
  }

  write(..._args: unknown[]): boolean {
    this.trace.writes += 1;
    return true;
  }

  end(..._args: unknown[]): this {
    this.trace.ends += 1;
    return this;
  }
}

let home: string;
let savedHome: string | undefined;
let trace: ProbeTrace;
let socketEvent: SocketEvent;

function app(): Hono {
  const result = new Hono();
  result.route("/api/hosts", hostsRoutes());
  return result;
}

function writeRegistry(hosts: unknown[]): void {
  writeFileSync(join(home, "hosts.yaml"), JSON.stringify({ hosts }));
}

function singleStatus(body: { hosts: Array<{ status: string }> }): string | undefined {
  return body.hosts[0]?.status;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ssh-list-inert-"));
  savedHome = process.env["OPENRIG_HOME"];
  process.env["OPENRIG_HOME"] = home;
  trace = { execFileCalls: [], connects: [], sockets: [] };
  socketEvent = "connect";

  execFileMock.mockReset();
  execFileMock.mockImplementation((
    command: string,
    args: string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    trace.execFileCalls.push({ command, args: [...args], timeout: options.timeout });
    queueMicrotask(() => callback(null, ""));
  });

  connectMock.mockReset();
  connectMock.mockImplementation((options: { host?: string; port?: number; timeout?: number }) => {
    trace.connects.push({ host: options.host, port: options.port, timeout: options.timeout });
    const lifecycle: SocketTrace = { events: [], writes: 0, ends: 0, destroys: 0 };
    trace.sockets.push(lifecycle);
    const socket = new FakeSocket(lifecycle);
    queueMicrotask(() => {
      lifecycle.events.push(socketEvent);
      socket.emit(socketEvent, ...(socketEvent === "error" ? [new Error("inert socket error")] : []));
    });
    return socket;
  });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
  else process.env["OPENRIG_HOME"] = savedHome;
});

describe("GET /api/hosts status probes at inert external boundaries", () => {
  it("reports SSH entries unknown without invoking a process or opening a TCP socket", async () => {
    writeRegistry([
      { id: "devbox", transport: "ssh", target: "devbox", user: "ops" },
      { id: "another", transport: "ssh", target: "host.example" },
    ]);

    const response = await app().request("/api/hosts");
    const body = await response.json() as { hosts: Array<{ status: string }> };
    const observed = {
      httpStatus: response.status,
      statuses: body.hosts.map((host) => host.status),
      execFileCalls: trace.execFileCalls,
      connects: trace.connects,
      sockets: trace.sockets,
    };

    expect(observed).toEqual({
      httpStatus: 200,
      statuses: ["unknown", "unknown"],
      execFileCalls: [],
      connects: [],
      sockets: [],
    });
  });

  it.each([
    { label: "HTTP default port", url: "http://example.test", host: "example.test", port: 80 },
    { label: "HTTP explicit port", url: "http://example.test:7433", host: "example.test", port: 7433 },
    { label: "HTTPS default port", url: "https://example.test", host: "example.test", port: 443 },
    { label: "bracketed IPv6 HTTPS", url: "https://[2001:db8::7]:9443", host: "2001:db8::7", port: 9443 },
  ])("preserves $label TCP status behavior using only the fake socket", async ({ url, host, port }) => {
    writeRegistry([{ id: "web", transport: "http", url }]);

    const response = await app().request("/api/hosts");
    const body = await response.json() as { hosts: Array<{ status: string }> };

    expect({
      httpStatus: response.status,
      status: singleStatus(body),
      execFileCalls: trace.execFileCalls,
      connects: trace.connects,
      sockets: trace.sockets,
    }).toEqual({
      httpStatus: 200,
      status: "reachable",
      execFileCalls: [],
      connects: [{ host, port, timeout: 1500 }],
      sockets: [{ events: ["connect", "destroy"], writes: 0, ends: 0, destroys: 1 }],
    });
  });

  it.each(["timeout", "error"] as const)("keeps HTTP %s results unreachable and destroys the fake socket", async (event) => {
    socketEvent = event;
    writeRegistry([{ id: "web", transport: "http", url: "http://example.test:7433" }]);

    const response = await app().request("/api/hosts");
    const body = await response.json() as { hosts: Array<{ status: string }> };

    expect({ status: singleStatus(body), sockets: trace.sockets }).toEqual({
      status: "unreachable",
      sockets: [{ events: [event, "destroy"], writes: 0, ends: 0, destroys: 1 }],
    });
  });
});
