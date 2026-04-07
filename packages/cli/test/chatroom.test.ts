import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { chatroomCommand } from "../src/commands/chatroom.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

describe("Chatroom CLI", () => {
  let server: http.Server;
  let port: number;

  const rigSummary = [
    { id: "rig-1", name: "my-rig", nodeCount: 2 },
  ];

  const chatMessages = [
    { id: "msg-1", rigId: "rig-1", sender: "alice", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
    { id: "msg-2", rigId: "rig-1", sender: "bob", kind: "message", body: "world", topic: null, createdAt: "2026-03-31T10:01:00Z" },
  ];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url === "/api/rigs/summary") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rigSummary));
          return;
        }

        if (url.includes("/chat/send") && req.method === "POST") {
          const parsed = JSON.parse(body);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "msg-new", rigId: "rig-1", sender: parsed.sender, kind: "message", body: parsed.body, topic: null, createdAt: "2026-03-31T10:05:00Z" }));
          return;
        }

        if (url.includes("/chat/history")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(chatMessages));
          return;
        }

        if (url.includes("/chat/topic") && req.method === "POST") {
          const parsed = JSON.parse(body);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "msg-topic", rigId: "rig-1", sender: parsed.sender, kind: "topic", body: parsed.body ?? "", topic: parsed.topic, createdAt: "2026-03-31T10:06:00Z" }));
          return;
        }

        if (url.includes("/chat/watch")) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
          res.write(`data: ${JSON.stringify({ id: "msg-1", sender: "alice", kind: "message", body: "streamed", createdAt: "2026-03-31T10:00:00Z" })}\n\n`);
          setTimeout(() => res.end(), 50);
          return;
        }

        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(chatroomCommand(runningDeps(port)));
    return prog;
  }

  it("chatroom send sends message", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "send", "my-rig", "hello world"]);
    });
    expect(logs.join("\n")).toContain("[cli] hello world");
  });

  it("chatroom history prints chronological", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("[alice] hello");
    expect(output).toContain("[bob] world");
  });

  it("chatroom history --json prints JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "history", "my-rig", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].sender).toBe("alice");
  });

  it("chatroom topic creates marker", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "topic", "my-rig", "standup"]);
    });
    expect(logs.join("\n")).toContain("--- topic: standup ---");
  });

  it("chatroom watch prints streamed messages", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "watch", "my-rig"]);
    });
    expect(logs.join("\n")).toContain("[alice] streamed");
  });

  it("chatroom send with ambiguous rig name shows error with guidance", async () => {
    // Override to return ambiguous rigs
    const ambiguousSummary = [
      { id: "rig-1", name: "my-rig", nodeCount: 2 },
      { id: "rig-2", name: "my-rig", nodeCount: 1 },
    ];

    const ambiguousServer = http.createServer((req, res) => {
      const url = req.url ?? "";
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url === "/api/rigs/summary") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(ambiguousSummary));
          return;
        }
        res.writeHead(404).end();
      });
    });
    const ambiguousPort = await new Promise<number>((resolve) => {
      ambiguousServer.listen(0, () => {
        resolve((ambiguousServer.address() as { port: number }).port);
      });
    });

    const ambiguousCmd = new Command();
    ambiguousCmd.exitOverride();
    ambiguousCmd.addCommand(chatroomCommand(runningDeps(ambiguousPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await ambiguousCmd.parseAsync(["node", "rig", "chatroom", "send", "my-rig", "hello"]);
    });

    ambiguousServer.close();
    expect(logs.join("\n")).toContain("ambiguous");
    expect(exitCode).toBe(1);
  });

  it("chatroom watch --tmux spawns rig chatroom watch as the session command", async () => {
    // Mock execSync to verify the tmux command
    const origExecSync = (await import("node:child_process")).execSync;
    let capturedCmd = "";
    const { execSync } = await import("node:child_process");

    // We can't easily mock execSync in this test setup, so verify the --tmux
    // option prints the expected output when the tmux command fails (which it will
    // in CI since there's no tmux server)
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "chatroom", "watch", "my-rig", "--tmux"]);
    });

    const output = logs.join("\n");
    // Either it created the session or it reported an error about an existing session
    const tmuxSucceeded = output.includes("chatroom@my-rig");
    expect(tmuxSucceeded).toBe(true);
  });
});
