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
function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) =>
        p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-03-31T00:00:00Z" } as DaemonState) : null,
      ),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: (u) => new DaemonClient(u),
  };
}
function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[] }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const ol = console.log, oe = console.error;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    console.error = (...a: unknown[]) => logs.push(a.join(" "));
    try { await fn(); } finally { console.log = ol; console.error = oe; }
    resolve({ logs });
  });
}

const FOUND = {
  question: "SECRET_MARKER",
  rig: { name: "my-rig", status: "running", nodeCount: 1, runningCount: 1, uptime: "1h" },
  evidence: { backend: "rg", excerpts: ['{"text":"the SECRET_MARKER lives here"}'] },
  session: { token: "abc-123", found: true, path: "/h/.claude/projects/-p/abc-123.jsonl", excerpts: ['{"text":"the SECRET_MARKER lives here"}'] },
  insufficient: false,
};
const NOT_FOUND = {
  question: "x",
  rig: { name: "my-rig", status: "running", nodeCount: 1, runningCount: 1, uptime: "1h" },
  evidence: { backend: "none", excerpts: [] },
  session: { token: "bogus", found: false, excerpts: [], degraded: { reason: "session_not_found", message: "No session JSONL found for token 'bogus'. Check the token." } },
  insufficient: true,
  guidance: "No session JSONL found for token 'bogus'. Check the token.",
};

describe("rig ask --session (L2 CLI)", () => {
  let server: http.Server;
  let port: number;
  let lastBody: Record<string, unknown> | null = null;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c: Buffer) => { b += c.toString(); });
      req.on("end", () => {
        const parsed = JSON.parse(b);
        lastBody = parsed;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(parsed.session === "bogus" ? NOT_FOUND : FOUND));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());
  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(askCommand(runningDeps(port)));
    return prog;
  }

  it("sends the session token in the request body", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "SECRET_MARKER", "--session", "abc-123"]);
    });
    expect(lastBody?.session).toBe("abc-123");
  });

  it("renders the Session line and content excerpt", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "SECRET_MARKER", "--session", "abc-123"]);
    });
    const out = logs.join("\n");
    expect(out).toContain("Session: abc-123");
    expect(out).toContain("SECRET_MARKER");
  });

  it("renders session_not_found guidance, not a silent empty", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "x", "--session", "bogus"]);
    });
    const out = logs.join("\n");
    expect(out).toMatch(/token/i);
    expect(out).toContain("[not found]");
  });
});
