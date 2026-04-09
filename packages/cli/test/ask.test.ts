import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { askCommand } from "../src/commands/ask.js";
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
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-31T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

const EVIDENCE_RESULT = {
  question: "what about deployment?",
  rig: { name: "my-rig", status: "running", nodeCount: 2, runningCount: 2, uptime: "1h 30m" },
  evidence: { backend: "rg", excerpts: ["deployment started", "deployment finished"] },
  insufficient: false,
};

const INSUFFICIENT_RESULT = {
  question: "what is the",
  rig: { name: "my-rig", status: "running", nodeCount: 2, runningCount: 2, uptime: "1h 30m" },
  evidence: { backend: "rg", excerpts: [] },
  insufficient: true,
  guidance: "No useful keywords could be extracted from the question. Try a more specific question.",
};

const CHAT_ONLY_RESULT = {
  question: "what did chat say about deployment?",
  rig: { name: "my-rig", status: "running", nodeCount: 2, runningCount: 2, uptime: "1h 30m" },
  evidence: { backend: "rg", excerpts: [], chatExcerpts: ["[cli] deployment checkpoint shared in chat"] },
  insufficient: false,
};

const STRUCTURED_PEERS_RESULT = {
  question: "who are my peers?",
  rig: { name: "my-rig", status: "running", nodeCount: 2, runningCount: 2, uptime: "1h 30m" },
  evidence: {
    backend: "structured",
    excerpts: [
      "dev.qa  session=dev.qa@my-rig  runtime=codex  pod=dev",
      "rev1.r1  session=rev1.r1@my-rig  runtime=claude-code  pod=rev1",
    ],
  },
  insufficient: false,
};

describe("Ask CLI", () => {
  let server: http.Server;
  let port: number;
  let lastBody: Record<string, unknown> | null;

  beforeAll(async () => {
    lastBody = null;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        if (req.method !== "POST" || req.url !== "/api/ask") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        const parsed = JSON.parse(body);
        lastBody = parsed;
        if (parsed.rig === "my-rig" && parsed.question === "what did chat say about deployment?") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(CHAT_ONLY_RESULT));
        } else if (parsed.rig === "my-rig" && parsed.question === "who are my peers?") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(STRUCTURED_PEERS_RESULT));
        } else if (parsed.rig === "my-rig" && parsed.question.includes("deployment")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(EVIDENCE_RESULT));
        } else if (parsed.rig === "my-rig" && parsed.question === "what is the") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(INSUFFICIENT_RESULT));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            question: parsed.question,
            rig: null,
            evidence: { backend: "rg", excerpts: [] },
            insufficient: true,
            guidance: `Rig '${parsed.rig}' not found. List rigs with: rig ps`,
          }));
        }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(askCommand(runningDeps(port)));
    return prog;
  }

  it("human output shows question, rig status, and excerpts", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "what about deployment?"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("what about deployment?");
    expect(output).toContain("my-rig");
    expect(output).toContain("running");
    expect(output).toContain("deployment started");
    expect(output).toContain("deployment finished");
  });

  it("--json prints raw structured result", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "what about deployment?", "--json"]);
    });
    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.question).toBe("what about deployment?");
    expect(parsed.rig.name).toBe("my-rig");
    expect(parsed.evidence.excerpts).toContain("deployment started");
  });

  it("shows guidance when no data available", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "nonexistent-rig", "some question"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("not found");
    expect(output).toContain("rig ps");
  });

  it("shows insufficient message when keywords empty", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "what is the"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("No useful keywords");
  });

  it("human output shows chat evidence when transcript excerpts are empty", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "what did chat say about deployment?"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Chat Evidence");
    expect(output).toContain("deployment checkpoint shared in chat");
    expect(output).not.toContain("No transcript evidence found.");
  });

  it("passes node identity context and prints structured peer answers cleanly", async () => {
    const prevNodeId = process.env.OPENRIG_NODE_ID;
    const prevSessionName = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_NODE_ID = "node-123";
    process.env.OPENRIG_SESSION_NAME = "dev.impl@my-rig";
    try {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "who are my peers?"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("Structured Answer");
      expect(output).toContain("dev.qa");
      expect(output).toContain("rev1.r1");
      expect(lastBody?.nodeId).toBe("node-123");
      expect(lastBody?.sessionName).toBe("dev.impl@my-rig");
    } finally {
      if (prevNodeId === undefined) delete process.env.OPENRIG_NODE_ID;
      else process.env.OPENRIG_NODE_ID = prevNodeId;
      if (prevSessionName === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = prevSessionName;
    }
  });

  it("falls back to tmux-derived identity when OPENRIG env is absent", async () => {
    const deps = runningDeps(port) as StatusDeps & {
      identityResolver: () => { sessionName: string };
    };
    deps.identityResolver = () => ({ sessionName: "dev.impl@my-rig" });
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(askCommand(deps));

    const prevNodeId = process.env.OPENRIG_NODE_ID;
    const prevSessionName = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_NODE_ID;
    delete process.env.OPENRIG_SESSION_NAME;
    try {
      await captureLogs(async () => {
        await prog.parseAsync(["node", "rig", "ask", "my-rig", "who are my peers?"]);
      });
      expect(lastBody?.nodeId).toBeUndefined();
      expect(lastBody?.sessionName).toBe("dev.impl@my-rig");
    } finally {
      if (prevNodeId === undefined) delete process.env.OPENRIG_NODE_ID;
      else process.env.OPENRIG_NODE_ID = prevNodeId;
      if (prevSessionName === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = prevSessionName;
    }
  });
});
