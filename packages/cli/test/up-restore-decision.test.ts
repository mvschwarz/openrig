// OPR.0.3.4.2 — rig up --existing: resume-original default surface.
// --fresh opt-in forwarding, the awaiting-decision ASK/offer (TTY [y/N] via
// injected prompt; headless honest machine-status + --fresh hint), and the
// five-term distinct-naming render. NEVER an auto-substitution.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

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

describe("rig up --existing — resume-original default (OPR.0.3.4.2)", () => {
  let server: http.Server;
  let port: number;
  let upBodies: Array<Record<string, unknown>> = [];
  /** Per-test response factory keyed on the freshLogicalIds in the request. */
  let respond: (body: Record<string, unknown>) => Record<string, unknown>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/up") {
          const body = JSON.parse(raw || "{}");
          upBodies.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(respond(body)));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    upBodies = [];
    respond = () => ({ status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "fully_restored", nodes: [], warnings: [] });
  });

  function deps(promptYesNo?: (q: string) => Promise<boolean>) {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-06-11T00:00:00Z" } as DaemonState)
          : null),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (url: string) => new DaemonClient(url),
      promptYesNo,
    };
  }

  function makeCmd(promptYesNo?: (q: string) => Promise<boolean>): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(deps(promptYesNo)));
    return prog;
  }

  it("--fresh seats forward as freshLogicalIds in the /api/up body (operation B)", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--fresh", "dev.impl", "dev.qa"]);
    });
    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.freshLogicalIds).toEqual(["dev.impl", "dev.qa"]);
  });

  it("headless awaiting-decision: honest machine status + --fresh hint, exit 1, NO auto-substitution", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "Original session unresumable: resume attempted but failed." }],
      warnings: [],
    });
    // No promptYesNo injected and no TTY in vitest -> the headless path.
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev.impl: awaiting-decision");
    expect(output).toContain("--fresh dev.impl");
    expect(exitCode).toBe(1);
    // CRITICAL: exactly one POST — nothing auto-substituted a fresh session.
    expect(upBodies).toHaveLength(1);
  });

  it("a seat held back for a missing startup file shows why and how to fix it; the others show as restored", async () => {
    const reason = "Not launched: Required startup file is missing for dev.qa: /work/startup.md Restore the missing startup file or capture a new snapshot before retrying restore.";
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "resumed" }, { logicalId: "dev.qa", status: "failed", error: reason }],
      warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev.impl: resumed");
    expect(output).toContain(`dev.qa: failed — ${reason}`);
  });

  it("TTY ASK accepted: [y/N] offer names seat + reason, then re-runs as a deliberate fresh-prime", async () => {
    respond = (body) => Array.isArray(body.freshLogicalIds) && (body.freshLogicalIds as string[]).length > 0
      ? {
          status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
          nodes: [{ logicalId: "dev.impl", status: "fresh-primed" }], warnings: [],
        }
      : {
          status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
          nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }], warnings: [],
        };
    const prompt = vi.fn(async () => true);

    const { logs } = await captureLogs(async () => {
      await makeCmd(prompt).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    const question = prompt.mock.calls[0]![0] as string;
    expect(question).toContain("dev.impl");
    expect(question).toContain("no token available");
    expect(question).toContain("[y/N]");
    // The accepted seat was re-run as operation B.
    expect(upBodies).toHaveLength(2);
    expect(upBodies[1]!.freshLogicalIds).toEqual(["dev.impl"]);
    expect(logs.join("\n")).toContain("dev.impl: fresh-primed");
  });

  it("TTY ASK declined: no second POST, no session started", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }],
      warnings: [],
    });
    const prompt = vi.fn(async () => false);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(prompt).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });

    expect(upBodies).toHaveLength(1);
    expect(logs.join("\n")).toContain("No fresh sessions started");
    expect(exitCode).toBe(1);
  });

  // OPR.0.3.4.4 — plan-restore preview render + honest-async timeout.
  it("--plan restore preview renders per-seat intended actions and 'No changes made.'", async () => {
    respond = () => ({
      status: "plan",
      mode: "restore",
      rigId: "rig-1",
      rigName: "myrig",
      snapshot: { id: "snap-9", kind: "auto-pre-down", createdAt: "2026-06-11T00:00:00Z" },
      wouldCaptureCurrentState: false,
      nodes: [
        { logicalId: "dev.impl", intendedAction: "resume-original" },
        { logicalId: "dev.qa", intendedAction: "awaiting-decision", reason: "resume source 'claude_name' recorded but no token available — apply would stop and ask (zero session)" },
      ],
      mutated: false,
    });

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan"]);
    });
    const output = logs.join("\n");
    expect(output).toContain('Plan: restore rig "myrig"');
    expect(output).toContain("snap-9");
    expect(output).toContain("dev.impl: resume-original");
    expect(output).toContain("dev.qa: awaiting-decision");
    expect(output).toContain("no token available");
    expect(output).toContain("No changes made.");
    expect(exitCode).toBeUndefined();
    // The plan flag reached the daemon body.
    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.plan).toBe(true);
  });

  it("--plan --fresh posts BOTH plan:true and freshLogicalIds, and renders the fresh-primed preview", async () => {
    respond = (body) => ({
      status: "plan",
      mode: "restore",
      rigId: "rig-1",
      rigName: "myrig",
      snapshot: { id: "snap-9", kind: "auto-pre-down", createdAt: "2026-06-11T00:00:00Z" },
      wouldCaptureCurrentState: false,
      nodes: Array.isArray(body.freshLogicalIds) && (body.freshLogicalIds as string[]).includes("dev.impl")
        ? [{ logicalId: "dev.impl", intendedAction: "fresh-primed", reason: "listed in --fresh — apply would deliberately skip the resume (operation B)" }]
        : [{ logicalId: "dev.impl", intendedAction: "resume-original" }],
      mutated: false,
    });

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan", "--fresh", "dev.impl"]);
    });

    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.plan).toBe(true);
    expect(upBodies[0]!.freshLogicalIds).toEqual(["dev.impl"]);
    const output = logs.join("\n");
    expect(output).toContain("dev.impl: fresh-primed");
    expect(output).toContain("No changes made.");
  });

  it("HONEST TIMEOUT (apply mode): DaemonConnectionError renders in-progress/unknown + verify command, never a bare failure", async () => {
    const throwingClient = {
      get: async () => { throw new DaemonConnectionError("request timed out after 120000ms"); },
      post: async () => { throw new DaemonConnectionError("request timed out after 120000ms"); },
    } as unknown as DaemonClient;
    const customDeps = { ...deps(), clientFactory: () => throwingClient };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(customDeps));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    // Honest in-progress/unknown framing, not a false "failed".
    expect(output).toContain("may still be processing");
    expect(output).toContain("does not mean the operation failed");
    expect(output).toContain("rig ps");
    expect(output).not.toContain("Up failed");
    expect(exitCode).toBe(1);
  });

  // OPR.0.3.4.6 — cross-surface regression guard: CLI exit-code + JSON.
  it("OPR.0.3.4.6 guard: attention_required/awaiting-decision -> partially_restored -> exit 1, never exit 0", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a", status: "resumed" },
        { logicalId: "b", status: "attention_required" },
        { logicalId: "c", status: "awaiting-decision", error: "no token" },
      ],
      warnings: [],
    });
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    expect(exitCode).toBe(1);
  });

  it("OPR.0.3.4.6 guard: JSON passes raw per-node status for all five terms (never collapsed)", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a", status: "resumed" },
        { logicalId: "b", status: "fresh-primed" },
        { logicalId: "c", status: "awaiting-decision", error: "no token" },
        { logicalId: "d", status: "attention_required" },
        { logicalId: "e", status: "failed" },
      ],
      warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--json"]);
    });
    const jsonLine = logs.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    const statuses = (parsed.nodes as Array<{ status: string }>).map((n) => n.status);
    expect(statuses).toContain("resumed");
    expect(statuses).toContain("fresh-primed");
    expect(statuses).toContain("awaiting-decision");
    expect(statuses).toContain("attention_required");
    expect(statuses).toContain("failed");
  });

  it("distinct naming: all five vocabulary terms render distinctly per seat", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a", status: "resumed" },
        { logicalId: "b", status: "fresh-primed" },
        { logicalId: "c", status: "awaiting-decision", error: "no token available" },
        { logicalId: "d", status: "attention_required" },
        { logicalId: "e", status: "failed" },
      ],
      warnings: [],
    });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("a: resumed");
    expect(output).toContain("b: fresh-primed");
    expect(output).toContain("c: awaiting-decision");
    expect(output).toContain("d: attention_required");
    expect(output).toContain("e: failed");
    expect(exitCode).toBe(1);
  });
});
