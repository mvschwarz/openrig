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
        p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-31T00:00:00Z" } as DaemonState)
          : null,
      ),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[] }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    console.error = (...a: unknown[]) => logs.push(a.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    resolve({ logs });
  });
}

const SEAT_HITS = {
  question: "deployment?",
  rig: { name: "my-rig", status: "running", nodeCount: 2, runningCount: 2, uptime: "1h" },
  evidence: { backend: "read", excerpts: ["[gen 1] gen1 discussed deployment", "[gen 2] gen2 revisited deployment"] },
  seat: {
    name: "dev-planner@my-rig",
    generations: 2,
    hits: [
      { generation: 1, text: "gen1 discussed deployment" },
      { generation: 2, text: "gen2 revisited deployment" },
    ],
  },
  insufficient: false,
};

const SEAT_DEGRADED = {
  question: "deployment?",
  rig: { name: "my-rig", status: "running", nodeCount: 2, runningCount: 2, uptime: "1h" },
  evidence: { backend: "read", excerpts: [] },
  seat: {
    name: "dev-guard@my-rig",
    generations: 2,
    hits: [],
    degraded: { reason: "boundary_only", message: "Seat 'dev-guard@my-rig' transcript contains only session-boundary markers — degraded, not absent." },
  },
  insufficient: true,
  guidance: "Seat 'dev-guard@my-rig' transcript contains only session-boundary markers — degraded, not absent.",
};

describe("rig ask --seat (L1 CLI)", () => {
  let server: http.Server;
  let port: number;
  let lastBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (req.method !== "POST" || req.url !== "/api/ask") {
          res.writeHead(404); res.end("{}"); return;
        }
        const parsed = JSON.parse(body);
        lastBody = parsed;
        const payload = parsed.seat === "dev-guard@my-rig" ? SEAT_DEGRADED : SEAT_HITS;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
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

  it("sends the seat in the request body", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "deployment?", "--seat", "dev-planner@my-rig"]);
    });
    expect(lastBody?.seat).toBe("dev-planner@my-rig");
  });

  it("renders generation-labeled hits spanning tenures", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "deployment?", "--seat", "dev-planner@my-rig"]);
    });
    const out = logs.join("\n");
    expect(out).toContain("dev-planner@my-rig");
    expect(out).toMatch(/2 generation/i); // cross-generation is surfaced
    expect(out).toContain("[gen 1]");
    expect(out).toContain("[gen 2]");
  });

  it("renders the honest-degraded line, not a silent empty", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "deployment?", "--seat", "dev-guard@my-rig"]);
    });
    const out = logs.join("\n");
    expect(out).toMatch(/boundary/i);
    expect(out).not.toContain("No transcript evidence found.");
  });

  it("--json includes the structured seat evidence", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ask", "my-rig", "deployment?", "--seat", "dev-planner@my-rig", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.seat.name).toBe("dev-planner@my-rig");
    expect(parsed.seat.generations).toBe(2);
    expect(parsed.seat.hits).toHaveLength(2);
  });
});
