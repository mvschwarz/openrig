// #3636 item 2: `rig ps` printed its archived count by fetching every rig, archived included, and dropping the archived
// ones client-side. The daemon now sends the count beside the default (active-only) list as X-OpenRig-Archived-Count, so
// the plain view doesn't make the daemon fold every archived rig. A daemon without the header gets the earlier fetch.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const ACTIVE = { rigId: "rig-a", name: "delivery", rigName: "delivery", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "2h", latestSnapshot: null };
const ARCHIVED = { rigId: "rig-old", name: "old-rig", rigName: "old-rig", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null, isArchived: true };

describe("rig ps reads its archived count from the daemon's header (#3636)", () => {
  let server: http.Server;
  let port: number;
  let requests: string[];
  let sendHeader: boolean;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      const url = req.url ?? "";
      if (url === "/api/ps") {
        // The count deliberately differs from the archived list, so a line that shows it came from the header.
        res.writeHead(200, { "Content-Type": "application/json", ...(sendHeader ? { "X-OpenRig-Archived-Count": "3" } : {}) });
        res.end(JSON.stringify([ACTIVE]));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url === "/api/ps?archived=only") res.end(JSON.stringify([ARCHIVED]));
      else if (url === "/api/ps?includeArchived=true") res.end(JSON.stringify([ACTIVE, ARCHIVED]));
      else res.end(JSON.stringify([]));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());
  beforeEach(() => { requests = []; sendHeader = true; });

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

  it("prints the header's archived count without asking for the archived rigs", async () => {
    const { out } = await ps();
    expect(out).toContain("3 archived (rig ps --include-archived)");
    expect(out).toContain("delivery");
    expect(requests.filter((url) => url.startsWith("/api/ps"))).toEqual(["/api/ps"]);
  });

  it("looks at the archived rigs only when a --rig names none of the active ones", async () => {
    const archived = await ps("--rig", "old-rig");
    expect(archived.out).toBe("Rig 'old-rig' is archived. Show it with: rig ps --rig old-rig --include-archived");
    expect(archived.exitCode).toBe(1);
    expect(requests.filter((url) => url.startsWith("/api/ps"))).toEqual(["/api/ps", "/api/ps?archived=only"]);

    requests = [];
    const missing = await ps("--rig", "nope");
    expect(missing.out).toBe("Rig 'nope' not found. List rigs with: rig ps");
    expect(missing.exitCode).toBe(1);
  });

  it("keeps the earlier single fetch, archived included, for a daemon that sends no count", async () => {
    sendHeader = false;
    const { out } = await ps();
    expect(out).toContain("1 archived (rig ps --include-archived)");
    expect(requests.filter((url) => url.startsWith("/api/ps"))).toEqual(["/api/ps", "/api/ps?includeArchived=true"]);
  });

  it("--include-archived still asks for every rig once", async () => {
    const { out } = await ps("--include-archived");
    expect(out).toContain("old-rig");
    expect(requests.filter((url) => url.startsWith("/api/ps"))).toEqual(["/api/ps?includeArchived=true"]);
  });
});
</content>
</invoke>
