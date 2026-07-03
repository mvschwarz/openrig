import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { sendCommand, type SendDeps } from "../src/commands/send.js";
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

function runningDeps(port: number, clientFactory?: StatusDeps["clientFactory"]): StatusDeps {
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
    clientFactory: clientFactory ?? ((baseUrl) => new DaemonClient(baseUrl)),
  };
}

describe("Send CLI", () => {
  let server: http.Server;
  let port: number;
  let lastSendBody: Record<string, unknown> | null = null;
  let lastBroadcastBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && url === "/api/transport/broadcast") {
          const parsed = JSON.parse(body);
          lastBroadcastBody = parsed;
          const sessions: string[] = (parsed.sessions as string[] | undefined)
            ?? ["seat-a@my-rig", "seat-b@my-rig"]; // pod/rig/global resolve to a fixed pair
          if (parsed.text === "partial") {
            const results = [
              { ok: true, sessionName: sessions[0] },
              { ok: false, sessionName: sessions[1], error: "target needs input" },
            ];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ total: 2, sent: 1, failed: 1, results }));
            return;
          }
          const results = sessions.map((s) => ({ ok: true, sessionName: s }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ total: results.length, sent: results.length, failed: 0, results }));
          return;
        }
        if (req.method === "POST" && url === "/api/transport/send") {
          const parsed = JSON.parse(body);
          lastSendBody = parsed;
          if (parsed.session === "dev-impl@my-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "dev-impl@my-rig" }));
          } else if (parsed.session === "verified-session") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "verified-session", verified: true, outcome: "delivered" }));
          } else if (parsed.session === "racy-session") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "racy-session", verified: false, outcome: "rendered-unconfirmed" }));
          } else if (parsed.session === "dead-session") {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, sessionName: "dead-session", reason: "submit_failed", outcome: "failed", error: "Text is visible in 'dead-session' but was not submitted (Enter failed)." }));
          } else if (parsed.session === "busy-session") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, sessionName: "busy-session", reason: "mid_work", error: "Target pane appears mid-task. Use force: true to send anyway." }));
          } else if (parsed.session === "unknown-advisory") {
            // OPR.0.4.3.28 — unknown telemetry now PROCEEDS with a non-blocking advisory (warning).
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "unknown-advisory", warning: "producer-link: daemon-ingest link DOWN — activity could not be determined (no_activity_signal); sent anyway (telemetry is advisory)." }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "not found" }));
          }
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(deps: StatusDeps = runningDeps(port)): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(sendCommand(deps));
    return prog;
  }

  beforeEach(() => {
    lastSendBody = null;
    lastBroadcastBody = null;
  });

  it("send prints success output", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
  });

  it("send with 409 mid-work prints error and exits non-zero", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "busy-session", "hello"]);
    });
    expect(logs.join("\n")).toContain("mid-task");
    expect(exitCode).toBe(1);
  });

  // OPR.0.4.3.28 correction — an unknown-telemetry send PROCEEDS and PRINTS the advisory on
  // human output (not only in --json).
  it("prints the Advisory on an unknown-proceed send (human output)", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "unknown-advisory", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Sent to unknown-advisory");
    expect(output).toContain("Advisory:");
    expect(output).toContain("daemon-ingest link DOWN");
    expect(exitCode).toBeUndefined();
  });

  it("carries the advisory as `warning` in --json output", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "unknown-advisory", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.warning).toContain("daemon-ingest link DOWN");
  });

  // OPR.99.0.6.3 — honest delivery-outcome vocabulary; legacy Verified: line preserved.
  it("verify confirmed prints Delivery: delivered AND the legacy Verified: yes", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "verified-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Sent to verified-session");
    expect(output).toContain("Verified: yes");
    expect(output).toContain("Delivery: delivered");
  });

  it("verify redraw-race prints Delivery: rendered-unconfirmed (landed, with capture guidance) AND legacy Verified: no", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "racy-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Sent to racy-session");
    expect(output).toContain("Verified: no");
    expect(output).toContain("Delivery: rendered-unconfirmed");
    expect(output).toContain("landed");
    expect(output).toContain("rig capture racy-session");
    // The middle is NOT dressed as failure: exit stays clean.
    expect(exitCode).toBeUndefined();
  });

  it("verify genuine transport failure stays an error path, distinct from the middle (discriminator)", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dead-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    // HTTP 502 -> error branch; no success lines, exit non-zero.
    expect(output).not.toContain("Sent to dead-session");
    expect(output).not.toContain("Delivery: rendered-unconfirmed");
    expect(output).toContain("not submitted");
    expect(exitCode).toBe(2);
  });

  it("verify --json passes the additive outcome field through", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "racy-session", "hello", "--verify", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.verified).toBe(false);
    expect(parsed.outcome).toBe("rendered-unconfirmed");
  });

  it("send --json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionName).toBe("dev-impl@my-rig");
  });

  it("send --wait-for-idle posts waitForIdleMs and extends request timeout", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    const { logs } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(postFn).toHaveBeenCalledWith(
      "/api/transport/send",
      expect.objectContaining({
        session: "dev-impl@my-rig",
        text: expect.stringContaining("hello"),
        waitForIdleMs: 30000,
      }),
      { timeoutMs: 35000 },
    );
    const sentText = postFn.mock.calls[0]?.[1] as { text: string } | undefined;
    expect(sentText?.text).toContain("To: dev-impl@my-rig");
    expect(sentText?.text).toContain("---\nhello\n---");
    expect(sentText?.text).toContain('↩ Reply: rig send');
  });

  it("send without wait-for-idle uses default client timeout path", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(postFn.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("send rejects invalid wait-for-idle values before contacting daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "0"]);
    });
    expect(logs.join("\n")).toContain("positive number");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send rejects wait-for-idle with force before contacting daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--force"]);
    });
    expect(logs.join("\n")).toContain("cannot be combined");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  // OPR.0.4.1.10 — --raw sends exact text with NO messaging envelope (still guarded server-side).
  it("send --raw posts the exact text without the From/To envelope", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "/compact", "--raw"]);
    });
    expect(lastSendBody?.text).toBe("/compact");
    expect(String(lastSendBody?.text)).not.toContain("To: dev-impl@my-rig");
    expect(String(lastSendBody?.text)).not.toContain("↩ Reply");
  });

  it("default send (no --raw) wraps the From/To messaging envelope", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
    expect(String(lastSendBody?.text)).toContain("---\nhello\n---");
  });

  it("send --dangerously-interact --reason posts the override fields with raw (exact) text", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact", "--reason", "unblock stuck prompt"]);
    });
    expect(lastSendBody?.dangerouslyInteract).toBe(true);
    expect(lastSendBody?.reason).toBe("unblock stuck prompt");
    expect(lastSendBody?.text).toBe("1"); // implies --raw: no envelope
    expect("actorSession" in (lastSendBody ?? {})).toBe(true);
  });

  it("send --dangerously-interact without --reason is rejected before contacting the daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact"]);
    });
    expect(logs.join("\n")).toContain("requires --reason");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send --dangerously-interact + --wait-for-idle is rejected before contacting the daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact", "--reason", "x", "--wait-for-idle", "30"]);
    });
    expect(logs.join("\n")).toContain("cannot be combined with --wait-for-idle");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  // OPR.0.4.1.10 — cross-host argv must forward the new flags so the remote rig applies the same guard.
  it("send --host forwards --raw/--dangerously-interact/--reason in the reconstructed remote argv", async () => {
    let captured: readonly string[] | null = null;
    const deps: SendDeps = {
      ...runningDeps(port),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-test", transport: "ssh", target: "vm.local" }] } }),
      crossHostRun: async (_host, argv) => { captured = argv; return { ok: true, stdout: "remote ok", stderr: "" }; },
    };
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--host", "vm-test", "--raw", "--dangerously-interact", "--reason", "why now"]);
    });
    expect(captured).not.toBeNull();
    const argv = captured as unknown as string[];
    expect(argv).toContain("--raw");
    expect(argv).toContain("--dangerously-interact");
    const ri = argv.indexOf("--reason");
    expect(ri).toBeGreaterThan(-1);
    expect(argv[ri + 1]).toBe("why now");
  });

  // OPR.0.4.3.30 — `rig send` fan-out targeting (--to / --pod / --rig).
  it("send --to a,b fans out to /broadcast with a sessions list and prints per-recipient summary", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hello team"]);
    });
    expect(lastSendBody).toBeNull(); // NOT the single-seat path
    expect(lastBroadcastBody?.sessions).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    expect(lastBroadcastBody?.text).toBe("hello team"); // bare — daemon wraps per recipient
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig: sent");
    expect(output).toContain("dev-qa@my-rig: sent");
    expect(output).toContain("2/2 delivered");
    expect(exitCode).toBeUndefined();
  });

  it("send --to accepts repetition (--to a --to b) and sets the daemon-side envelopeSender", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "--to", "dev-qa@my-rig", "hi"]);
    });
    expect(lastBroadcastBody?.sessions).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    // Non-raw fan-out: the daemon wraps per recipient, so the CLI passes a sender + BARE text.
    expect(typeof lastBroadcastBody?.envelopeSender).toBe("string");
    expect(String(lastBroadcastBody?.text)).not.toContain("To:");
  });

  it("send --pod posts a pod target to /broadcast", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--pod", "dev", "pod message"]);
    });
    expect(lastBroadcastBody?.pod).toBe("dev");
    expect(lastBroadcastBody?.text).toBe("pod message");
    expect(logs.join("\n")).toContain("2/2 delivered");
  });

  it("send --rig posts a rig target to /broadcast", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--rig", "my-rig", "rig message"]);
    });
    expect(lastBroadcastBody?.rig).toBe("my-rig");
    expect(logs.join("\n")).toContain("2/2 delivered");
  });

  it("fan-out with one recipient failing prints which failed, the summary, and exits nonzero", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "seat-a@my-rig,seat-b@my-rig", "partial"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("seat-a@my-rig: sent");
    expect(output).toContain("seat-b@my-rig: FAILED — target needs input");
    expect(output).toContain("1/2 delivered");
    expect(exitCode).toBe(1);
  });

  it("fan-out --raw sends bare exact text with NO envelopeSender (no per-recipient wrap)", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "/compact", "--raw"]);
    });
    expect(lastBroadcastBody?.text).toBe("/compact");
    expect("envelopeSender" in (lastBroadcastBody ?? {})).toBe(false);
  });

  it("fan-out --dangerously-interact --reason plumbs the danger fields (bare text, no envelope)", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "1", "--dangerously-interact", "--reason", "drive stuck prompts"]);
    });
    expect(lastBroadcastBody?.dangerouslyInteract).toBe(true);
    expect(lastBroadcastBody?.reason).toBe("drive stuck prompts");
    expect(lastBroadcastBody?.text).toBe("1");
    expect("envelopeSender" in (lastBroadcastBody ?? {})).toBe(false);
  });

  it("rejects combining a bare seat with a fan-out flag", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--pod", "dev"]);
    });
    expect(logs.join("\n")).toContain("cannot be combined with --to/--pod/--rig");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
    expect(lastSendBody).toBeNull();
  });

  it("rejects more than one fan-out mode at once", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--pod", "dev", "--rig", "my-rig", "hello"]);
    });
    expect(logs.join("\n")).toContain("exactly ONE target");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
  });

  it("rejects --wait-for-idle with a multi/pod/rig target", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--rig", "my-rig", "hello", "--wait-for-idle", "30"]);
    });
    expect(logs.join("\n")).toContain("not supported with a multi/pod/rig target");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
  });

  it("single-seat send is UNCHANGED — still posts to /send, byte-identical envelope, no /broadcast", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(lastBroadcastBody).toBeNull();
    expect(lastSendBody?.session).toBe("dev-impl@my-rig");
    expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
  });

  it("send --help includes rediscovery examples + the new guard flags", () => {
    const cmd = sendCommand(runningDeps(port));
    const helpText = cmd.helpInformation();
    expect(helpText).toContain("--verify");
    expect(helpText).toContain("--force");
    expect(helpText).toContain("--wait-for-idle");
    expect(helpText).toContain("--raw");
    expect(helpText).toContain("--dangerously-interact");
    expect(helpText).toContain("pane only");
    expect(helpText).toContain("dev-impl@my-rig");
  });

  // OPR.0.4.3.28 B1 code-review fix — the help text must reflect the corrected
  // proceed-with-advisory behavior, NOT the obsolete fail-closed-on-unknown contract
  // (which would keep steering operators toward the deprecated --dangerously-interact bridge).
  // The narrative contract lives in addHelpText("after"), which helpInformation() omits —
  // capture the FULL `--help` render via configureOutput + exitOverride.
  it("send --help documents proceed-with-advisory on unknown telemetry, not fail-closed", () => {
    const cmd = sendCommand(runningDeps(port));
    let helpText = "";
    cmd.configureOutput({ writeOut: (s) => { helpText += s; }, writeErr: (s) => { helpText += s; } });
    cmd.exitOverride();
    try { cmd.parse(["node", "send", "--help"]); } catch { /* exitOverride throws on --help */ }
    expect(helpText.toLowerCase()).not.toContain("fails closed");
    expect(helpText).toContain("advisory");
    expect(helpText).toMatch(/PROCEEDS with an\s+advisory/); // \s+ tolerates the help line-wrap
    // The positive-picker refusal contract is still documented.
    expect(helpText.toLowerCase()).toContain("refused");
  });
});
