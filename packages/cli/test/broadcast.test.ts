import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { allowFetchTarget } from "./fetch-guard.js";
import { broadcastCommand } from "../src/commands/broadcast.js";
import { DaemonClient, DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}
function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; stdout: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const stdout: string[] = []; const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); stdout.push(args.join(" ")); }; console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, stdout, exitCode });
  });
}
function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

describe("Broadcast CLI", () => {
  it("documents that an unscoped pod name matches across rigs", () => {
    const podOption = broadcastCommand().options.find((option) => option.long === "--pod");
    expect(podOption?.description).toContain("across all rigs");
    expect(podOption?.description).toContain("unless --rig is set");
  });

  let server: http.Server;
  let port: number;
  let broadcastPosts = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/transport/broadcast") {
          broadcastPosts += 1;
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
          } else if (parsed.rig === "notice-rig") {
            // A managed-compaction notice on a sent and on a failed recipient; none on the third.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 3, sent: 2, failed: 1,
              results: [
                { ok: true, sessionName: "a@notice-rig", managedCompaction: { stage: "restoring", observed: "before_send", notice: "a@notice-rig was mid-restore: the restore request was sent and the post-restore audit is still owed." } },
                { ok: true, sessionName: "b@notice-rig" },
                { ok: false, sessionName: "c@notice-rig", error: "send failed", managedCompaction: { stage: "compacting", observed: "before_send", notice: "c@notice-rig was being compacted: /compact was submitted." } },
              ],
            }));
          } else if (parsed.rig === "held-only-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 1, retained: 1, failed: 0,
              results: [
                { ok: true, sessionName: "a@held-only-rig", outcome: "delivered" },
                { ok: true, sessionName: "b@held-only-rig", outcome: "retained", sent: false },
              ],
            }));
          } else if (parsed.rig === "held-rig") {
            // The daemon's shape for a held recipient: ok, outcome "retained", nothing written; sent excludes it.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 3, sent: 1, retained: 1, failed: 1,
              results: [
                { ok: true, sessionName: "a@held-rig", outcome: "delivered" },
                { ok: true, sessionName: "b@held-rig", outcome: "retained", sent: false },
                { ok: false, sessionName: "c@held-rig", sent: false, inputPhase: "not_reached", error: "send failed" },
              ],
            }));
          } else if (parsed.rig === "phase-rig") {
            // #2507: a recipient whose input was attempted or written is recorded indeterminate, not failed.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 5, sent: 1, failed: 4,
              results: [
                { ok: true, sessionName: "a@phase-rig", inputPhase: "written", sent: true },
                { ok: false, sessionName: "b@phase-rig", inputPhase: "not_reached", sent: false, error: "target_needs_input" },
                { ok: false, sessionName: "c@phase-rig", inputPhase: "attempted", sent: false, error: "paste lost" },
                { ok: false, sessionName: "d@phase-rig", inputPhase: "written", sent: false, error: "enter unconfirmed" },
                { ok: false, sessionName: "e@phase-rig", sent: true, error: "receipt lost" },
              ],
            }));
          } else if (parsed.rig === "big-rig") {
            // The daemon answers after its sequential fan-out: 91 seats at 60 ms each is past the 5 s read default.
            const results = Array.from({ length: 91 }, (_, i) => ({ ok: true, sessionName: `s${i}@big-rig` }));
            setTimeout(() => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ total: 91, sent: 91, failed: 0, results }));
            }, 91 * 60);
          } else if (parsed.rig === "warn-rig") {
            // S2 (OPR.0.5.4.3): an unattributed broadcast's response carries the
            // sign-it notice as an additive warning; the renderer must surface it.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 2, failed: 0,
              warning: "Delivered without sender identity: your recipients have no way of knowing who sent this. Follow up and sign it.",
              results: [
                { ok: true, sessionName: "dev-impl@warn-rig" },
                { ok: true, sessionName: "dev-qa@warn-rig" },
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

  // P18: establish a RESOLVED seat for every test so the marker renders as the real sender
  // ("broadcaster@my-rig"); the deliver-and-label test below overrides it to empty to exercise the
  // `<unknown sender>` fall-open. (Hermetic-gate default is env-UNSET, so without this every broadcast
  // would render the unknown marker.) Restored by afterEach so no stub leaks across tests.
  beforeEach(() => {
    broadcastPosts = 0;
    vi.stubEnv("OPENRIG_SESSION_NAME", "broadcaster@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    // Broadcast-leak containment: EXPLICITLY bind every broadcast in this file to the
    // in-process fixture daemon, so an unscoped broadcast cannot reach the live
    // topology via any code path (ambient env or STATE_FILE fallback) — belt-and-
    // braces on top of the setup-level fixture-home guard. An unscoped broadcast in a
    // test is a bug independent of routing; this makes the fixture the only reachable target.
    vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("OPENRIG_PORT", String(port));
    // P37: register this in-process fixture with the request-layer guard so its real
    // requests are PERMITTED (the guard fails closed on unregistered targets).
    allowFetchTarget(`http://127.0.0.1:${port}`);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  function makeCmd(deps: StatusDeps = runningDeps(port)): Command {
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(deps));
    return prog;
  }

  // S2 (OPR.0.5.4.3): the broadcast renderer must SURFACE an additive warning.
  it.each([false, true])("renders native pending and unknown custody without claiming it was sent or model work completed (json=%s)", async json => {
    const client = { post: async () => ({ status: 200, data: { total: 2, sent: 0, failed: 0, pendingNative: 1, indeterminateNative: 1,
      results: [{ ok: true, sessionName: "a@r", runnerReceipt: { version: 1, requestId: "pending", stage: "accepted" } },
        { ok: true, sessionName: "b@r", runnerReceipt: { version: 1, requestId: "unknown", stage: "completed", result: { submissionUnknown: true } } }] } }) } as unknown as DaemonClient;
    const result = await captureLogs(() => makeCmd({ ...runningDeps(port), clientFactory: () => client }).parseAsync(["node", "rig", "broadcast", "message", ...(json ? ["--json"] : [])]));
    if (json) expect(JSON.parse(result.logs[0]!)).toMatchObject({ sent: 0, pendingNative: 1, indeterminateNative: 1 });
    else {
      expect(result.logs.join("\n")).not.toContain(": sent");
      expect(result.logs.join("\n")).toContain("native receipt accepted");
      expect(result.logs.join("\n")).toContain("native effect unknown");
      expect(result.logs.join("\n")).toContain("1 native pending");
    }
    expect(result.exitCode).toBe(1);
  });
  it("broadcast renderer surfaces the unknown-sender notice from the response warning", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "warn-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@warn-rig: sent");
    expect(output).toContain("Advisory:");
    expect(output).toMatch(/no way of knowing who sent/i);
    expect(output).toMatch(/sign/i);
  });

  it("broadcast prints each recipient's compaction notice under that recipient's line, exit code unchanged", async () => {
    const { stdout, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "notice-rig", "hello"]);
    });
    expect(stdout).toEqual([
      "a@notice-rig: sent",
      "Notice: a@notice-rig was mid-restore: the restore request was sent and the post-restore audit is still owed.",
      "b@notice-rig: sent",
      "c@notice-rig: FAILED — send failed",
      "Notice: c@notice-rig was being compacted: /compact was submitted.",
      "2/3 delivered",
    ]);
    expect(exitCode).toBe(1);
  });

  it("broadcast prints UNCONFIRMED, not FAILED, for a recipient whose input was attempted or written; exit code unchanged", async () => {
    const { stdout, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "phase-rig", "hello"]);
    });
    const check = "the text may have reached it, so check with rig capture before resending";
    expect(stdout).toEqual([
      "a@phase-rig: sent",
      "b@phase-rig: FAILED — target_needs_input",
      `c@phase-rig: UNCONFIRMED — paste lost; ${check}`,
      `d@phase-rig: UNCONFIRMED — enter unconfirmed; ${check}`,
      `e@phase-rig: UNCONFIRMED — receipt lost; ${check}`,
      "1/5 delivered",
    ]);
    expect(exitCode).toBe(1);
  });

  it("broadcast prints a held recipient as retained, not sent, and counts it as held", async () => {
    const { stdout, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "held-rig", "hello"]);
    });
    expect(stdout).toEqual([
      "a@held-rig: sent",
      "b@held-rig: retained, not delivered; inspect with rig seat held-messages",
      "c@held-rig: FAILED — send failed",
      "1/3 delivered, 1 held",
    ]);
    // The failed recipient sets the exit code; a held one alone doesn't, as with rig send.
    expect(exitCode).toBe(1);
    const heldOnly = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "held-only-rig", "hello"]);
    });
    expect(heldOnly.stdout.at(-1)).toBe("1/2 delivered, 1 held");
    expect(heldOnly.exitCode ?? 0).toBe(0);
  });

  it("broadcast --rig prints per-target summary", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig: sent");
    expect(output).toContain("dev-qa@my-rig: sent");
    expect(output).toContain("2/2 delivered");
  });

  it.each(["", " \t\n"])("broadcast refuses empty or whitespace-only content before transport", async (message) => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", message]);
    });
    const output = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(broadcastPosts).toBe(0);
    expect(output).toMatch(/empty or whitespace-only/i);
    expect(output).toMatch(/backtick|\$\(\)/i);
    expect(output).toMatch(/--body-file|stdin/i);
  });

  it("broadcast refuses an empty resolved context before fan-out transport", async () => {
    const posts: unknown[] = [];
    const client = {
      get: async () => ({ status: 200, data: { ref: "packs/empty", text: " \n", bytes: 2, missingFiles: [] } }),
      post: async (_path: string, body: unknown) => { posts.push(body); return { status: 200, data: {} }; },
    } as unknown as DaemonClient;
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand({ ...runningDeps(port), clientFactory: () => client }));
    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--context", "packs/empty"]);
    });
    expect(exitCode).toBe(1);
    expect(posts).toEqual([]);
    expect(logs.join("\n")).toMatch(/empty or whitespace-only/i);
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
  function crossHostBcast(data: Record<string, unknown> = { results: [{ sessionName: "a@rig", ok: true }], sent: 1, total: 1, failed: 0 }): { posts: Array<{ path: string; body: Record<string, unknown> }>; deps: Parameters<typeof broadcastCommand>[0] } {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = {
      get: async (p: string) => { posts.push({ path: p, body: {} }); return { status: 200, data: {} }; },
      post: async (p: string, b: unknown) => { posts.push({ path: p, body: (b ?? {}) as Record<string, unknown> }); return { status: 200, data }; },
    } as unknown as DaemonClient;
    const hostRegistryLoader = () => ({ ok: true as const, registry: { hosts: [{ id: "vm-a", transport: "http" as const, url: "http://vm-a:7433" }] } });
    return { posts, deps: { ...runningDeps(port), clientFactory: () => client, hostRegistryLoader } };
  }

  it("P21: cross-host broadcast CARRIES the enveloped marker (was dropped → remote rendered raw); value = the seat, but the daemon derives the From: from the auto-stamped X-OpenRig-Session", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "orch@rig-a");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
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
  });

  // P18 DELIVER-AND-LABEL (deletion atom; REVERSES A1, supersedes the P21 session-less pin): an env-less
  // cross-host broadcast now DELIVERS carrying the honest `<unknown sender>` marker rather than refusing.
  // The marker's PRESENCE (not its value) is the anti-storm signal, so a session-less broadcast still
  // WRAPS each recipient (no session-less storm); the daemon half delivers-and-labels the header-absent
  // write (no downstream 401). Load-bearing: a dispatch DID happen and the marker on the wire is the
  // honest fallback — never a forged sender.
  it("P18: an env-less cross-host broadcast DELIVERS with the honest `<unknown sender>` marker on the wire", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { posts, deps } = crossHostBcast();
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(deps));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--host", "vm-a", "--rig", "my-rig", "hi team"]);
    });
    expect(exitCode).toBeFalsy(); // DELIVERED, not refused
    const bcast = posts.find((p) => p.path.includes("/api/transport/broadcast"));
    expect(bcast).toBeDefined(); // dispatch reached the wire
    expect(bcast!.body["envelopeSender"]).toBe("<unknown sender>"); // honest marker present (anti-storm), never forged
  });

  it("a cross-host broadcast prints each recipient's compaction notice under that recipient's line", async () => {
    const { deps } = crossHostBcast({
      total: 2, sent: 2, failed: 0,
      results: [
        { ok: true, sessionName: "a@rig", managedCompaction: { stage: "compacted", observed: "after_send", notice: "a@rig was compacted, with its restore not yet requested." } },
        { ok: true, sessionName: "b@rig" },
      ],
    });
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(deps));
    const { stdout, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--host", "vm-a", "--rig", "my-rig", "hi team"]);
    });
    const at = stdout.indexOf("a@rig: sent");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(stdout[at + 1]).toBe("Notice: a@rig was compacted, with its restore not yet requested.");
    expect(stdout[at + 2]).toBe("b@rig: sent");
    expect(stdout.filter((l) => l.startsWith("Notice:"))).toHaveLength(1);
    expect(exitCode).toBeFalsy();
  });

  it("broadcast --json prints raw JSON", async () => {
    const { stdout } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(stdout.join("\n"));
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
    expect(logs).toContainEqual(expect.stringMatching(/^FAILED — No running sessions found/));
    expect(exitCode).toBe(1);
  });

  it("a local broadcast to 91 seats that answers after 5.5 s prints every recipient's result, not a 5 s timeout", async () => {
    const { stdout, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello"]);
    });
    expect(stdout).toContain("s90@big-rig: sent");
    expect(stdout).toContain("91/91 delivered");
    expect(exitCode).toBeFalsy();
  }, 20_000);

  it("a local broadcast waits 300 s by default, and --timeout <seconds> sets the wait", async () => {
    const post = vi.fn(async () => ({ status: 200, data: { total: 0, sent: 0, failed: 0, results: [] } }));
    const deps = { ...runningDeps(port), clientFactory: () => ({ post }) as unknown as DaemonClient };
    await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello"]));
    await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--timeout", "600", "hello"]));
    expect(post.mock.calls.map((call) => (call as unknown[])[2])).toEqual([{ timeoutMs: 300_000 }, { timeoutMs: 600_000 }]);
  });

  it("refuses a --timeout that is not a positive number of seconds before posting anything", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--timeout", "0", "hello"]);
    });
    expect(logs.join("\n")).toContain("--timeout must be a positive number of seconds");
    expect(broadcastPosts).toBe(0);
    expect(exitCode).toBe(1);
  });

  it("refuses a --timeout past what a timer holds (2^31 - 1 ms) instead of aborting at once", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--timeout", "2147484", "hello"]);
    });
    expect(logs.join("\n")).toContain("at most 2147483");
    expect(broadcastPosts).toBe(0);
    expect(exitCode).toBe(1);
  });

  describe("when the local broadcast times out", () => {
    const timedOut = () => ({ post: async () => { throw new DaemonTimeoutError("The OpenRig daemon at http://127.0.0.1:7433 did not respond in time: Request to http://127.0.0.1:7433/api/transport/broadcast timed out after 300000ms"); } }) as unknown as DaemonClient;

    it("points to the sender's per-recipient outbox instead of a bare UNKNOWN, and exits 1", async () => {
      const { logs, stdout, exitCode } = await captureLogs(async () => {
        await makeCmd({ ...runningDeps(port), clientFactory: timedOut }).parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("timed out after 300000ms");
      expect(output).toContain("rig queue outbox-list broadcaster@my-rig --limit 1000");
      expect(output).toContain("a retained one is held for its seat");
      expect(output).toContain("may still be running");
      expect(output).toContain("a missing receipt is not proof of non-delivery");
      expect(output).toContain("Don't retry the whole broadcast");
      expect(output).toContain("Resend only to the recipients recorded as failed");
      expect(output).not.toContain("outcome is UNKNOWN");
      expect(stdout).toEqual([]);
      expect(exitCode).toBe(1);
    });

    it("--json prints one error object that names the outbox command", async () => {
      const { stdout, exitCode } = await captureLogs(async () => {
        await makeCmd({ ...runningDeps(port), clientFactory: timedOut }).parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello", "--json"]);
      });
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]!)).toMatchObject({ error: { outboxCommand: "rig queue outbox-list broadcaster@my-rig --limit 1000", fact: expect.stringContaining("timed out") } });
      expect(exitCode).toBe(1);
    });

    it("a connection lost after the request may have arrived gets the same guidance", async () => {
      const dropped = () => ({ post: async () => { throw new DaemonConnectionError("socket hang up", "ECONNRESET"); } }) as unknown as DaemonClient;
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd({ ...runningDeps(port), clientFactory: dropped }).parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("socket hang up");
      expect(output).toContain("may still be running");
      expect(output).toContain("rig queue outbox-list broadcaster@my-rig --limit 1000");
      expect(exitCode).toBe(1);
    });

    it("an unreadable answer, which comes after the fan-out ended, points to the same per-recipient record", async () => {
      const garbled = () => ({ post: async () => { throw new DaemonResponseError(200, "{not json"); } }) as unknown as DaemonClient;
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd({ ...runningDeps(port), clientFactory: garbled }).parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("its answer could not be read");
      expect(output).not.toContain("may still be running");
      expect(output).toContain("rig queue outbox-list broadcaster@my-rig --limit 1000");
      expect(output).toContain("Don't retry the whole broadcast");
      expect(exitCode).toBe(1);
    });

    it("an unreadable non-2xx answer, which can come from a fan-out that stopped partway, is not rendered as an ended one", async () => {
      const failed = () => ({ post: async () => { throw new DaemonResponseError(500, "Internal Server Error"); } }) as unknown as DaemonClient;
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd({ ...runningDeps(port), clientFactory: failed }).parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("HTTP 500");
      expect(output).toContain("possibly from a fan-out that stopped partway");
      expect(output).toContain("Don't retry the whole broadcast");
      expect(output).toContain("Check the recipients with rig capture");
      expect(output).not.toContain("went through the recipients");
      expect(output).not.toContain("may still be running");
      expect(exitCode).toBe(1);
    });

    it("a connection that never reached the daemon is not rendered as a running broadcast", async () => {
      const refused = () => ({ post: async () => { throw new DaemonConnectionError("connect ECONNREFUSED", "ECONNREFUSED"); } }) as unknown as DaemonClient;
      await expect(makeCmd({ ...runningDeps(port), clientFactory: refused }).parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello"]))
        .rejects.toThrow("ECONNREFUSED");
    });

    it("without a sender identity it says no per-recipient record was kept and to check the recipients", async () => {
      vi.stubEnv("OPENRIG_SESSION_NAME", "");
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd({ ...runningDeps(port), clientFactory: timedOut }).parseAsync(["node", "rig", "broadcast", "--rig", "big-rig", "hello"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("no per-recipient record");
      expect(output).toContain("Don't retry the whole broadcast");
      expect(output).toContain("rig capture");
      expect(output).not.toContain("outbox-list");
      expect(exitCode).toBe(1);
    });
  });
});
