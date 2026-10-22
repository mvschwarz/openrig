// `rig ps --rig <name>` with a name no rig has printed "No rigs" (and `--nodes` printed "No nodes") with
// exit 0, which reads as an empty fleet or a rig without seats. It now says the rig wasn't found and exits 1,
// as rig chatroom, rig env and rig parked do. --json keeps its empty array.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycleDeps(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-10-21T00:00:00Z" }) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

const PS_DATA = [
  { rigId: "rig-a", name: "delivery", rigName: "delivery", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "2h", latestSnapshot: null },
  { rigId: "rig-old", name: "old-rig", rigName: "old-rig", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null, isArchived: true },
];

const NODE = {
  rigId: "rig-a", rigName: "delivery", logicalId: "dev.impl", podId: "pod-1", canonicalSessionName: "dev-impl@delivery",
  nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  lifecycleState: "running", tmuxAttachCommand: null, resumeCommand: null, latestError: null, hasAssignedWork: false,
  assignedWorkCount: 0, pendingWorkCount: 0, inProgressWorkCount: 0, blockedWorkCount: 0,
};

describe("rig ps --rig with a name no rig has", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Like the daemon, /api/ps leaves archived rigs out unless includeArchived=true.
      if (req.url?.startsWith("/api/ps")) res.end(JSON.stringify(req.url.includes("includeArchived=true") ? PS_DATA : PS_DATA.filter((r) => !r.isArchived)));
      else if (req.url?.startsWith("/api/rigs/rig-a/nodes")) res.end(JSON.stringify([NODE]));
      else res.end(JSON.stringify([]));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  async function ps(...args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    const saved = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    process.exitCode = undefined;
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(psCommand({ lifecycleDeps: lifecycleDeps(port), clientFactory: (url) => new DaemonClient(url) } as StatusDeps));
      await program.parseAsync(["node", "rig", "ps", ...args]);
      return { out: lines.join("\n"), exitCode: process.exitCode };
    } finally {
      log.mockRestore();
      err.mockRestore();
      if (saved !== undefined) process.env.OPENRIG_SESSION_NAME = saved;
      process.exitCode = undefined;
    }
  }

  it("the rig view says the rig wasn't found instead of 'No rigs'", async () => {
    const { out, exitCode } = await ps("--rig", "delivry");
    expect(out).toBe("Rig 'delivry' not found. List rigs with: rig ps");
    expect(exitCode).toBe(1);
  });

  it("the node view says the rig wasn't found instead of 'No nodes'", async () => {
    const { out, exitCode } = await ps("--nodes", "--rig", "delivry");
    expect(out).toBe("Rig 'delivry' not found. List rigs with: rig ps");
    expect(exitCode).toBe(1);
  });

  it("an archived rig's name points at --include-archived", async () => {
    const { out, exitCode } = await ps("--rig", "old-rig");
    expect(out).toBe("Rig 'old-rig' is archived. Show it with: rig ps --rig old-rig --include-archived");
    expect(exitCode).toBe(1);
  });

  it("the node view also points an archived rig's name at --include-archived", async () => {
    const { out, exitCode } = await ps("--nodes", "--rig", "old-rig");
    expect(out).toBe("Rig 'old-rig' is archived. Show it with: rig ps --nodes --rig old-rig --include-archived");
    expect(exitCode).toBe(1);
  });

  it("--summary says the rig wasn't found instead of zero totals, in both views; --json --summary is unchanged", async () => {
    for (const args of [["--rig", "delivry", "--summary"], ["--nodes", "--rig", "delivry", "--summary"]]) {
      const { out, exitCode } = await ps(...args);
      expect(out).toBe("Rig 'delivry' not found. List rigs with: rig ps");
      expect(exitCode).toBe(1);
    }
    const json = await ps("--rig", "delivry", "--summary", "--json");
    expect(JSON.parse(json.out)).toMatchObject({ totalRigs: 0 });
    expect(json.exitCode).toBeUndefined();
  });

  it("--json keeps its empty array, and an existing rig lists as before", async () => {
    expect(await ps("--rig", "delivry", "--json")).toEqual({ out: "[]", exitCode: undefined });

    const rig = await ps("--rig", "delivery");
    expect(rig.out).toContain("delivery");
    expect(rig.exitCode).toBeUndefined();

    const nodes = await ps("--nodes", "--rig", "delivery");
    expect(nodes.out).toContain("dev-impl@delivery");
    expect(nodes.exitCode).toBeUndefined();
  });
});
