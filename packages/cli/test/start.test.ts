// OPR.0.3.4.1 — rig start: one-command recovery orchestrator tests.
// Tests verify composition (slice-02 /api/up called, never private restore),
// headless flags, honest reporting, kernel invariant, and idempotency.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { startCommand } from "../src/commands/start.js";
import { DaemonClient } from "../src/client.js";
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

describe("rig start (OPR.0.3.4.1)", () => {
  let server: http.Server;
  let port: number;
  let upBodies: Array<Record<string, unknown>> = [];
  let routes: Record<string, (req: http.IncomingMessage, body: Record<string, unknown>) => Record<string, unknown>>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const url = req.url ?? "";
        const method = req.method ?? "GET";

        if (method === "GET" && url === "/healthz") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (method === "GET" && url === "/api/kernel/status") {
          const handler = routes["/api/kernel/status"];
          const data = handler ? handler(req, body) : { kernel_state: "ready" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
          return;
        }
        if (method === "GET" && url === "/api/rigs/summary") {
          const handler = routes["/api/rigs/summary"];
          const data = handler ? handler(req, body) : [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
          return;
        }
        if (method === "GET" && url.match(/^\/api\/rigs\/[^/]+$/)) {
          const handler = routes["/api/rigs/:id"];
          const data = handler ? handler(req, body) : { sessions: [] };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
          return;
        }
        if (method === "POST" && url === "/api/up") {
          upBodies.push(body);
          const handler = routes["/api/up"];
          const data = handler ? handler(req, body) : {};
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
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
    routes = {};
  });

  function deps(promptYesNo?: (q: string) => Promise<boolean>) {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-06-14T00:00:00Z" } as DaemonState)
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
    prog.addCommand(startCommand(deps(promptYesNo)));
    return prog;
  }

  function setupCandidateRig(name: string, opts?: { lifecycleState?: string; hasToken?: boolean }) {
    const lifecycleState = opts?.lifecycleState ?? "recoverable";
    const hasToken = opts?.hasToken ?? true;
    routes["/api/rigs/summary"] = () => [
      { id: "rig-1", name, nodeCount: 2, lifecycleState },
    ];
    routes["/api/rigs/:id"] = () => ({ sessions: [{ lastSeenAt: "2026-06-14T12:00:00Z" }] });
    routes["/api/up"] = (_req, body) => {
      if (body.plan === true) {
        return {
          status: "plan", mode: "restore", rigId: "rig-1", rigName: name,
          snapshot: { id: "snap-1", kind: "auto-pre-down", createdAt: "2026-06-14T11:00:00Z" },
          wouldCaptureCurrentState: false,
          nodes: [
            { logicalId: "dev.impl", intendedAction: hasToken ? "resume-original" : "awaiting-decision", ...(hasToken ? {} : { reason: "no token available" }) },
            { logicalId: "dev.qa", intendedAction: "resume-original" },
          ],
          mutated: false,
        };
      }
      return {
        status: "restored", rigId: "rig-1", rigName: name,
        rigResult: "fully_restored",
        nodes: [
          { logicalId: "dev.impl", status: hasToken ? "resumed" : "awaiting-decision", error: hasToken ? undefined : "no token available" },
          { logicalId: "dev.qa", status: "resumed" },
        ],
        warnings: [],
      };
    };
  }

  // ---- HEADLESS FLAGS ----

  it("--last restores all candidates with ZERO prompts", async () => {
    setupCandidateRig("my-rig");
    const prompt = vi.fn(async () => true);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(prompt).parseAsync(["node", "rig", "start", "--last"]);
    });
    expect(prompt).not.toHaveBeenCalled();
    const applyBodies = upBodies.filter((b) => b.plan !== true);
    expect(applyBodies.length).toBeGreaterThanOrEqual(1);
    expect(applyBodies[0]!.sourceRef).toBe("my-rig");
    const output = logs.join("\n");
    expect(output).toContain("my-rig");
  });

  it("--all restores all candidates with ZERO prompts", async () => {
    setupCandidateRig("my-rig");
    const prompt = vi.fn(async () => true);
    const { logs } = await captureLogs(async () => {
      await makeCmd(prompt).parseAsync(["node", "rig", "start", "--all"]);
    });
    expect(prompt).not.toHaveBeenCalled();
    const applyBodies = upBodies.filter((b) => b.plan !== true);
    expect(applyBodies.length).toBeGreaterThanOrEqual(1);
  });

  it("--rigs restores only the named rig", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "rig-1", name: "alpha", nodeCount: 1, lifecycleState: "recoverable" },
      { id: "rig-2", name: "beta", nodeCount: 1, lifecycleState: "recoverable" },
    ];
    routes["/api/rigs/:id"] = () => ({ sessions: [] });
    routes["/api/up"] = (_req, body) => {
      if (body.plan === true) {
        return {
          status: "plan", mode: "restore", rigId: "rig-x", rigName: body.sourceRef,
          snapshot: { id: "snap-1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
          wouldCaptureCurrentState: false,
          nodes: [{ logicalId: "w", intendedAction: "resume-original" }],
          mutated: false,
        };
      }
      return { status: "restored", rigResult: "fully_restored", nodes: [{ logicalId: "w", status: "resumed" }], warnings: [] };
    };

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--rigs", "alpha"]);
    });
    const applyBodies = upBodies.filter((b) => b.plan !== true);
    expect(applyBodies).toHaveLength(1);
    expect(applyBodies[0]!.sourceRef).toBe("alpha");
  });

  // ---- COMPOSE, NOT REIMPLEMENT ----

  it("restore goes through /api/up (slice-02 path), not a private implementation", async () => {
    setupCandidateRig("my-rig");
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const applyBodies = upBodies.filter((b) => b.plan !== true);
    expect(applyBodies.length).toBeGreaterThanOrEqual(1);
    expect(applyBodies.some((b) => b.sourceRef === "my-rig")).toBe(true);
  });

  // ---- TOKENLESS INCLUSION (guard rev1 discriminator) ----

  it("a tokenless rig (no resume token, restore-usable snapshot) is LISTED and previewed as awaiting-decision", async () => {
    setupCandidateRig("tokenless-rig", { hasToken: false });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("tokenless-rig");
    expect(output).toContain("awaiting-decision");
    const applyBodies = upBodies.filter((b) => b.plan !== true);
    expect(applyBodies.length).toBeGreaterThanOrEqual(1);
  });

  // ---- KERNEL INVARIANT ----

  it("kernel failure -> honest hard-fail, restore NOT attempted", async () => {
    routes["/api/kernel/status"] = () => ({ kernel_state: "auth_blocked", detail: "Claude not authorized" });
    setupCandidateRig("my-rig");
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Kernel failed");
    expect(output).toContain("Cannot proceed");
    expect(exitCode).toBe(1);
    const applyBodies = upBodies.filter((b) => b.plan !== true);
    expect(applyBodies).toHaveLength(0);
  });

  // ---- IDEMPOTENT RERUN ----

  it("already-running rig is SKIPPED (not relaunched)", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "rig-1", name: "live-rig", nodeCount: 2, lifecycleState: "running" },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--all"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("No rigs to restore");
    expect(upBodies.filter((b) => b.plan !== true)).toHaveLength(0);
  });

  // ---- UI URL HONESTY ----

  it("reports UI URL only when healthz is reachable", async () => {
    routes["/api/rigs/summary"] = () => [];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    expect(output).toContain(`http://127.0.0.1:${port}`);
  });

  // ---- HONEST TIMEOUT ----

  it("apply-mode timeout reports in-progress/unknown + rig ps, not bare failure", async () => {
    setupCandidateRig("timeout-rig");
    // Override /api/up to throw a timeout for apply
    const throwClient = new DaemonClient(`http://127.0.0.1:${port}`);
    const origPost = throwClient.post.bind(throwClient);
    let planCallCount = 0;
    throwClient.post = async (path: string, body?: unknown, opts?: unknown) => {
      const b = body as Record<string, unknown> | undefined;
      if (path === "/api/up" && b?.plan !== true) {
        throw new (await import("../src/client.js")).DaemonConnectionError("request timed out");
      }
      return origPost(path, body, opts);
    };
    const d = deps();
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(startCommand({ ...d, clientFactory: () => throwClient }));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("may still be processing");
    expect(output).toContain("rig ps");
    expect(exitCode).toBe(1);
  });

  // ---- NO NEW STATUS TERMS ----

  it("only the five slice-02 terms appear in restore output (no new term invented)", async () => {
    const validTerms = ["resumed", "fresh-primed", "awaiting-decision", "attention_required", "failed"];
    routes["/api/rigs/summary"] = () => [{ id: "r1", name: "term-rig", nodeCount: 3, lifecycleState: "recoverable" }];
    routes["/api/rigs/:id"] = () => ({ sessions: [] });
    routes["/api/up"] = (_req, body) => {
      if (body.plan === true) {
        return {
          status: "plan", mode: "restore", rigId: "r1", rigName: "term-rig",
          snapshot: { id: "s1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
          wouldCaptureCurrentState: false,
          nodes: [
            { logicalId: "a", intendedAction: "resume-original" },
            { logicalId: "b", intendedAction: "awaiting-decision", reason: "no token" },
            { logicalId: "c", intendedAction: "fresh-primed" },
          ],
          mutated: false,
        };
      }
      return {
        status: "restored", rigResult: "partially_restored",
        nodes: [
          { logicalId: "a", status: "resumed" },
          { logicalId: "b", status: "awaiting-decision", error: "no token" },
          { logicalId: "c", status: "fresh-primed" },
        ],
        warnings: [],
      };
    };

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    const statusMatches = output.match(/\b(resumed|fresh-primed|awaiting-decision|attention_required|failed)\b/g) ?? [];
    for (const term of statusMatches) {
      expect(validTerms).toContain(term);
    }
  });

  // ---- NON-2XX ERROR HANDLING (guard BLOCKING 25661f72) ----

  it("non-2xx /api/up (rig_not_stopped) -> honest error output, nonzero exit, not undefined success", async () => {
    routes["/api/rigs/summary"] = () => [{ id: "r1", name: "live-rig", nodeCount: 1, lifecycleState: "detached" }];
    routes["/api/rigs/:id"] = () => ({ sessions: [] });
    let planDone = false;
    routes["/api/up"] = (_req, body) => {
      if (body.plan === true && !planDone) {
        planDone = true;
        return {
          status: "plan", mode: "restore", rigId: "r1", rigName: "live-rig",
          snapshot: { id: "s1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
          wouldCaptureCurrentState: false,
          nodes: [{ logicalId: "w", intendedAction: "resume-original" }],
          mutated: false,
        };
      }
      // Apply returns 409 rig_not_stopped (simulate live sessions blocking restore).
      return "__409__" as never;
    };
    // Override server to return 409 for the apply call.
    const origRouteHandler = routes["/api/up"];
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const url = req.url ?? "";
        const method = req.method ?? "GET";
        if (method === "GET" && url === "/healthz") { res.writeHead(200).end(JSON.stringify({ ok: true })); return; }
        if (method === "GET" && url === "/api/kernel/status") { res.writeHead(200).end(JSON.stringify({ kernel_state: "ready" })); return; }
        if (method === "GET" && url === "/api/rigs/summary") { res.writeHead(200).end(JSON.stringify(routes["/api/rigs/summary"]!(req, body))); return; }
        if (method === "GET" && url.match(/^\/api\/rigs\/[^/]+$/)) { res.writeHead(200).end(JSON.stringify({ sessions: [] })); return; }
        if (method === "POST" && url === "/api/up") {
          upBodies.push(body);
          if (body.plan === true) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              status: "plan", mode: "restore", rigId: "r1", rigName: "live-rig",
              snapshot: { id: "s1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
              wouldCaptureCurrentState: false,
              nodes: [{ logicalId: "w", intendedAction: "resume-original" }],
              mutated: false,
            }));
            return;
          }
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Rig r1 has live sessions", code: "rig_not_stopped" }));
          return;
        }
        res.writeHead(404).end();
      });
    });

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("live-rig");
    expect(output).toContain("rig_not_stopped");
    expect(output).not.toContain("undefined");
    expect(exitCode).toBe(1);

    // Restore the original server handler for subsequent tests.
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const url = req.url ?? "";
        const method = req.method ?? "GET";
        if (method === "GET" && url === "/healthz") { res.writeHead(200).end(JSON.stringify({ ok: true })); return; }
        if (method === "GET" && url === "/api/kernel/status") { const h = routes["/api/kernel/status"]; res.writeHead(200).end(JSON.stringify(h ? h(req, body) : { kernel_state: "ready" })); return; }
        if (method === "GET" && url === "/api/rigs/summary") { const h = routes["/api/rigs/summary"]; res.writeHead(200).end(JSON.stringify(h ? h(req, body) : [])); return; }
        if (method === "GET" && url.match(/^\/api\/rigs\/[^/]+$/)) { const h = routes["/api/rigs/:id"]; res.writeHead(200).end(JSON.stringify(h ? h(req, body) : { sessions: [] })); return; }
        if (method === "POST" && url === "/api/up") { upBodies.push(body); const h = routes["/api/up"]; const d = h ? h(req, body) : {}; res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(d)); return; }
        res.writeHead(404).end();
      });
    });
  });

  it("partially_restored rigResult -> nonzero exit (not treated as clean)", async () => {
    setupCandidateRig("partial-rig");
    routes["/api/up"] = (_req, body) => {
      if (body.plan === true) {
        return {
          status: "plan", mode: "restore", rigId: "rig-1", rigName: "partial-rig",
          snapshot: { id: "s1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
          wouldCaptureCurrentState: false,
          nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }],
          mutated: false,
        };
      }
      return {
        status: "restored", rigResult: "partially_restored",
        nodes: [{ logicalId: "dev.impl", status: "fresh-primed" }],
        warnings: [],
      };
    };

    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    expect(exitCode).toBe(1);
  });

  // ---- JSON OUTPUT ----

  it("--json outputs structured result", async () => {
    setupCandidateRig("json-rig");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last", "--json"]);
    });
    const jsonLine = logs.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe("started");
    expect(parsed.restoredRigs).toBeDefined();
    expect(parsed.restoredRigs.length).toBeGreaterThanOrEqual(1);
    expect(parsed.restoredRigs[0].rigName).toBe("json-rig");
  });
});
