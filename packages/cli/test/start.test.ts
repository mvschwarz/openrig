// OPR.0.3.4.1 — rig start: one-command recovery orchestrator tests.
// Tests verify composition (slice-02 /api/up called, never private restore),
// headless flags, honest reporting, kernel invariant, and idempotency.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { startCommand, lastStopState } from "../src/commands/start.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    acquireStartLock: () => ({ recordChild: vi.fn(), release: vi.fn() }),
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

function captureLogs(fn: () => Promise<void>, logs: string[] = []): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
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
  let nodesReads = 0;
  let routes: Record<string, (req: http.IncomingMessage, body: Record<string, unknown>) => Record<string, unknown>>;
  let launches: Array<{ seat: string; body: Record<string, unknown> }> = [];

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
        const nodesMatch = method === "GET" && url.match(/^\/api\/rigs\/([^/]+)\/nodes$/);
        if (nodesMatch) nodesReads++;
        if (nodesMatch && routes["/api/rigs/:id/nodes"]) {
          const data = routes["/api/rigs/:id/nodes"]!(req, { _rigId: nodesMatch[1] });
          const httpStatus = (data as Record<string, unknown> | null)?._httpStatus as number | undefined;
          res.writeHead(httpStatus ?? 200, { "Content-Type": "application/json" });
          res.end(httpStatus ? "{}" : JSON.stringify(data));
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
        // Id-based plan preview: POST /api/rigs/:id/up (used by rig start candidate discovery)
        const rigUpMatch = method === "POST" && url.match(/^\/api\/rigs\/([^/]+)\/up$/);
        if (rigUpMatch) {
          upBodies.push({ ...body, _rigIdRoute: rigUpMatch[1] });
          const handler = routes["/api/rigs/:id/up"] ?? routes["/api/up"];
          const data = handler ? handler(req, { ...body, _rigId: rigUpMatch[1] }) : {};
          const httpStatus = (data as Record<string, unknown>)?._httpStatus as number | undefined;
          res.writeHead(httpStatus ?? 200, { "Content-Type": "application/json" });
          const { _httpStatus: _, ...cleanData } = data as Record<string, unknown>;
          res.end(JSON.stringify(httpStatus ? cleanData : data));
          return;
        }
        const launchMatch = method === "POST" && url.match(/^\/api\/seat\/launch\/(.+)$/);
        if (launchMatch) {
          launches.push({ seat: decodeURIComponent(launchMatch[1]!), body });
          const data = routes["/api/seat/launch/:seat"]?.(req, body) ?? { ok: true };
          const httpStatus = (data as Record<string, unknown>)._httpStatus as number | undefined;
          const { _httpStatus: _, ...cleanData } = data as Record<string, unknown>;
          res.writeHead(httpStatus ?? 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(cleanData));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); resetFetchAllowlist(); });

  beforeEach(() => {
    allowFetchTarget(`http://127.0.0.1:${port}`);
    upBodies = [];
    launches = [];
    nodesReads = 0;
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
    // When tmux is lost, the boot reconciler marks each session detached: no recorded stop
    // intent, so --last restores the rig.
    routes["/api/rigs/:id/nodes"] = () => ["dev.impl", "dev.qa"].map((logicalId) => ({
      logicalId, sessionStatus: "detached", storedSessionStatus: "detached", intentionallyStopped: false,
    })) as unknown as Record<string, unknown>;
    // Both plan preview AND apply go through the id-based route.
    routes["/api/rigs/:id/up"] = (_req, body) => {
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

  it("applies fresh seats inside the concurrent restore pool", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "rig-1", name: "one", nodeCount: 1, lifecycleState: "recoverable" },
      { id: "rig-2", name: "two", nodeCount: 1, lifecycleState: "recoverable" },
    ] as unknown as Record<string, unknown>;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }] }
      : { status: "restored", rigResult: "fully_restored", nodes: [{ logicalId: "dev.impl", status: "fresh-primed" }] };
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@one", "--concurrency", "2", "--json"]);
    });
    const applies = upBodies.filter(body => body.plan === false);
    expect(applies).toHaveLength(2);
    expect(applies.find(body => body._rigIdRoute === "rig-1")).toMatchObject({ freshLogicalIds: ["dev.impl"] });
    expect(applies.find(body => body._rigIdRoute === "rig-2")?.freshLogicalIds).toBeUndefined();
    expect(JSON.parse(logs.find(line => line.startsWith("{"))!).restoredRigs.map((item: { rigId: string }) => item.rigId)).toEqual(["rig-1", "rig-2"]);
  });


  it.each([1, 2])("limits restore requests to %i and preserves result order", async limit => {
    routes["/api/rigs/summary"] = () => ["one", "two", "three"].map((name, i) =>
      ({ id: `rig-${i}`, name, nodeCount: 1, lifecycleState: "recoverable" })) as unknown as Record<string, unknown>;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", mode: "restore", nodes: [], mutated: false }
      : { status: "restored", rigResult: "fully_restored", nodes: [] };
    const waiting: Array<() => void> = [];
    let active = 0, maximum = 0, entered = 0;
    const prog = new Command();
    const options = deps();
    prog.addCommand(startCommand({ ...options, clientFactory: url => {
      const client = new DaemonClient(url);
      const post = client.post.bind(client);
      client.post = (async (path: string, body: unknown, config?: unknown) => {
        if (path.endsWith("/up") && (body as { plan?: boolean }).plan === false) {
          active++; entered++; maximum = Math.max(maximum, active);
          await new Promise<void>(resolve => waiting.push(resolve));
          active--;
        }
        return post(path, body, config as never);
      }) as typeof client.post;
      return client;
    } }));
    const run = captureLogs(async () => { await prog.parseAsync(["node", "rig", "start", "--all", "--json", ...(limit === 1 ? [] : ["--concurrency", "2"])]); });
    let early: { logs: string[]; exitCode: number | undefined } | undefined;
    void run.then(value => { early = value; });
    await vi.waitFor(() => { if (early) throw new Error(`start exited early: ${early.logs.join("; ")}`); expect(entered).toBe(limit); }, { timeout: 10000 });
    for (let count = limit + 1; count <= 3; count++) {
      (waiting.length > 1 ? waiting.splice(1, 1)[0]! : waiting.shift()!)();
      await vi.waitFor(() => expect(entered).toBe(count), { timeout: 10000 });
    }
    while (waiting.length) waiting.shift()!();
    const { logs, exitCode } = await run;
    expect(maximum).toBe(limit);
    expect(exitCode).toBeUndefined();
    const result = JSON.parse(logs.find(line => line.startsWith("{"))!);
    expect(result.restoredRigs.map((entry: { rigName: string }) => entry.rigName)).toEqual(["one", "two", "three"]);
  });

  it("starts the next request after a timeout and keeps results in selection order", async () => {
    routes["/api/rigs/summary"] = () => ["one", "two"].map((name, i) => ({ id: `rig-${i}`, name, lifecycleState: "recoverable" })) as never;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [] } : { status: "restored", rigResult: "fully_restored", nodes: [] };
    const calls: string[] = [], opts = deps(), prog = new Command();
    prog.addCommand(startCommand({ ...opts, clientFactory: url => {
      const client = new DaemonClient(url), post = client.post.bind(client);
      client.post = (async (path: string, body: unknown, config?: unknown) => {
        if (path.endsWith("/up") && (body as { plan?: boolean }).plan === false) {
          calls.push(path);
          if (path.includes("rig-0")) throw new (await import("../src/client.js")).DaemonConnectionError("timed out");
        }
        return post(path, body, config as never);
      }) as typeof client.post;
      return client;
    } }));
    const { logs, exitCode } = await captureLogs(async () => { await prog.parseAsync(["node", "rig", "start", "--all", "--json", "--concurrency", "1"]); });
    expect(calls).toEqual(["/api/rigs/rig-0/up", "/api/rigs/rig-1/up"]);
    expect(logs.join("\n")).toContain("Verify with: rig ps");
    expect(JSON.parse(logs.find(line => line.startsWith("{"))!).restoredRigs).toMatchObject([
      { rigName: "one", status: "timeout" }, { rigName: "two", status: "fully_restored" },
    ]);
    expect(exitCode).toBe(1);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects invalid concurrency %s before contacting the daemon", async value => {
    const options = deps();
    const clientFactory = vi.fn(options.clientFactory);
    const prog = new Command();
    prog.addCommand(startCommand({ ...options, clientFactory }));
    const { exitCode } = await captureLogs(async () => { await prog.parseAsync(["node", "rig", "start", "--last", `--concurrency=${value}`]); });
    expect(exitCode).toBe(1);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps other output out of a pending prompt and releases the queue when prompt throws=%s", async throws => {
    routes["/api/rigs/summary"] = () => ["one", "two"].map((name, i) =>
      ({ id: `rig-${i}`, name, nodeCount: 1, lifecycleState: "recoverable" })) as unknown as Record<string, unknown>;
    let secondReturned = false;
    routes["/api/rigs/:id/up"] = (_req, body) => {
      if (body.plan) return { status: "plan", mode: "restore", nodes: [], mutated: false };
      if (body._rigId === "rig-1") secondReturned = true;
      return { status: "restored", rigResult: "fully_restored", nodes: body._rigId === "rig-0"
        ? [{ logicalId: "dev.a", status: "awaiting-decision" }] : [] };
    };
    let release!: () => void;
    let prompting = false;
    const prompt = async () => {
      prompting = true;
      await new Promise<void>(resolve => { release = resolve; });
      if (throws) throw new Error("prompt failed");
      return false;
    };
    const logs: string[] = [];
    const run = captureLogs(async () => { await makeCmd(prompt).parseAsync(["node", "rig", "start", "--all", "--concurrency", "2"]); }, logs);
    await vi.waitFor(() => { expect(prompting).toBe(true); expect(secondReturned).toBe(true); });
    expect(logs.join("\n")).not.toContain("two: fully_restored");
    release();
    const result = await run;
    expect(result.logs.join("\n")).toContain("two: fully_restored");
    if (throws) expect(result.logs.join("\n")).toContain("prompt failed");
  });

  it("preserves a confirmed restore when its prompt fails", async () => {
    setupCandidateRig("one");
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.a", intendedAction: "resume-original" }] }
      : { status: "restored", rigResult: "partially_restored", nodes: [{ logicalId: "dev.a", status: "awaiting-decision" }, { logicalId: "dev.b", status: "fresh-primed" }], warnings: ["saved warning"] };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(async () => { throw new Error("prompt failed"); }).parseAsync(["node", "rig", "start", "--last", "--json"]);
    });
    const output = JSON.parse(logs.find(line => line.startsWith("{"))!);
    expect(output.restoredRigs[0]).toMatchObject({ status: "partially_restored", error: "prompt failed", warnings: ["saved warning"], nodes: [{ logicalId: "dev.a", status: "awaiting-decision" }, { logicalId: "dev.b", status: "fresh-primed" }] });
    expect(exitCode).toBe(1);
  });


  it("fresh-primes only the selected logical seat in the named rig", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "rig-1", name: "one", nodeCount: 1, lifecycleState: "recoverable" },
      { id: "rig-2", name: "two", nodeCount: 1, lifecycleState: "recoverable" },
    ] as unknown as Record<string, unknown>;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", mode: "restore", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }], mutated: false }
      : { status: "restored", rigResult: "fully_restored", nodes: [] };
    await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@one"]); });
    const applies = upBodies.filter(body => body.plan === false);
    expect(applies).toHaveLength(2);
    expect(applies.find(body => body._rigIdRoute === "rig-1")).toMatchObject({ freshLogicalIds: ["dev.impl"] });
    expect(applies.find(body => body._rigIdRoute === "rig-2")).not.toHaveProperty("freshLogicalIds");
  });

  it.each(["dev.impl", "dev.missing@one", "dev.impl@absent"])("rejects unsafe fresh selector %s before any restore", async ref => {
    setupCandidateRig("one");
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", mode: "restore", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" },
        { logicalId: "dev.external", intendedAction: "leave-attached" }], mutated: false }
      : { status: "restored", rigResult: "fully_restored", nodes: [] };
    const { exitCode } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", ref]); });
    expect(exitCode).toBe(1);
    expect(upBodies.filter(body => body.plan === false)).toHaveLength(0);
  });

  it("rejects a fresh selector when two selected rigs share its name", async () => {
    routes["/api/rigs/summary"] = () => ["rig-1", "rig-2"].map(id =>
      ({ id, name: "same", nodeCount: 1, lifecycleState: "recoverable" })) as unknown as Record<string, unknown>;
    routes["/api/rigs/:id/up"] = () => ({ status: "plan", mode: "restore", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }], mutated: false });
    const { logs, exitCode } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@same"]); });
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toContain("same (rig-1), same (rig-2)");
    expect(upBodies.filter(body => body.plan === false)).toHaveLength(0);
  });

  it("accepts exact rig ids and deduplicates selectors without conflating identical logical ids", async () => {
    routes["/api/rigs/summary"] = () => ["rig-1", "rig-2"].map(id => ({ id, name: "same", lifecycleState: "recoverable" })) as never;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }] }
      : { status: "restored", rigResult: "fully_restored", nodes: [{ logicalId: "dev.impl", status: "fresh-primed" }] };
    await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@rig-1", "dev.impl@rig-1", "dev.impl@rig-2"]); });
    expect(upBodies.filter(b => b.plan === false).map(b => b.freshLogicalIds)).toEqual([["dev.impl"], ["dev.impl"]]);
  });

  it.each([false, true])("reports external and omitted fresh seats and daemon warnings (json=%s)", async json => {
    setupCandidateRig("one");
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }, { logicalId: "dev.external", intendedAction: "leave-attached" }] }
      : { status: "restored", rigResult: "fully_restored", nodes: [{ logicalId: "dev.external", status: "left_attached" }], warnings: ["snapshot omitted dev.impl"] };
    const { logs } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@one", "dev.external@one", ...(json ? ["--json"] : [])]); });
    if (json) {
      const result = JSON.parse(logs.at(-1)!);
      expect(result.restoredRigs[0]).toMatchObject({ freshRequestedNotApplied: ["dev.impl", "dev.external"], warnings: ["snapshot omitted dev.impl"] });
    } else {
      expect(logs.join(" ")).toContain("dev.external: fresh requested, not applied");
      expect(logs.join(" ")).toContain("dev.impl: fresh requested, not applied");
      expect(logs.join(" ")).toContain("snapshot omitted dev.impl");
    }
  });

  it("reports a selected rig that becomes running before restore as fresh not applied", async () => {
    setupCandidateRig("one"); let reads = 0;
    routes["/api/rigs/summary"] = () => [{ id: "rig-1", name: "one", lifecycleState: ++reads === 1 ? "recoverable" : "running" }] as never;
    const { logs } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@one", "--json"]); });
    expect(JSON.parse(logs.at(-1)!).restoredRigs[0]).toMatchObject({ status: "already_running", freshRequestedNotApplied: ["dev.impl"] });
    expect(upBodies.filter(b => b.plan === false)).toHaveLength(0);
  });

  it("with --last skips a running selected seat but still restores other rigs", async () => {
    routes["/api/rigs/summary"] = () => [{ id: "rig-1", name: "one", lifecycleState: "running" }, { id: "rig-2", name: "two", lifecycleState: "recoverable" }] as never;
    routes["/api/rigs/:id/nodes"] = () => [{ logicalId: "dev.impl", sessionStatus: "detached", intentionallyStopped: false }] as never;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }] }
      : { status: "restored", rigResult: "fully_restored", nodes: [{ logicalId: "dev.impl", status: "resumed" }] };
    const { logs } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last", "--fresh", "dev.impl@one", "--json"]); });
    expect(JSON.parse(logs.at(-1)!).skippedFresh).toMatchObject([{ logicalId: "dev.impl", reason: "rig already running" }]);
    expect(upBodies.filter(b => b.plan === false).map(b => b._rigIdRoute)).toEqual(["rig-2"]);
  });

  it("labels a skipped fresh seat by rig id when another rig shares its name", async () => {
    routes["/api/rigs/summary"] = () => [{ id: "rig-1", name: "same", lifecycleState: "running" }, { id: "rig-2", name: "same", lifecycleState: "recoverable" }] as never;
    routes["/api/rigs/:id/nodes"] = () => [{ logicalId: "dev.impl", sessionStatus: "detached", intentionallyStopped: false }] as never;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }] }
      : { status: "restored", rigResult: "fully_restored", nodes: [] };
    const { logs } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last", "--fresh", "dev.impl@rig-1"]); });
    expect(logs.join("\n")).toContain("dev.impl@same (rig-1): fresh requested, not applied");
    expect(logs.join("\n")).toContain("same (rig-2): fully_restored");
  });

  it("keeps a confirmed restore when an accepted follow-up launch throws", async () => {
    setupCandidateRig("one");
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }, { logicalId: "dev.qa", intendedAction: "resume-original" }] }
      : { status: "restored", rigResult: "partially_restored", nodes: [{ logicalId: "dev.impl", status: "fresh-primed" }, { logicalId: "dev.qa", status: "awaiting-decision" }] };
    const options = deps(async () => true), prog = new Command();
    prog.addCommand(startCommand({ ...options, clientFactory: url => {
      const client = new DaemonClient(url), post = client.post.bind(client);
      client.post = (async (path: string, body: unknown, config?: unknown) => {
        if (path.startsWith("/api/seat/launch/")) throw new Error("connection closed");
        return post(path, body, config as never);
      }) as typeof client.post;
      return client;
    } }));
    const { logs } = await captureLogs(async () => { await prog.parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@one", "--json"]); });
    const result = JSON.parse(logs.find(line => line.startsWith("{"))!).restoredRigs;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rigId: "rig-1", status: "partially_restored", nodes: [{ logicalId: "dev.impl", status: "fresh-primed" }, { logicalId: "dev.qa", status: "awaiting-decision" }], followUpFailures: [{ logicalId: "dev.qa", error: "connection closed" }] });
    expect(result[0].freshOutcomeUnknown).toBeUndefined();
  });

  it("with --last refuses an unknown seat in a running rig before restoring anything", async () => {
    routes["/api/rigs/summary"] = () => [{ id: "rig-1", name: "one", lifecycleState: "running" }, { id: "rig-2", name: "two", lifecycleState: "recoverable" }] as never;
    routes["/api/rigs/:id/nodes"] = () => [{ logicalId: "dev.real", sessionStatus: "detached", intentionallyStopped: false }] as never;
    routes["/api/rigs/:id/up"] = () => ({ status: "plan", nodes: [{ logicalId: "dev.real", intendedAction: "resume-original" }] });
    const { exitCode } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last", "--fresh", "dev.missing@one"]); });
    expect(exitCode).toBe(1);
    expect(upBodies.filter(b => b.plan === false)).toHaveLength(0);
  });

  it("with --last reports a deliberately stopped rig and restores the others", async () => {
    setupStoppedRigs([DOWNED, CRASHED]);
    const { logs } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last", "--fresh", "dev.seat0@downed", "--json"]); });
    expect(JSON.parse(logs.at(-1)!).skippedFresh).toMatchObject([{ logicalId: "dev.seat0", reason: "rig stopped on purpose" }]);
    expect(upBodies.filter(b => b.plan === false).map(b => b._rigIdRoute)).toEqual(["rig-crashed"]);
  });

  it("distinguishes preview failure from an unknown seat in JSON before any restore", async () => {
    setupCandidateRig("one");
    routes["/api/rigs/:id/up"] = () => ({ _httpStatus: 503, code: "preview_broken", error: "database unavailable" });
    const { logs, exitCode } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@one", "--json"]); });
    expect(exitCode).toBe(1);
    expect(JSON.parse(logs.at(-1)!).error).toContain("database unavailable (preview_broken)");
    expect(upBodies.filter(b => b.plan === false)).toHaveLength(0);
  });

  it.each([false, true])("reports restore_error fresh outcome as unknown (json=%s)", async json => {
    setupCandidateRig("one");
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }] }
      : { _httpStatus: 400, code: "restore_error", error: "completion record failed" };
    const { logs, exitCode } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@one", ...(json ? ["--json"] : [])]); });
    expect(exitCode).toBe(1);
    if (json) {
      const result = JSON.parse(logs.at(-1)!).restoredRigs[0];
      expect(result).toMatchObject({ rigId: "rig-1", status: "restore_error", freshOutcomeUnknown: ["dev.impl"] });
      expect(result.freshRequestedNotApplied).toBeUndefined();
    } else {
      expect(logs.join(" ")).toContain("dev.impl: fresh outcome unknown");
      expect(logs.join(" ")).not.toContain("fresh requested, not applied");
    }
  });

  it.each([false, true])("identifies same-named rigs with distinct results (json=%s)", async json => {
    routes["/api/rigs/summary"] = () => ["rig-1", "rig-2"].map(id => ({ id, name: "same", lifecycleState: "recoverable" })) as never;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }] }
      : body._rigId === "rig-1" ? { status: "restored", rigResult: "fully_restored", nodes: [{ logicalId: "dev.impl", status: "fresh-primed" }] }
        : { _httpStatus: 409, code: "rig_not_stopped", error: "still running" };
    const { logs } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--all", "--fresh", "dev.impl@rig-1", "dev.impl@rig-2", ...(json ? ["--json"] : [])]); });
    if (json) expect(JSON.parse(logs.at(-1)!).restoredRigs).toMatchObject([{ rigId: "rig-1", status: "fully_restored" }, { rigId: "rig-2", status: "rig_not_stopped", freshRequestedNotApplied: ["dev.impl"] }]);
    else { expect(logs.join(" ")).toContain("same (rig-1): fully_restored"); expect(logs.join(" ")).toContain("same (rig-2): still running"); }
  });

  it.each([false, true])("skips an unverified agent on a running rig when its node lookup fails (json=%s)", async json => {
    routes["/api/rigs/summary"] = () => [{ id: "rig-1", name: "one", lifecycleState: "running" }, { id: "rig-2", name: "two", lifecycleState: "recoverable" }] as never;
    routes["/api/rigs/:id/nodes"] = (_req, body) => body._rigId === "rig-1" ? { _httpStatus: 503 } : [{ logicalId: "dev.impl", sessionStatus: "detached", intentionallyStopped: false }] as never;
    routes["/api/rigs/:id/up"] = (_req, body) => body.plan
      ? { status: "plan", nodes: [{ logicalId: "dev.impl", intendedAction: "resume-original" }] }
      : { status: "restored", rigResult: "fully_restored", nodes: [] };
    const { logs } = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last", "--fresh", "dev.impl@one", ...(json ? ["--json"] : [])]); });
    expect(upBodies.filter(b => b.plan === false).map(b => b._rigIdRoute)).toEqual(["rig-2"]);
    if (json) expect(JSON.parse(logs.at(-1)!).skippedFresh).toMatchObject([{ rigId: "rig-1", logicalId: "dev.impl", reason: expect.stringContaining("seat unverified") }]);
    else expect(logs.join(" ")).toContain("seat unverified");
  });

  it("--last restores all candidates with ZERO prompts", async () => {
    setupCandidateRig("my-rig");
    const prompt = vi.fn(async () => true);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(prompt).parseAsync(["node", "rig", "start", "--last"]);
    });
    expect(prompt).not.toHaveBeenCalled();
    const applyBodies = upBodies.filter((b) => b.plan !== true && b._rigIdRoute);
    expect(applyBodies.length).toBeGreaterThanOrEqual(1);
    expect(applyBodies[0]!._rigIdRoute).toBe("rig-1");
    const output = logs.join("\n");
    expect(output).toContain("my-rig");
  });

  // ---- --last respects `rig down` (S4-start-last-respects-down) ----

  // Stopped rigs with restore-usable snapshots. Each seat's /nodes entry carries what #1254
  // exposes: sessionStatus (null when never launched), storedSessionStatus and
  // intentionallyStopped (set by `rig down` and `rig seat stop`). An all-flagged rig's summary
  // reads lifecycleState "stopped"; restoreLifecycleState stays "recoverable", so it is a candidate.
  type SeatFixture = { logicalId?: string; sessionStatus?: unknown; storedSessionStatus?: unknown; intentionallyStopped?: unknown };
  type RigFixture = {
    id: string;
    name: string;
    seats: SeatFixture[];
    // Replaces the /nodes body for this rig; `{ _httpStatus: 404 }` answers 404.
    nodes?: () => unknown;
    // Answers the apply call instead of a clean restore.
    apply?: () => Record<string, unknown>;
  };
  const S = (status: string | null, flag: boolean): SeatFixture => ({ sessionStatus: status, storedSessionStatus: status, intentionallyStopped: flag });
  const allFlagged = (seats: SeatFixture[]) => seats.some((s) => s.sessionStatus !== null) && seats.every((s) => s.sessionStatus === null || s.intentionallyStopped === true);

  function setupStoppedRigs(rigs: RigFixture[]) {
    routes["/api/rigs/summary"] = () => rigs.map((r) => ({
      id: r.id, name: r.name, nodeCount: r.seats.length,
      lifecycleState: allFlagged(r.seats) ? "stopped" : "recoverable",
      restoreLifecycleState: "recoverable",
    })) as unknown as Record<string, unknown>;
    routes["/api/rigs/:id"] = () => ({ sessions: [] });
    routes["/api/rigs/:id/nodes"] = (_req, body) => {
      const rig = rigs.find((r) => r.id === body._rigId)!;
      if (rig.nodes) return rig.nodes() as Record<string, unknown>;
      return rig.seats.map((seat, i) => ({ logicalId: `dev.seat${i}`, ...seat })) as unknown as Record<string, unknown>;
    };
    routes["/api/rigs/:id/up"] = (_req, body) => {
      const rig = rigs.find((r) => r.id === body._rigId)!;
      if (body.plan === true) {
        return {
          status: "plan", mode: "restore", rigId: rig.id, rigName: rig.name,
          snapshot: { id: `snap-${rig.id}`, kind: "auto-pre-down", createdAt: "2026-06-14T11:00:00Z" },
          wouldCaptureCurrentState: false,
          nodes: [{ logicalId: "dev.seat0", intendedAction: "resume-original" }],
          mutated: false,
        };
      }
      if (rig.apply) return rig.apply();
      return { status: "restored", rigId: rig.id, rigName: rig.name, rigResult: "fully_restored", nodes: [{ logicalId: "dev.seat0", status: "resumed" }], warnings: [] };
    };
  }
  const rigFixture = (name: string, seats: SeatFixture[], extra?: Partial<RigFixture>): RigFixture => ({ id: `rig-${name}`, name, seats, ...extra });

  // A full `rig down`: every seat killed and flagged.
  const DOWNED = rigFixture("downed", [S("exited", true), S("exited", true)]);
  // `rig down` on a rig with one seat that was never launched.
  const DOWNED_UNLAUNCHED = rigFixture("downed-unlaunched", [S("exited", true), S(null, false)]);
  // tmux was lost; the boot reconciler marked each session detached.
  const CRASHED = rigFixture("crashed", [S("detached", false), S("detached", false)]);
  // Detached, then `rig down` with tmux absence confirmed: flagged and exited on the wire.
  const DETACHED_DOWN_OK = rigFixture("detached-down-ok", [S("exited", true), S("exited", true)]);
  // Detached, then `rig down` with the tmux probe unavailable: one seat left detached, unflagged.
  const DETACHED_DOWN_UNC = rigFixture("detached-down-unc", [S("exited", true), S("detached", false)]);
  // One seat flagged, one ordinary exit.
  const PARTIAL_EXIT = rigFixture("partial-exit", [S("exited", true), S("exited", false)]);
  // `rig down` whose kill failed for one seat: that seat stays live and unflagged.
  const PARTIAL_LIVE = rigFixture("partial-live", [S("exited", true), S("running", false)], {
    apply: () => ({ _httpStatus: 409, code: "rig_not_stopped", error: "Rig still has live sessions" }),
  });
  // A crash, a failed launch's cleanup, or `rig seat clean`: exited without the flag.
  const PLAIN_EXITED = rigFixture("plain-exited", [S("exited", false), S("exited", false)]);
  // A daemon before #1254: no intentionallyStopped key.
  const OLD_DAEMON = rigFixture("old-daemon", [{ sessionStatus: "exited" }, { sessionStatus: "exited" }]);

  const appliedRigIds = () => upBodies.filter((b) => b.plan !== true && b._rigIdRoute).map((b) => b._rigIdRoute);
  const jsonResult = (logs: string[]) => JSON.parse(logs.find((l) => l.trim().startsWith("{"))!);
  const runStart = (...args: string[]) => captureLogs(async () => {
    await makeCmd().parseAsync(["node", "rig", "start", ...args]);
  });

  // T1 unreadable-status
  it.each([
    ["an error object instead of the seat list", () => ({ error: "inventory unavailable" })],
    ["an entry with no sessionStatus key", () => [{ logicalId: "dev.seat0", storedSessionStatus: "exited", intentionallyStopped: true }, { logicalId: "dev.seat1", ...S("exited", true) }]],
    ["no inventory route (404)", () => ({ _httpStatus: 404 })],
    ["a non-boolean intentionallyStopped", () => [{ logicalId: "dev.seat0", ...S("exited", true), intentionallyStopped: "yes" }]],
  ])("--last restores a rig whose seat statuses are unreadable (%s) and warns about it, exit 0", async (_label, nodes) => {
    const unreadable = rigFixture("unreadable", [S("exited", true), S("exited", true)], { nodes });
    setupStoppedRigs([unreadable, CRASHED]);
    const { logs, exitCode } = await runStart("--last", "--json");
    expect(appliedRigIds().sort()).toEqual(["rig-crashed", "rig-unreadable"]);
    expect(exitCode).toBeUndefined();
    const parsed = jsonResult(logs);
    expect(parsed.status).toBe("started");
    expect(parsed.previewErrors).toBeUndefined();
    expect(parsed.warnings).toEqual([{
      rigId: "rig-unreadable", rigName: "unreadable", code: "seat_status_unreadable",
      message: "selected for restore because its seat statuses could not be read",
    }]);
    expect(parsed.keptDown).toEqual([]);

    upBodies = [];
    const human = await runStart("--last");
    expect(human.exitCode).toBeUndefined();
    expect(appliedRigIds().sort()).toEqual(["rig-crashed", "rig-unreadable"]);
    const output = human.logs.join("\n");
    expect(output).toContain("  unreadable: selected for restore because its seat statuses could not be read");
    expect(output).not.toContain("crashed: could not read");
  });

  it("--all still restores a rig whose seat statuses are unreadable, without reading them", async () => {
    setupStoppedRigs([rigFixture("unreadable", [S("exited", true)], { nodes: () => ({ error: "inventory unavailable" }) })]);
    const { logs, exitCode } = await runStart("--all", "--json");
    expect(appliedRigIds()).toEqual(["rig-unreadable"]);
    expect(exitCode).toBeUndefined();
    expect(jsonResult(logs).warnings).toBeUndefined();
    expect(nodesReads).toBe(0);
  });

  // T2 confirmed-deliberate-stop
  it.each([DOWNED, DOWNED_UNLAUNCHED])("--last keeps $name down and names the command that brings it back", async (rig) => {
    setupStoppedRigs([rig, CRASHED]);
    const { logs, exitCode } = await runStart("--last");
    expect(appliedRigIds()).toEqual(["rig-crashed"]);
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain(`  ${rig.name}: stopped on purpose (with rig down or rig seat stop), so --last leaves it down. Bring it back: rig start --rigs ${rig.name}`);

    upBodies = [];
    const json = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual(["rig-crashed"]);
    expect(json.exitCode).toBeUndefined();
    const parsed = jsonResult(json.logs);
    expect(parsed.status).toBe("started");
    expect(parsed.keptDown).toEqual([{ rigName: rig.name, restoreCommand: `rig start --rigs ${rig.name}` }]);
    expect(parsed.restoredRigs.map((r: { rigName: string }) => r.rigName)).toEqual(["crashed"]);
  });

  it("--last with only a downed rig restores nothing, says so, and exits 0", async () => {
    setupStoppedRigs([DOWNED]);
    const { logs, exitCode } = await runStart("--last");
    expect(appliedRigIds()).toEqual([]);
    expect(exitCode).toBeUndefined();
    const output = logs.join("\n");
    expect(output).toContain("  downed: stopped on purpose (with rig down or rig seat stop), so --last leaves it down. Bring it back: rig start --rigs downed");
    expect(output).toContain("No rigs selected for restore.");
    expect(output.indexOf("downed: stopped on purpose")).toBeLessThan(output.indexOf("No rigs selected"));

    const json = await runStart("--last", "--json");
    expect(json.exitCode).toBeUndefined();
    const parsed = jsonResult(json.logs);
    expect(parsed.status).toBe("started");
    expect(parsed.keptDown).toEqual([{ rigName: "downed", restoreCommand: "rig start --rigs downed" }]);
    expect(parsed.restoredRigs).toEqual([]);
  });

  // T3 detached-then-down
  it("--last keeps a detached rig down once rig down confirmed its sessions are gone", async () => {
    setupStoppedRigs([DETACHED_DOWN_OK]);
    const { logs } = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual([]);
    expect(jsonResult(logs).keptDown).toEqual([{ rigName: "detached-down-ok", restoreCommand: "rig start --rigs detached-down-ok" }]);
  });

  it("--last restores a rig with one seat stopped on purpose and one still detached", async () => {
    setupStoppedRigs([DETACHED_DOWN_UNC]);
    const { logs, exitCode } = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual(["rig-detached-down-unc"]);
    expect(exitCode).toBeUndefined();
    expect(jsonResult(logs).keptDown).toEqual([]);
  });

  // T4 failed-or-partial-stop
  it("--last restores a rig with one seat stopped on purpose and one ordinary exit", async () => {
    setupStoppedRigs([PARTIAL_EXIT]);
    const { logs, exitCode } = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual(["rig-partial-exit"]);
    expect(exitCode).toBeUndefined();
    expect(jsonResult(logs).keptDown).toEqual([]);
  });

  it("--last selects a rig whose rig down failed to kill a seat, and reports rig_not_stopped", async () => {
    setupStoppedRigs([PARTIAL_LIVE]);
    const { logs, exitCode } = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual(["rig-partial-live"]);
    expect(exitCode).toBe(1);
    const parsed = jsonResult(logs);
    expect(parsed.keptDown).toEqual([]);
    expect(parsed.restoredRigs).toEqual([{ rigId: "rig-partial-live", rigName: "partial-live", status: "rig_not_stopped", error: "Rig still has live sessions", nodes: [] }]);
  });

  // T5 no-CLI-memory
  it("--last decides from the seats on each run: a rig kept down once is restored once its seats are detached", async () => {
    const rig = rigFixture("flip", DOWNED.seats);
    setupStoppedRigs([rig]);
    const first = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual([]);
    expect(jsonResult(first.logs).keptDown).toEqual([{ rigName: "flip", restoreCommand: "rig start --rigs flip" }]);

    rig.seats = CRASHED.seats;
    const second = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual(["rig-flip"]);
    expect(jsonResult(second.logs).keptDown).toEqual([]);
  });

  // T6 all-and-rigs-still-restore
  it("--all, --rigs and --all --last still restore a rig that was taken down", async () => {
    setupStoppedRigs([DOWNED, CRASHED]);
    const all = await runStart("--all", "--json");
    expect(appliedRigIds().sort()).toEqual(["rig-crashed", "rig-downed"]);
    expect(jsonResult(all.logs).keptDown).toBeUndefined();

    upBodies = [];
    await runStart("--rigs", "downed");
    expect(appliedRigIds()).toEqual(["rig-downed"]);

    upBodies = [];
    const allLast = await runStart("--all", "--last", "--json");
    expect(appliedRigIds().sort()).toEqual(["rig-crashed", "rig-downed"]);
    expect(jsonResult(allLast.logs).keptDown).toBeUndefined();
  });

  // T7 last-only-fetch
  it("reads /nodes only under --last: never for --all, --rigs or the interactive path", async () => {
    setupStoppedRigs([DOWNED, CRASHED]);
    await runStart("--all");
    expect(nodesReads).toBe(0);
    await runStart("--rigs", "downed");
    expect(nodesReads).toBe(0);
    await captureLogs(async () => {
      await makeCmd(async () => false).parseAsync(["node", "rig", "start"]);
    });
    expect(nodesReads).toBe(0);
    await runStart("--last");
    expect(nodesReads).toBe(2);
  });

  // T8 pure-exited-restores
  it.each([PLAIN_EXITED, OLD_DAEMON])("--last restores $name (exited without a recorded stop intent), with no warning", async (rig) => {
    setupStoppedRigs([rig]);
    const { logs, exitCode } = await runStart("--last", "--json");
    expect(appliedRigIds()).toEqual([rig.id]);
    expect(exitCode).toBeUndefined();
    const parsed = jsonResult(logs);
    expect(parsed.status).toBe("started");
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.keptDown).toEqual([]);
  });

  it("lastStopState: down only when every launched seat carries the recorded stop intent", () => {
    const table: Array<[string, unknown, string]> = [
      ["DOWNED", DOWNED.seats, "down"],
      ["DOWNED_UNLAUNCHED", DOWNED_UNLAUNCHED.seats, "down"],
      ["CRASHED", CRASHED.seats, "was_running"],
      ["DETACHED_DOWN_OK", DETACHED_DOWN_OK.seats, "down"],
      ["DETACHED_DOWN_UNC", DETACHED_DOWN_UNC.seats, "was_running"],
      ["PARTIAL_EXIT", PARTIAL_EXIT.seats, "was_running"],
      ["PARTIAL_LIVE", PARTIAL_LIVE.seats, "was_running"],
      ["PLAIN_EXITED", PLAIN_EXITED.seats, "was_running"],
      ["OLD_DAEMON", OLD_DAEMON.seats, "was_running"],
      ["never launched", [S(null, false), S(null, false)], "was_running"],
      ["no seats", [], "was_running"],
      ["error object", { error: "inventory unavailable" }, "unknown"],
      ["undefined", undefined, "unknown"],
      ["null entry", [null], "unknown"],
      ["entry without sessionStatus", [{ intentionallyStopped: true }], "unknown"],
      ["non-boolean intentionallyStopped", [{ sessionStatus: "exited", intentionallyStopped: "yes" }], "unknown"],
    ];
    expect(table.map(([label, nodes]) => [label, lastStopState(nodes)])).toEqual(table.map(([label, , want]) => [label, want]));
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
    routes["/api/rigs/:id/up"] = (_req, body) => {
      if (body.plan === true) {
        return {
          status: "plan", mode: "restore", rigId: body._rigId ?? "rig-x", rigName: "rig",
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
    const applyBodies = upBodies.filter((b) => b.plan !== true && b._rigIdRoute);
    expect(applyBodies).toHaveLength(1);
    expect(applyBodies[0]!._rigIdRoute).toBe("rig-1");
  });

  // ---- COMPOSE, NOT REIMPLEMENT ----

  it("restore goes through /api/rigs/:id/up (id-based route), not a private implementation", async () => {
    setupCandidateRig("my-rig");
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const applyBodies = upBodies.filter((b) => b.plan !== true && b._rigIdRoute);
    expect(applyBodies.length).toBeGreaterThanOrEqual(1);
    expect(applyBodies.some((b) => b._rigIdRoute === "rig-1")).toBe(true);
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

  it("#1332 each seat left awaiting a decision gets a one-seat command for exactly that seat, dotted legacy ids included", async () => {
    setupCandidateRig("legacy-rig");
    const plan = routes["/api/rigs/:id/up"]!;
    // A partial restore: a sibling runs, so `rig up --existing ... --fresh` would be refused for these seats.
    routes["/api/rigs/:id/up"] = (req, body) => body.plan === true ? plan(req, body) : {
      status: "restored", rigId: "rig-1", rigName: "legacy-rig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "orch.lead", status: "resumed" },
        { logicalId: "dev.ops.impl", status: "awaiting-decision" },
        { logicalId: "dev.ops-impl", status: "awaiting-decision" },
      ],
      warnings: [],
    };
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    expect(output).toContain(`dev.ops.impl: awaiting-decision -- to fresh-prime: rig seat launch dev.ops.impl@legacy-rig --fresh --reason "fresh-prime after restore"`);
    expect(output).toContain(`dev.ops-impl: awaiting-decision -- to fresh-prime: rig seat launch dev.ops-impl@legacy-rig --fresh --reason "fresh-prime after restore"`);
    expect(output).not.toContain("rig up --existing");
  });

  it("#1332 answering y after a partial restore starts that one seat fresh, not a second whole-rig restore", async () => {
    setupCandidateRig("legacy-rig");
    const plan = routes["/api/rigs/:id/up"]!;
    routes["/api/rigs/:id/up"] = (req, body) => body.plan === true ? plan(req, body) : {
      status: "restored", rigId: "rig-1", rigName: "legacy-rig", rigResult: "partially_restored",
      nodes: [{ logicalId: "orch.lead", status: "resumed" }, { logicalId: "dev.ops.impl", status: "awaiting-decision", error: "no token available" }],
      warnings: [],
    };
    routes["/api/seat/launch/:seat"] = () => ({ ok: true, sessionName: "dev-ops.impl@legacy-rig" });
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "start", "--last"]);
    });
    expect(launches).toEqual([{ seat: "dev.ops.impl@legacy-rig", body: { fresh: true, reason: "fresh-prime after restore" } }]);
    expect(upBodies.filter((b) => b.plan !== true && Array.isArray(b.freshLogicalIds))).toEqual([]);
    expect(logs.join("\n")).toContain("dev.ops.impl: fresh-primed (dev-ops.impl@legacy-rig)");
  });

  it("with --json, a refused one-seat launch after y still reaches stderr", async () => {
    setupCandidateRig("legacy-rig");
    const plan = routes["/api/rigs/:id/up"]!;
    routes["/api/rigs/:id/up"] = (req, body) => body.plan === true ? plan(req, body) : {
      status: "restored", rigId: "rig-1", rigName: "legacy-rig", rigResult: "partially_restored",
      nodes: [{ logicalId: "orch.lead", status: "resumed" }, { logicalId: "dev.ops.impl", status: "awaiting-decision", error: "no token available" }],
      warnings: [],
    };
    routes["/api/seat/launch/:seat"] = () => ({ _httpStatus: 409, ok: false, code: "seat_live", message: "The seat's pane is still running." });
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "start", "--last", "--json"]);
    });
    expect(launches).toHaveLength(1);
    expect(logs.join("\n")).toContain("dev.ops.impl: not started -- The seat's pane is still running.");
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

  describe.each([
    { flag: "--last", args: ["--last"] },
    { flag: "--rigs", args: ["--rigs", "on-demand"] },
  ])("intentional stop with $flag", ({ args }) => {
    it("lists the rig and reports rig_not_stopped even when its display is healthy", async () => {
      setupCandidateRig("on-demand");
      routes["/api/rigs/summary"] = () => [{
        id: "rig-1", name: "on-demand", nodeCount: 2,
        lifecycleState: "running", restoreLifecycleState: "degraded",
      }];
      const preview = routes["/api/rigs/:id/up"]!;
      routes["/api/rigs/:id/up"] = (req, body) => body.plan === true ? preview(req, body) : {
        _httpStatus: 409, code: "rig_not_stopped", error: "Rig still has live sessions",
      };

      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "start", ...args, "--json"]);
      });
      expect(exitCode).toBe(1);
      const result = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      expect(result.candidates).toEqual([{ rigName: "on-demand", lifecycleState: "degraded" }]);
      expect(result.restoredRigs).toEqual([{ rigId: "rig-1", rigName: "on-demand", status: "rig_not_stopped", error: "Rig still has live sessions", nodes: [] }]);
      expect(upBodies.map((body) => body.plan)).toEqual([true, false]);
    });

    it("still skips a rig that becomes fully running after the preview", async () => {
      setupCandidateRig("on-demand");
      let reads = 0;
      routes["/api/rigs/summary"] = () => [{
        id: "rig-1", name: "on-demand", nodeCount: 2, lifecycleState: "running",
        restoreLifecycleState: ++reads === 1 ? "degraded" : "running",
      }];

      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "start", ...args, "--json"]);
      });
      expect(exitCode ?? 0).toBe(0);
      const result = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      expect(result.candidates).toEqual([{ rigName: "on-demand", lifecycleState: "degraded" }]);
      expect(result.restoredRigs).toEqual([{ rigId: "rig-1", rigName: "on-demand", status: "already_running", nodes: [] }]);
      expect(upBodies.map((body) => body.plan)).toEqual([true]);
    });
  });

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
      // Apply now uses the id-based route; throw on any non-plan POST to /api/rigs/:id/up.
      if (path.match(/^\/api\/rigs\/[^/]+\/up$/) && b?.plan !== true) {
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
    routes["/api/rigs/:id/up"] = (_req, body) => {
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

  // ---- SAME-NAME RIG CANDIDATE DISCOVERY (guard BLOCKING f359e3a3) ----

  it("two stopped rigs with the same name are BOTH listed as candidates (id-grounded preview, no ambiguous_name drop)", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "rig-1", name: "foo", nodeCount: 1, lifecycleState: "detached" },
      { id: "rig-2", name: "foo", nodeCount: 1, lifecycleState: "detached" },
    ];
    routes["/api/rigs/:id"] = () => ({ sessions: [] });
    routes["/api/rigs/:id/up"] = (_req, body) => {
      if (body.plan === true || body._rigId) {
        if (body.plan === true) {
          return {
            status: "plan", mode: "restore",
            rigId: body._rigId ?? "unknown", rigName: "foo",
            snapshot: { id: "s1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
            wouldCaptureCurrentState: false,
            nodes: [{ logicalId: "w", intendedAction: "resume-original" }],
            mutated: false,
          };
        }
        return {
          status: "restored", rigResult: "fully_restored",
          nodes: [{ logicalId: "w", status: "resumed" }],
          warnings: [],
        };
      }
      return {
        status: "restored", rigResult: "fully_restored",
        nodes: [{ logicalId: "w", status: "resumed" }],
        warnings: [],
      };
    };
    // Name-based /api/up would return ambiguous_name 409 for same-name rigs;
    // rig start should never reach this path for restore since it uses id-based route.
    routes["/api/up"] = () => ({
      _httpStatus: 409,
      error: 'Multiple rigs named "foo" found',
      code: "ambiguous_name",
    } as never);

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--all"]);
    });
    const output = logs.join("\n");
    // Both should appear — never "No rigs to restore".
    expect(output).not.toContain("No rigs to restore");
    expect(output).not.toContain("ambiguous_name");
    // The id-based route was used for both preview AND apply.
    const idBodies = upBodies.filter((b) => b._rigIdRoute);
    expect(idBodies.length).toBeGreaterThanOrEqual(4); // 2 plan + 2 apply
    expect(idBodies.some((b) => b._rigIdRoute === "rig-1")).toBe(true);
    expect(idBodies.some((b) => b._rigIdRoute === "rig-2")).toBe(true);
    // Name-based /api/up was NOT called for restore.
    const nameBodies = upBodies.filter((b) => !b._rigIdRoute);
    expect(nameBodies).toHaveLength(0);
  });

  // ---- PREVIEW ERROR STATE (guard BLOCKING bfed4ce3) ----

  it("preview 500 error under --json -> JSON contains previewErrors + exit 1, not clean empty candidates", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "err-rig-1", name: "broken-rig", nodeCount: 1, lifecycleState: "detached" },
    ];
    routes["/api/rigs/:id"] = () => ({ sessions: [] });
    routes["/api/rigs/:id/up"] = () => ({
      _httpStatus: 500,
      error: "internal server error",
      code: "restore_error",
    });

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--all", "--json"]);
    });
    const jsonLine = logs.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe("started_with_errors");
    expect(parsed.previewErrors).toBeDefined();
    expect(parsed.previewErrors.length).toBe(1);
    expect(parsed.previewErrors[0].rigName).toBe("broken-rig");
    expect(parsed.previewErrors[0].code).toBe("restore_error");
    expect(parsed.candidates).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  it("mixed case: rig A restores cleanly + rig B preview 500 -> JSON started_with_errors + previewErrors + exit 1", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "rig-ok", name: "ok-rig", nodeCount: 1, lifecycleState: "detached" },
      { id: "rig-err", name: "err-rig", nodeCount: 1, lifecycleState: "detached" },
    ];
    routes["/api/rigs/:id"] = () => ({ sessions: [] });
    routes["/api/rigs/:id/up"] = (_req, body) => {
      if (body._rigId === "rig-ok") {
        return {
          status: "plan", mode: "restore", rigId: "rig-ok", rigName: "ok-rig",
          snapshot: { id: "s1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
          wouldCaptureCurrentState: false,
          nodes: [{ logicalId: "w", intendedAction: "resume-original" }],
          mutated: false,
        };
      }
      return { _httpStatus: 500, error: "internal server error", code: "restore_error" };
    };
    routes["/api/up"] = () => ({
      status: "restored", rigResult: "fully_restored",
      nodes: [{ logicalId: "w", status: "resumed" }],
      warnings: [],
    });

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--all", "--json"]);
    });
    const jsonLine = logs.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.status).toBe("started_with_errors");
    expect(parsed.previewErrors).toBeDefined();
    expect(parsed.previewErrors.some((e: { rigName: string }) => e.rigName === "err-rig")).toBe(true);
    expect(parsed.restoredRigs.some((r: { rigName: string }) => r.rigName === "ok-rig")).toBe(true);
    expect(exitCode).toBe(1);
  });

  // ---- LEFT-OUT RIGS: a 404 preview is named, never dropped ----

  // What the daemon answers when a rig's selected snapshot names older occupants and current state can't stand in.
  const STALE_404 = {
    _httpStatus: 404,
    error: "Rig \"rebooted\" exists but its restore snapshots name an older occupant and current DB state is insufficient for rehydrate. Start fresh with: rig up <spec-path>",
    code: "no_snapshot",
    blockers: ["node dev.c is pod-aware but has no persisted startup context or resume token"],
  };
  const detachedSeats = () => ["dev.a", "dev.b", "dev.c"].map((logicalId) => ({
    logicalId, sessionStatus: "detached", intentionallyStopped: false,
  })) as unknown as Record<string, unknown>;

  it("--last names a rig whose preview answers 404, with the daemon's code, message and blockers", async () => {
    routes["/api/rigs/summary"] = () => [{ id: "rig-h", name: "rebooted", nodeCount: 3, lifecycleState: "recoverable" }];
    routes["/api/rigs/:id/nodes"] = detachedSeats;
    routes["/api/rigs/:id/up"] = () => STALE_404;

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last"]);
    });
    const output = logs.join("\n");
    expect(output).toContain(`rebooted: left out, not restored -- ${STALE_404.error} (no_snapshot)`);
    expect(output).toContain(`    ${STALE_404.blockers[0]}`);
    expect(output).toContain("Daemon and kernel are up. No rig restored: 1 rig(s) left out (see above).");
    expect(output).not.toContain("No rigs to restore");
    // Which rigs restore and the exit code are unchanged: nothing was applied, and a left-out rig is not an error.
    expect(upBodies.filter((b) => b.plan !== true)).toHaveLength(0);
    expect(exitCode).toBeUndefined();
  });

  it("--last --json lists a 404 preview under leftOut, apart from previewErrors", async () => {
    routes["/api/rigs/summary"] = () => [{ id: "rig-h", name: "rebooted", nodeCount: 3, lifecycleState: "recoverable" }];
    routes["/api/rigs/:id/nodes"] = detachedSeats;
    routes["/api/rigs/:id/up"] = () => STALE_404;

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "start", "--last", "--json"]);
    });
    expect(logs.filter((line) => !line.startsWith("{"))).toEqual([]);
    const parsed = JSON.parse(logs.find((l) => l.startsWith("{"))!);
    expect(parsed).toMatchObject({ status: "started", candidates: [], keptDown: [], restoredRigs: [] });
    expect(parsed.leftOut).toEqual([{
      rigId: "rig-h", rigName: "rebooted", code: "no_snapshot", message: STALE_404.error, blockers: STALE_404.blockers,
    }]);
    expect(parsed.previewErrors).toBeUndefined();
    expect(exitCode).toBeUndefined();
  });

  it.each([
    ["never launched", () => [{ logicalId: "dev.a", sessionStatus: null }, { logicalId: "dev.b", sessionStatus: null }], true],
    ["seats unreadable", () => ({ _httpStatus: 503 }), false],
  ] as const)("a 404 rig whose seats are %s: neverLaunched only when every seat was read and none has run", async (_label, nodes, never) => {
    routes["/api/rigs/summary"] = () => [{ id: "rig-n", name: "scratch", nodeCount: 2, lifecycleState: "stopped" }];
    routes["/api/rigs/:id/nodes"] = nodes as never;
    routes["/api/rigs/:id/up"] = () => ({
      _httpStatus: 404, code: "no_snapshot",
      error: "Rig \"scratch\" exists but has no restore-usable snapshot and current DB state is insufficient for rehydrate. Start fresh with: rig up <spec-path>",
      blockers: ["rig has no persisted sessions to rehydrate"],
    });

    const human = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last"]); });
    const json = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last", "--json"]); });
    const output = human.logs.join("\n");
    const entry = JSON.parse(json.logs.find((l) => l.startsWith("{"))!).leftOut[0];
    expect(entry).toMatchObject({ rigId: "rig-n", rigName: "scratch", code: "no_snapshot", blockers: ["rig has no persisted sessions to rehydrate"] });
    if (never) {
      expect(entry.neverLaunched).toBe(true);
      expect(output).toContain("scratch: nothing to restore (none of its seats has ever run), left out.");
      expect(output).toContain("Daemon and kernel are up. No rigs to restore.");
      // Every left-out line goes to stderr, so automation that redirects stdout keeps all of them.
      const errors: string[] = [];
      const origLog = console.log, origErr = console.error;
      console.log = () => {};
      console.error = (...args: unknown[]) => errors.push(args.join(" "));
      try { await makeCmd().parseAsync(["node", "rig", "start", "--last"]); } finally { console.log = origLog; console.error = origErr; }
      expect(errors.join("\n")).toContain("scratch: nothing to restore (none of its seats has ever run), left out.");
    } else {
      // Unknown never reads as nothing: an unreadable seat list keeps the daemon's reason in full.
      expect(entry.neverLaunched).toBeUndefined();
      expect(output).toContain("scratch: left out, not restored -- ");
      expect(output).toContain("No rig restored: 1 rig(s) left out");
    }
    expect(human.exitCode).toBeUndefined();
    expect(json.exitCode).toBeUndefined();
  });

  it("a 5xx and a transport failure stay in previewErrors (exit 1), and a 404 beside them goes to leftOut", async () => {
    routes["/api/rigs/summary"] = () => [
      { id: "rig-5xx", name: "broken", nodeCount: 1, lifecycleState: "recoverable" },
      { id: "rig-net", name: "unreachable", nodeCount: 1, lifecycleState: "recoverable" },
      { id: "rig-h", name: "rebooted", nodeCount: 3, lifecycleState: "recoverable" },
    ];
    routes["/api/rigs/:id/nodes"] = detachedSeats;
    routes["/api/rigs/:id/up"] = (_req, body) => body._rigId === "rig-5xx"
      ? { _httpStatus: 503, code: "preview_broken", error: "database unavailable" }
      : STALE_404;
    const prog = new Command();
    prog.addCommand(startCommand({ ...deps(), clientFactory: (url) => {
      const client = new DaemonClient(url), post = client.post.bind(client);
      client.post = (async (path: string, body: unknown, config?: unknown) => {
        if (path === "/api/rigs/rig-net/up") throw new (await import("../src/client.js")).DaemonConnectionError("connection reset");
        return post(path, body, config as never);
      }) as typeof client.post;
      return client;
    } }));

    const { logs, exitCode } = await captureLogs(async () => { await prog.parseAsync(["node", "rig", "start", "--last", "--json"]); });
    const parsed = JSON.parse(logs.find((l) => l.startsWith("{"))!);
    expect(parsed.status).toBe("started_with_errors");
    expect(parsed.previewErrors).toEqual([
      { rigId: "rig-5xx", rigName: "broken", code: "preview_broken", message: "database unavailable" },
      { rigId: "rig-net", rigName: "unreachable", code: "transport_error", message: "connection reset" },
    ]);
    expect(parsed.leftOut.map((entry: { rigId: string }) => entry.rigId)).toEqual(["rig-h"]);
    expect(exitCode).toBe(1);
  });

  it("a normal candidate restores as before while a 404 rig beside it is named", async () => {
    setupCandidateRig("good-rig");
    routes["/api/rigs/summary"] = () => [
      { id: "rig-1", name: "good-rig", nodeCount: 2, lifecycleState: "recoverable" },
      { id: "rig-h", name: "rebooted", nodeCount: 3, lifecycleState: "recoverable" },
    ];
    const candidateUp = routes["/api/rigs/:id/up"]!;
    routes["/api/rigs/:id/up"] = (req, body) => body._rigId === "rig-h" ? STALE_404 : candidateUp(req, body);

    const human = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last"]); });
    const output = human.logs.join("\n");
    expect(output).toContain("rebooted: left out, not restored -- ");
    expect(output).toContain("good-rig: fully_restored");
    const json = await captureLogs(async () => { await makeCmd().parseAsync(["node", "rig", "start", "--last", "--json"]); });
    const parsed = JSON.parse(json.logs.find((l) => l.startsWith("{"))!);
    expect(parsed.status).toBe("started");
    expect(parsed.candidates).toEqual([{ rigName: "good-rig", lifecycleState: "recoverable" }]);
    expect(parsed.restoredRigs).toMatchObject([{ rigId: "rig-1", rigName: "good-rig", status: "fully_restored" }]);
    expect(parsed.leftOut).toMatchObject([{ rigId: "rig-h", rigName: "rebooted", code: "no_snapshot" }]);
    // Only good-rig was applied, once per run.
    expect(upBodies.filter((b) => b.plan === false).map((b) => b._rigIdRoute)).toEqual(["rig-1", "rig-1"]);
    expect(human.exitCode).toBeUndefined();
    expect(json.exitCode).toBeUndefined();
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
        // The seat is detached (what the summary above reports), so --last attempts the restore.
        if (method === "GET" && url.match(/^\/api\/rigs\/[^/]+\/nodes$/)) { res.writeHead(200).end(JSON.stringify([{ logicalId: "w", sessionStatus: "detached" }])); return; }
        if (method === "GET" && url.match(/^\/api\/rigs\/[^/]+$/)) { res.writeHead(200).end(JSON.stringify({ sessions: [] })); return; }
        const rigUpMatch2 = method === "POST" && url.match(/^\/api\/rigs\/([^/]+)\/up$/);
        if (rigUpMatch2) {
          upBodies.push({ ...body, _rigIdRoute: rigUpMatch2[1] });
          if (body.plan === true) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              status: "plan", mode: "restore", rigId: rigUpMatch2[1], rigName: "live-rig",
              snapshot: { id: "s1", kind: "auto-pre-down", createdAt: "2026-06-14T00:00:00Z" },
              wouldCaptureCurrentState: false,
              nodes: [{ logicalId: "w", intendedAction: "resume-original" }],
              mutated: false,
            }));
          } else {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Rig r1 has live sessions", code: "rig_not_stopped" }));
          }
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
        const nodesMatch3 = method === "GET" && url.match(/^\/api\/rigs\/([^/]+)\/nodes$/);
        if (nodesMatch3 && routes["/api/rigs/:id/nodes"]) { res.writeHead(200).end(JSON.stringify(routes["/api/rigs/:id/nodes"]!(req, { _rigId: nodesMatch3[1] }))); return; }
        if (method === "GET" && url.match(/^\/api\/rigs\/[^/]+$/)) { const h = routes["/api/rigs/:id"]; res.writeHead(200).end(JSON.stringify(h ? h(req, body) : { sessions: [] })); return; }
        if (method === "POST" && url === "/api/up") { upBodies.push(body); const h = routes["/api/up"]; const d = h ? h(req, body) : {}; res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(d)); return; }
        const rigUpRestore = method === "POST" && url.match(/^\/api\/rigs\/([^/]+)\/up$/);
        if (rigUpRestore) { upBodies.push({ ...body, _rigIdRoute: rigUpRestore[1] }); const h = routes["/api/rigs/:id/up"] ?? routes["/api/up"]; const d = h ? h(req, { ...body, _rigId: rigUpRestore[1] }) : {}; res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(d)); return; }
        res.writeHead(404).end();
      });
    });
  });

  it("partially_restored rigResult -> nonzero exit (not treated as clean)", async () => {
    setupCandidateRig("partial-rig");
    // Override both plan and apply to return partially_restored on apply.
    routes["/api/rigs/:id/up"] = (_req, body) => {
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

// S20 (r2 NOT-CLEAR at 95150982d, blocker repair): `rig start`'s daemon auto-start ran
// the pre-S20 predicate, converting env-sourced daemon.host (ENV_MAP ← OPENRIG_HOST —
// exactly the injected routing state a managed environment carries) into explicit bind
// intent. Equivalent coverage to the up-side pin: routing env creates NO intent and
// never crosses into the spawned daemon env.
describe("S20 — start auto-start: routing env never becomes bind intent", () => {
  it("env-sourced OPENRIG_HOST through rig start creates NO bind intent (no OPENRIG_BIND_HOST, routing scrubbed)", async () => {
    const { default: net } = await import("node:net");
    const { EventEmitter } = await import("node:events");
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), connect() { queueMicrotask(() => socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))); } });
    const socketSpy = vi.spyOn(net, "Socket").mockImplementation(function () { return socket as unknown as import("node:net").Socket; });
    const savedHost = process.env["OPENRIG_HOST"];
    process.env["OPENRIG_HOST"] = "100.64.55.66"; // the distinct-value discriminator
    let spawnedEnv: Record<string, string> = {};
    let daemonStarted = false;
    const lifecycleDeps: LifecycleDeps = {
      ...mockLifecycleDeps(),
      exists: vi.fn(() => false),
      spawn: vi.fn((_cmd, _args, opts) => {
        daemonStarted = true;
        spawnedEnv = (opts as { env: Record<string, string> }).env;
        // The pin's subject IS this env — abort the command here so the later
        // kernel/restore phases (real-URL polls, other pins' turf) never run.
        throw new Error("SENTINEL-CAPTURED");
      }),
      fetch: vi.fn(async (url: string) => {
        if (!daemonStarted) throw new Error(`refused:${url}`);
        return { ok: url.includes("/healthz") };
      }),
    };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(startCommand({
      lifecycleDeps,
      // The pin ends at the SPAWN ENV — abort the post-start flow immediately with a
      // sentinel so kernel/restore polling never runs (their loops are other pins' turf).
      clientFactory: () => ({
        post: vi.fn(async () => { throw new Error("SENTINEL-STOP"); }),
        get: vi.fn(async () => { throw new Error("SENTINEL-STOP"); }),
      }) as never,
      preflightExec: async (cmd: string) => (cmd === "tmux -V" ? "tmux 3.6a" : ""),
      promptYesNo: async () => false,
    }));
    try {
      await captureLogs(async () => {
        try { await prog.parseAsync(["node", "rig", "start", "--last"]); } catch { /* restore-path errors are not this pin */ }
      });
      expect(daemonStarted).toBe(true); // the auto-start branch actually ran
      expect(spawnedEnv["OPENRIG_BIND_HOST"]).toBeUndefined(); // no intent minted from routing env
      expect(spawnedEnv["OPENRIG_HOST"]).toBeUndefined();      // and the routing var never crosses
    } finally {
      socketSpy.mockRestore();
      if (savedHost === undefined) delete process.env["OPENRIG_HOST"];
      else process.env["OPENRIG_HOST"] = savedHost;
    }
  }, 30_000);
});
