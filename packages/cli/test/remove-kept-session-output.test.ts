// #174: when removal keeps a session that belongs to another rig's live seat, the human output of
// `rig remove` and `rig shrink` says so (JSON already carries `sessionKeptFor`).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState } from "../src/daemon-lifecycle.js";
import { removeCommand } from "../src/commands/remove.js";
import { shrinkCommand } from "../src/commands/shrink.js";
import type { StatusDeps } from "../src/commands/status.js";

const RESPONSES: Record<string, unknown> = {
  "DELETE /api/rigs/rig-1/nodes/lead.planner": {
    ok: true, rigId: "rig-1", nodeId: "node-9", logicalId: "lead.planner",
    sessionsKilled: 0, sessionKeptFor: "lead.planner@live-rig", reroutedQitemIds: [],
  },
  "DELETE /api/rigs/rig-1/nodes/dev.impl": {
    ok: true, rigId: "rig-1", nodeId: "node-1", logicalId: "dev.impl", sessionsKilled: 1, reroutedQitemIds: [],
  },
  "DELETE /api/rigs/rig-1/pods/kept": {
    ok: true, status: "ok", rigId: "rig-1", podId: "pod-9", namespace: "kept",
    removedLogicalIds: ["kept.lead"], sessionsKilled: 0, reroutedQitemIds: [],
    nodes: [{ logicalId: "kept.lead", nodeId: "node-9", status: "removed", sessionsKilled: 0, sessionKeptFor: "kept.lead@live-rig" }],
  },
};

describe("#174 remove/shrink human output names a kept session", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = RESPONSES[`${req.method} ${req.url}`];
      res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body ?? { error: "not found" }));
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });

  function deps(): StatusDeps {
    return {
      lifecycleDeps: {
        spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
        fetch: vi.fn(async () => ({ ok: true })),
        kill: vi.fn(() => true),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-09-30T00:00:00Z" } as DaemonState)
          : null),
        writeFile: vi.fn(),
        removeFile: vi.fn(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        mkdirp: vi.fn(),
        openForAppend: vi.fn(() => 3),
        isProcessAlive: vi.fn(() => true),
      },
      clientFactory: () => new DaemonClient(`http://127.0.0.1:${port}`),
    };
  }

  async function run(command: Command, args: string[]): Promise<{ output: string; exitCode: number | undefined }> {
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    process.exitCode = undefined;
    const program = new Command();
    program.exitOverride();
    program.addCommand(command);
    try {
      await program.parseAsync(["node", "rig", ...args]);
      return { output: logs.join("\n"), exitCode: process.exitCode };
    } finally {
      log.mockRestore();
      err.mockRestore();
      process.exitCode = undefined;
    }
  }

  it("remove says the session was kept and for whom", async () => {
    const { output, exitCode } = await run(removeCommand(deps()), ["remove", "rig-1", "lead.planner"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Removed node lead.planner from rig rig-1 (0 session killed)");
    expect(output).toContain("Session kept: owned by lead.planner@live-rig");
  });

  it("control: remove prints no kept line when it killed its own session", async () => {
    const { output } = await run(removeCommand(deps()), ["remove", "rig-1", "dev.impl"]);
    expect(output).toContain("Removed node dev.impl from rig rig-1 (1 session killed)");
    expect(output).not.toContain("Session kept");
  });

  it("shrink names each node whose session was kept", async () => {
    const { output, exitCode } = await run(shrinkCommand(deps()), ["shrink", "rig-1", "kept"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("kept.lead: session kept, owned by kept.lead@live-rig");
  });
});
