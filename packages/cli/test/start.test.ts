// OPR.0.3.4.1 — rig start: one-command recovery orchestrator tests.
// Tests verify composition (slice-02 /api/up called, never private restore),
// headless flags, honest reporting, kernel invariant, and idempotency.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { startCommand, lastStopState } from "../src/commands/start.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

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

  afterAll(() => { server.close(); });

  beforeEach(() => {
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
    expect(parsed.restoredRigs).toEqual([{ rigName: "partial-live", status: "rig_not_stopped", nodes: [] }]);
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
      expect(result.restoredRigs).toEqual([{ rigName: "on-demand", status: "rig_not_stopped", nodes: [] }]);
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
      expect(result.restoredRigs).toEqual([{ rigName: "on-demand", status: "already_running", nodes: [] }]);
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
      if (savedHost === undefined) delete process.env["OPENRIG_HOST"];
      else process.env["OPENRIG_HOST"] = savedHost;
    }
  }, 30_000);
});
