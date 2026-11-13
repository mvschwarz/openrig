// Connected assistants (roster members outside any terminal) aren't nodes, so `rig ps` lists them in their own short
// section with their check-in status, from the daemon's hosted-members read. `--json` output keeps its shape.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycle(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-11-12T00:00:00Z" } as DaemonState) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

const NODE = { rigId: "rig-h", rigName: "hub", logicalId: "lead", canonicalSessionName: "lead@hub", hostSelfId: "host-a", nodeKind: "agent",
  runtime: "claude-code", sessionStatus: "running", lifecycleState: "running", startupStatus: "ready", needsAttention: false };
const PS = [{ rigId: "rig-h", name: "hub", rigName: "hub", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null }];
const MEMBERS = [
  { seat: "chat@hub", rung: false, status: "check-in-overdue", lastCheckInAt: "2026-11-12T01:00:00.000Z", expectedMinutes: 60, onRequest: false, reporter: "openrig-observed" },
  { seat: "new@hub", rung: false, status: "no-check-in-yet", lastCheckInAt: null, expectedMinutes: null, onRequest: false, reporter: "openrig-observed" },
  { seat: "other@elsewhere", rung: false, status: "on-request", lastCheckInAt: "2026-11-12T02:00:00.000Z", expectedMinutes: null, onRequest: true, reporter: "openrig-observed" },
];

describe("rig ps: connected assistants and their check-in status", () => {
  let server: http.Server;
  let port: number;
  let members: unknown = { hostId: "host-a", members: MEMBERS };
  // How the hosted-members route answers: 200 with `members`, an older daemon's 404, a failure, or a dropped connection.
  let membersStatus = 200;
  let rigs: unknown[] = PS;
  let nodes: unknown[] = [NODE];
  let savedSession: string | undefined;

  beforeAll(async () => {
    savedSession = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      const reply = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (/^\/api\/rigs\/[^/]+\/nodes/.test(url)) return reply(200, nodes);
      if (url.startsWith("/api/ps")) return reply(200, rigs);
      if (url === "/api/queue/hosted-members") {
        if (membersStatus === 0) return req.socket.destroy();
        return reply(membersStatus, membersStatus === 200 ? members : { error: "unavailable" });
      }
      return reply(404, { error: "not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
    if (savedSession !== undefined) process.env.OPENRIG_SESSION_NAME = savedSession;
  });
  beforeEach(() => {
    members = { hostId: "host-a", members: MEMBERS };
    membersStatus = 200;
    rigs = PS;
    nodes = [NODE];
    process.exitCode = undefined;
  });

  async function run(args: string[]): Promise<string[]> {
    const deps: StatusDeps = { lifecycleDeps: lifecycle(port), clientFactory: (url) => new DaemonClient(url) };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(deps));
    const logs: string[] = [];
    const orig = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.error = () => {};
    try { await prog.parseAsync(["node", "rig", "ps", ...args]); } catch { /* exitOverride */ } finally { console.log = orig; console.error = origErr; }
    return logs;
  }

  it("the rigs view lists every connected assistant with its check-in line", async () => {
    const out = (await run([])).join("\n");
    expect(out).toContain("Connected assistants (outside the terminal; each checks its own queue):");
    expect(out).toContain("  chat@hub  overdue: last check-in 2026-11-12T01:00:00.000Z, expected every 60 min; its schedule may be off or waiting for an approval");
    expect(out).toContain("  new@hub  no check-in yet; no check-in cadence declared");
    expect(out).toContain("  other@elsewhere  on request: it checks its queue when a person asks it; last check-in 2026-11-12T02:00:00.000Z");
  });

  it("the nodes view of one rig lists only that rig's assistants", async () => {
    const out = (await run(["--nodes", "--rig", "hub"])).join("\n");
    expect(out).toContain("  chat@hub  overdue");
    expect(out).toContain("  new@hub  no check-in yet");
    expect(out).not.toContain("other@elsewhere");
  });

  it("--json keeps its shape: no section, no extra key", async () => {
    const logs = await run(["--json"]);
    expect(logs.join("\n")).not.toContain("Connected assistants");
    expect(Array.isArray(JSON.parse(logs[0]!))).toBe(true);
  });

  it("a host with no terminal rigs still lists its connected assistants", async () => {
    rigs = [];
    const out = (await run([])).join("\n");
    expect(out).toContain("No rigs");
    expect(out).toContain("Connected assistants (outside the terminal; each checks its own queue):");
    expect(out).toContain("  chat@hub  overdue");
    expect(out).toContain("  other@elsewhere  on request");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a rig with no terminal seats still lists its connected assistants", async () => {
    rigs = [{ ...PS[0], nodeCount: 0, runningCount: 0 }];
    nodes = [];
    const out = (await run(["--nodes", "--rig", "hub"])).join("\n");
    expect(out).toContain("No nodes");
    expect(out).toContain("  chat@hub  overdue");
    expect(out).toContain("  new@hub  no check-in yet");
    expect(out).not.toContain("other@elsewhere");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a missing rig keeps its not-found answer, with no section", async () => {
    const out = (await run(["--rig", "nowhere"])).join("\n");
    expect(out).not.toContain("Connected assistants");
    expect(process.exitCode).toBe(1);
  });

  it("a known-empty list stays quiet, in a full view and an empty one", async () => {
    members = { hostId: "host-a", members: [] };
    expect((await run([])).join("\n")).not.toContain("Connected assistants");
    rigs = [];
    expect((await run([])).join("\n")).not.toContain("Connected assistants");
    members = { hostId: "host-a", members: MEMBERS };
    rigs = PS;
    // Members only on other rigs: this rig's list is known to be empty.
    expect((await run(["--nodes", "--rig", "elsewhere-only"])).join("\n")).not.toContain("Connected assistants");
  });

  it.each([
    ["an older daemon without the route", () => { membersStatus = 404; }, "this daemon doesn't serve it"],
    ["a failed read", () => { membersStatus = 500; }, "the read failed: HTTP 500"],
    ["an answer without a members list", () => { members = { hostId: "host-a" }; }, "the daemon's answer couldn't be read"],
    ["a dropped connection", () => { membersStatus = 0; }, "the read failed: "],
  ])("%s says check-in is unavailable, not that there are none", async (_case, arrange, reason) => {
    arrange();
    for (const args of [[], ["--nodes", "--rig", "hub"]]) {
      const out = (await run(args)).join("\n");
      expect(out).toContain(`Connected assistants: check-in unavailable (${reason}`);
      expect(out).not.toContain("each checks its own queue");
      // The main table and the exit status are as they were.
      expect(out).toContain(args.length ? "lead@hub" : "hub");
      expect(process.exitCode ?? 0).toBe(0);
    }
    rigs = [];
    expect((await run([])).join("\n")).toContain(`No rigs · daemon http://127.0.0.1:${port}\n\nConnected assistants: check-in unavailable`);
  });
});
