import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { broadcastCommand } from "../src/commands/broadcast.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}
function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" ")); console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, exitCode });
  });
}
function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

describe("Broadcast CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/transport/broadcast") {
          const parsed = JSON.parse(body);
          if (parsed.rig === "empty-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 0, sent: 0, failed: 0,
              results: [
                { ok: false, sessionName: "", error: "No running sessions found for rig 'empty-rig'. Check rig status with: rig ps" },
              ],
            }));
          } else
          if (parsed.rig === "fail-rig") {
            // Partial failure
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 1, failed: 1,
              results: [
                { ok: true, sessionName: "dev-impl@fail-rig" },
                { ok: false, sessionName: "dev-qa@fail-rig", error: "send failed" },
              ],
            }));
          } else {
            // Success (covers both rig-scoped and global)
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 2, failed: 0,
              results: [
                { ok: true, sessionName: "dev-impl@my-rig" },
                { ok: true, sessionName: "dev-qa@my-rig" },
              ],
            }));
          }
        } else { res.writeHead(404).end(); }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(runningDeps(port)));
    return prog;
  }

  it("broadcast --rig prints per-target summary", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig: sent");
    expect(output).toContain("dev-qa@my-rig: sent");
    expect(output).toContain("2/2 delivered");
  });

  it("broadcast without --rig/--pod sends globally", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "System maintenance"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("2/2 delivered");
  });

  // Slice-03 Atom 6b — --context delivery flag on broadcast.
  it("broadcast --context resolves a ref and fans out the whole content", async () => {
    const posts: Array<{ body: Record<string, unknown> }> = []; const gets: string[] = [];
    const client = {
      get: async (p: string) => { gets.push(p); return { status: 200, data: { ref: "packs/fleet", text: "FLEET-UPDATE", bytes: 12, missingFiles: [] } }; },
      post: async (_p: string, b: unknown) => { posts.push({ body: b as Record<string, unknown> }); return { status: 200, data: { results: [{ sessionName: "a@rig", ok: true }], sent: 1, total: 1, failed: 0 } }; },
    } as unknown as DaemonClient;
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand({ ...runningDeps(port), clientFactory: () => client }));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--context", "packs/fleet"]);
    });
    expect(exitCode).toBeUndefined();
    expect(gets.some((g) => g.includes("/api/context-packs/library/by-ref/pieces?ref=") && g.includes(encodeURIComponent("packs/fleet")))).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body["text"]).toBe("FLEET-UPDATE");
  });

  it("broadcast --context ABORTS (no fan-out) when the pack has a missing member", async () => {
    // The missing-member message (naming the member) is pinned in
    // context-resolve.test.ts; here we assert the broadcast-level contract:
    // exit non-zero and ZERO fan-out (no partial context ever leaves).
    const posts: unknown[] = [];
    const client = {
      get: async () => ({ status: 200, data: { ref: "packs/broken", text: "X", bytes: 1, missingFiles: [{ path: "gone.md" }] } }),
      post: async (_p: string, b: unknown) => { posts.push(b); return { status: 200, data: {} }; },
    } as unknown as DaemonClient;
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand({ ...runningDeps(port), clientFactory: () => client }));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--context", "packs/broken"]);
    });
    expect(exitCode).toBe(1);
    expect(posts).toEqual([]);
  });

  // P21 cross-host broadcast fix (203078d7's death condition): runCrossHostBroadcast REBUILDS the body
  // and used to drop the enveloped-fan-out marker, so the remote rendered RAW (no From:) while the local
  // path — same helper — wrapped. The fix ADDS body.envelopeSender via the single-origin helper. The
  // DaemonClient auto-stamps X-OpenRig-Session=origin env on the POST (client.ts:171), so the remote derives
  // the From: from the transport; the marker VALUE is ignored.
  function crossHostBcast(): { posts: Array<{ path: string; body: Record<string, unknown> }>; deps: Parameters<typeof broadcastCommand>[0] } {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = {
      get: async (p: string) => { posts.push({ path: p, body: {} }); return { status: 200, data: {} }; },
      post: async (p: string, b: unknown) => { posts.push({ path: p, body: (b ?? {}) as Record<string, unknown> }); return { status: 200, data: { results: [{ sessionName: "a@rig", ok: true }], sent: 1, total: 1, failed: 0 } }; },
    } as unknown as DaemonClient;
    const hostRegistryLoader = () => ({ ok: true as const, registry: { hosts: [{ id: "vm-a", transport: "http" as const, url: "http://vm-a:7433" }] } });
    return { posts, deps: { ...runningDeps(port), clientFactory: () => client, hostRegistryLoader } };
  }

  it("P21: cross-host broadcast CARRIES the enveloped marker (was dropped → remote rendered raw); value = the seat, but the daemon derives the From: from the auto-stamped X-OpenRig-Session", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "orch@rig-a";
    try {
      const { posts, deps } = crossHostBcast();
      const prog = new Command(); prog.exitOverride();
      prog.addCommand(broadcastCommand(deps));
      await captureLogs(async () => {
        await prog.parseAsync(["node", "rig", "broadcast", "--host", "vm-a", "--rig", "my-rig", "hi team"]);
      });
      const bcast = posts.find((p) => p.path.includes("/api/transport/broadcast"));
      expect(bcast).toBeDefined();
      expect(bcast!.body["envelopeSender"]).toBe("orch@rig-a"); // marker PRESENT (the fix) — value ignored daemon-side
      expect(bcast!.body["text"]).toBe("hi team");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"]; else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("P21: session-less cross-host broadcast still SETS the marker as the SINGLE-ORIGIN '<unknown sender>' (never duplicated across the host boundary); marker-present + no header ⇒ the daemon's existing I4 401 fires — refuse-loud inherited, not a silent raw send", async () => {
    const savedS = process.env["OPENRIG_SESSION_NAME"]; const savedR = process.env["RIGGED_SESSION_NAME"];
    delete process.env["OPENRIG_SESSION_NAME"]; delete process.env["RIGGED_SESSION_NAME"];
    try {
      const { posts, deps } = crossHostBcast();
      const prog = new Command(); prog.exitOverride();
      prog.addCommand(broadcastCommand(deps));
      await captureLogs(async () => {
        await prog.parseAsync(["node", "rig", "broadcast", "--host", "vm-a", "--rig", "my-rig", "hi team"]);
      });
      const bcast = posts.find((p) => p.path.includes("/api/transport/broadcast"));
      expect(bcast).toBeDefined();
      expect(bcast!.body["envelopeSender"]).toBe("<unknown sender>"); // marker present (enveloped) — daemon 401s (no header)
    } finally {
      if (savedS === undefined) delete process.env["OPENRIG_SESSION_NAME"]; else process.env["OPENRIG_SESSION_NAME"] = savedS;
      if (savedR === undefined) delete process.env["RIGGED_SESSION_NAME"]; else process.env["RIGGED_SESSION_NAME"] = savedR;
    }
  });

  it("broadcast --json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.total).toBe(2);
    expect(parsed.sent).toBe(2);
  });

  it("broadcast exits nonzero when no targets resolve", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "empty-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("No running sessions found");
    expect(output).toContain("0/0 delivered");
    expect(exitCode).toBe(1);
  });
});
