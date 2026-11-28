import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pendingStartEndpoint, startDaemon, STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { SystemPreflight } from "../src/system-preflight.js";
import { acquireDaemonStartLock, finishStartReservation } from "../src/daemon-start-lock.js";
import { realDeps } from "../src/commands/daemon.js";
// Resolve the startup import before a fake clock can finish with no timer yet scheduled.
import "@openrig/daemon/instance-initialization";

// A start that hit its readiness deadline leaves its child running and its reservation naming it (#3315). The next
// ordinary `rig daemon start` finishes that start once the child is ready: it publishes daemon.json for exactly that
// child (or keeps a matching one) and retires that launch's reservation, with no spawn and no signal. Every PID here is
// fictional: liveness, start tokens and the listener are simulated, and kill/spawn are vi.fn.
const LAUNCHER = 4242;
const CHILD = 5151;
const TOKEN = "lstart:Sat Nov 28 02:26:30 2026";
const DB = "/srv/openrig-home/openrig.sqlite";
const BOOT = "boot-A";
const NS = "host";
const BIND = { mode: "explicit" as const, hosts: ["127.0.0.1"], tailscaleDetected: false };

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-start-finish-")); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const lockFile = () => path.join(home, "daemon-start.lock");
const header = () => JSON.stringify({ launcherPid: LAUNCHER, startedAt: "2026-11-28T02:26:29.000Z", bootId: BOOT }) + "\n";
const childRecord = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ childPid: CHILD, startToken: TOKEN, pidNamespace: NS, host: "127.0.0.1", port: 7433, ...extra }) + "\n";
/** What this CLI's start records, the database included. */
const reservation = () => header() + childRecord({ db: DB });
/** What an older CLI's start recorded (0.7.20 to 0.7.25): the child's identity, but no database. */
const olderReservation = () => header() + childRecord();
const descriptor = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pid: CHILD, port: 7433, host: "127.0.0.1", db: DB, startedAt: "2026-11-28T02:31:50.000Z", ...extra }, null, 2);
const opts = { port: 7433, db: DB, readinessWaitSeconds: 1 };

function setup(o: {
  lock?: string | null;
  state?: string;
  alive?: number[];
  token?: string;
  held?: boolean | { failure: string };
  listenerPid?: number;
  ready?: boolean;
} = {}) {
  if (o.lock !== null) fs.writeFileSync(lockFile(), o.lock ?? reservation());
  const files = new Map<string, string>();
  if (o.state !== undefined) files.set(STATE_FILE, o.state);
  const alive = new Set(o.alive ?? [CHILD]);
  const real = (p: string) => p.startsWith(home + path.sep);
  const liveness = (pid: number) => alive.has(pid) ? "alive" as const : "dead" as const;
  const deps: LifecycleDeps = {
    homeDir: home,
    acquireStartLock: vi.fn(() => acquireDaemonStartLock(home, { bootId: BOOT, bootedAtMs: Date.parse("2026-11-28T00:00:00Z"), processLiveness: liveness, pidNamespace: NS })),
    spawn: vi.fn(() => { throw new Error("test: spawn"); }),
    fetch: vi.fn(async (url: string) => {
      if (!url.startsWith("http://127.0.0.1:7433/") || o.ready === false) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { ok: true, json: async () => ({ pid: o.listenerPid ?? CHILD, bind: BIND }) };
    }),
    kill: vi.fn(() => true),
    readFile: (p) => real(p) ? (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null) : files.get(p) ?? null,
    writeFile: vi.fn((p: string, value: string) => { if (real(p)) fs.writeFileSync(p, value); else files.set(p, value); }),
    removeFile: vi.fn((p: string) => { if (real(p)) fs.rmSync(p, { force: true }); else files.delete(p); }),
    exists: (p) => real(p) ? fs.existsSync(p) : files.has(p),
    mkdirp: vi.fn(),
    openForAppend: () => 3,
    isProcessAlive: (pid) => alive.has(pid),
    processLiveness: liveness,
    pidNamespace: () => NS,
    bootId: () => BOOT,
    processStartToken: (pid) => pid === CHILD && alive.has(CHILD) ? o.token ?? TOKEN : undefined,
    finishStartReservation: vi.fn(finishStartReservation),
    databaseHeldBy: vi.fn(() => o.held ?? true),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return { deps, files, alive };
}

async function start(deps: LifecycleDeps, startOpts: Parameters<typeof startDaemon>[0] = opts) {
  const outcome = startDaemon(startOpts, deps).catch((error: Error) => error);
  await vi.runAllTimersAsync();
  return outcome;
}

const finishedArchives = () => fs.readdirSync(home).filter((name) => name.startsWith("daemon-start.lock.finished-"));

/** Nothing changed: no spawn or signal, no publication, and the reservation is where it was, as it was. */
function expectUntouched(f: ReturnType<typeof setup>, outcome: unknown, lock: string, reason: RegExp, state?: string) {
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toMatch(/already reserved/);
  expect((outcome as Error).message).toMatch(reason);
  expect(f.deps.spawn).not.toHaveBeenCalled();
  expect(f.deps.kill).not.toHaveBeenCalled();
  expect(f.deps.writeFile).not.toHaveBeenCalledWith(STATE_FILE, expect.anything());
  expect(f.files.get(STATE_FILE)).toBe(state);
  expect(fs.readFileSync(lockFile(), "utf8")).toBe(lock);
  expect(finishedArchives()).toEqual([]);
}

describe("an ordinary start finishes a start that ended pending", () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-11-28T03:30:00.000Z") }); });

  it("publishes daemon.json for the reserved child once it is ready, and retires that launch's reservation, with no spawn or signal", async () => {
    const f = setup();
    const raw = reservation();
    const outcome = await start(f.deps);
    expect(outcome).not.toBeInstanceOf(Error);
    const state = outcome as Awaited<ReturnType<typeof startDaemon>>;
    expect(state).toMatchObject({ pid: CHILD, port: 7433, host: "127.0.0.1", db: DB });
    expect(JSON.parse(f.files.get(STATE_FILE)!)).toEqual({ pid: CHILD, port: 7433, host: "127.0.0.1", db: DB, startedAt: "2026-11-28T03:30:00.000Z" });
    expect(state.finished).toMatchObject({ publication: "written", readiness: { verified: ["127.0.0.1"] } });
    expect(f.deps.spawn).not.toHaveBeenCalled();
    expect(f.deps.kill).not.toHaveBeenCalled();
    expect(f.deps.acquireStartLock).not.toHaveBeenCalled();
    expect(fs.existsSync(lockFile())).toBe(false);
    const archives = finishedArchives();
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, archives[0]!), "utf8")).toBe(raw);
    expect(state.finished?.reservation).toEqual({ retired: path.join(home, archives[0]!) });
    expect(fs.readdirSync(home).filter((name) => name.includes(".claim-"))).toEqual([]);
  });

  it("keeps a matching daemon.json written by hand and only retires an older CLI's reservation, once the child holds that database", async () => {
    // The field case: an older CLI's reservation records no database, and the operator published the descriptor by hand.
    const byHand = descriptor();
    const f = setup({ lock: olderReservation(), state: byHand });
    const outcome = await start(f.deps);
    expect(outcome).not.toBeInstanceOf(Error);
    const state = outcome as Awaited<ReturnType<typeof startDaemon>>;
    expect(state.finished).toMatchObject({ publication: "already-correct" });
    expect(f.files.get(STATE_FILE)).toBe(byHand);
    expect(f.deps.writeFile).not.toHaveBeenCalledWith(STATE_FILE, expect.anything());
    expect(f.deps.databaseHeldBy).toHaveBeenCalledWith(CHILD, DB);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(finishedArchives()).toHaveLength(1);
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });

  it("publishes for an older CLI's reservation with this start's database only when the child holds it open", async () => {
    const f = setup({ lock: olderReservation() });
    const outcome = await start(f.deps);
    expect(outcome).not.toBeInstanceOf(Error);
    expect(f.deps.databaseHeldBy).toHaveBeenCalledWith(CHILD, DB);
    expect(JSON.parse(f.files.get(STATE_FILE)!)).toMatchObject({ pid: CHILD, db: DB });
    expect(finishedArchives()).toHaveLength(1);
  });

  it.each([
    ["the child doesn't hold it", false, /does not hold .*openrig\.sqlite open/],
    ["that can't be read", { failure: "lsof isn't installed" }, /lsof isn't installed/],
  ] as const)("changes nothing for an older CLI's reservation when %s", async (_case, held, reason) => {
    const f = setup({ lock: olderReservation(), held });
    expectUntouched(f, await start(f.deps), olderReservation(), reason);
  });

  it("publishes over a leftover daemon.json whose PID is gone (an earlier daemon's crash), and says it replaced it", async () => {
    const leftover = descriptor({ pid: 6262, port: 7433, db: "/srv/openrig-home/openrig.sqlite", startedAt: "2026-11-27T22:00:00.000Z" });
    const f = setup({ state: leftover });
    const state = await start(f.deps) as Awaited<ReturnType<typeof startDaemon>>;
    expect(state.finished).toMatchObject({ publication: "written", replacedPid: 6262, reservation: { retired: expect.stringContaining(".finished-") } });
    expect(JSON.parse(f.files.get(STATE_FILE)!)).toEqual({ pid: CHILD, port: 7433, host: "127.0.0.1", db: DB, startedAt: "2026-11-28T03:30:00.000Z" });
    expect(f.deps.spawn).not.toHaveBeenCalled();
    expect(f.deps.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["is alive", { alive: [CHILD, 6262] }, descriptor({ pid: 6262 })],
    ["can't be inspected", { unknown: [6262] }, descriptor({ pid: 6262 })],
    ["is numbered in another pid namespace", {}, descriptor({ pid: 6262, pidNamespace: "pid:[4026532999]" })],
  ] as const)("changes nothing when daemon.json names another PID that %s", async (_case, o, state) => {
    const f = setup({ state, ...("alive" in o ? { alive: [...o.alive] } : {}) });
    if ("unknown" in o) {
      const liveness = f.deps.processLiveness!;
      f.deps.processLiveness = (pid) => pid === 6262 ? "unknown" : liveness(pid);
    }
    expectUntouched(f, await start(f.deps), reservation(), /daemon\.json names PID 6262, not child PID 5151/, state);
  });

  it("changes nothing when a leftover daemon.json changes before publication", async () => {
    const leftover = descriptor({ pid: 6262 });
    const f = setup({ state: leftover });
    const changed = descriptor({ pid: 7373 });
    f.deps.finishStartReservation = vi.fn((file: string, raw: string, publish: () => void) => {
      f.files.set(STATE_FILE, changed);
      return finishStartReservation(file, raw, publish);
    });
    expectUntouched(f, await start(f.deps), reservation(), /daemon\.json changed while this start checked the child/, changed);
  });

  it.each([
    ["names another port", descriptor({ port: 7444 }), /daemon\.json names port 7444/],
    ["names another database", descriptor({ db: "/elsewhere/openrig.sqlite" }), /daemon\.json names database \/elsewhere\/openrig\.sqlite/],
    ["names another pid namespace", descriptor({ pidNamespace: "pid:[4026532999]" }), /pid namespace/],
    ["has no valid start time", descriptor({ startedAt: "later" }), /start time/],
    ["can't be read", "{not json", /daemon\.json is present but unreadable/],
  ])("changes nothing when daemon.json %s", async (_case, state, reason) => {
    const f = setup({ state });
    expectUntouched(f, await start(f.deps), reservation(), reason, state);
  });

  it("changes nothing while the reservation's launcher is alive: that start may still publish", async () => {
    const f = setup({ alive: [LAUNCHER, CHILD] });
    expectUntouched(f, await start(f.deps), reservation(), /launcher PID 4242 is alive/);
    expect(f.deps.fetch).not.toHaveBeenCalled();
  });

  it("changes nothing when the reserved PID is now another process", async () => {
    const f = setup({ token: "lstart:Sat Nov 28 03:00:00 2026" });
    expectUntouched(f, await start(f.deps), reservation(), /PID 5151 is now another process/);
  });

  it("changes nothing when another process answers at the launch endpoint", async () => {
    const f = setup({ listenerPid: 6262 });
    expectUntouched(f, await start(f.deps), reservation(), /expected child PID 5151, observed 6262/);
  });

  it("finishes with the start's own grace when only a listener other than the launch endpoint stays uncertain, and names it", async () => {
    const f = setup();
    const bind = { ...BIND, hosts: ["127.0.0.1", "127.0.0.2"] };
    f.deps.fetch = vi.fn(async (url: string) => {
      if (url.startsWith("http://127.0.0.2:7433/")) throw new Error("connect ETIMEDOUT");
      return { ok: true, json: async () => ({ pid: CHILD, bind }) };
    });
    const state = await start(f.deps, { ...opts, readinessWaitSeconds: 30 }) as Awaited<ReturnType<typeof startDaemon>>;
    expect(state.finished).toMatchObject({ publication: "written", readiness: { unverified: ["127.0.0.2"] } });
    expect(finishedArchives()).toHaveLength(1);
  });

  it("changes nothing when the child isn't ready within the start's readiness budget, and keeps it running", async () => {
    const f = setup({ ready: false });
    expectUntouched(f, await start(f.deps), reservation(), /readiness is not confirmed/);
    expect(f.alive.has(CHILD)).toBe(true);
  });

  it("changes nothing for a reservation a stop kept after a shutdown it couldn't verify", async () => {
    const lock = reservation() + JSON.stringify({ retainedBy: "stop", reason: "not-exited", at: "2026-11-28T03:00:00.000Z" }) + "\n";
    const f = setup({ lock });
    expectUntouched(f, await start(f.deps), lock, /a 'rig daemon stop' kept it/);
  });

  it("changes nothing when another operation holds the reservation's claim", async () => {
    const f = setup();
    const claim = `${lockFile()}.claim-${fs.statSync(lockFile()).ino}`;
    fs.linkSync(lockFile(), claim);
    expectUntouched(f, await start(f.deps), reservation(), /held by another operation, or it changed/);
    expect(fs.existsSync(claim)).toBe(true);
  });

  it("finishes on a repeat after it published but couldn't move the reservation, keeping the descriptor it wrote", async () => {
    const f = setup();
    const link = fs.linkSync;
    const spy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (String(to).includes(".finished-")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return link(from, to);
    });
    const first = await start(f.deps) as Awaited<ReturnType<typeof startDaemon>>;
    expect(first.finished).toMatchObject({ publication: "written", reservation: { kept: expect.stringContaining(lockFile()) } });
    const written = f.files.get(STATE_FILE);
    expect(JSON.parse(written!)).toMatchObject({ pid: CHILD });
    expect(fs.readFileSync(lockFile(), "utf8")).toBe(reservation());
    spy.mockRestore();

    const second = await start(f.deps) as Awaited<ReturnType<typeof startDaemon>>;
    expect(second.finished).toMatchObject({ publication: "already-correct", reservation: { retired: expect.stringContaining(".finished-") } });
    expect(f.files.get(STATE_FILE)).toBe(written);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });

  it("retries retirement after the archive link succeeded but removing the reservation failed", async () => {
    const f = setup();
    const unlink = fs.unlinkSync;
    let failed = false;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file) === lockFile() && !failed) {
        failed = true;
        throw Object.assign(new Error("EIO: removing reservation"), { code: "EIO" });
      }
      return unlink(file);
    });
    const first = await start(f.deps) as Awaited<ReturnType<typeof startDaemon>>;
    expect(first.finished).toMatchObject({ publication: "written", reservation: { kept: expect.any(String) } });
    const published = f.files.get(STATE_FILE);
    expect(fs.existsSync(lockFile())).toBe(true);
    expect(finishedArchives()).toHaveLength(1);
    spy.mockRestore();
    const second = await start(f.deps) as Awaited<ReturnType<typeof startDaemon>>;
    expect(second.finished).toMatchObject({ publication: "already-correct", reservation: { retired: expect.any(String) } });
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(f.files.get(STATE_FILE)).toBe(published);
    expect(finishedArchives()).toHaveLength(1);
    expect(f.deps.spawn).not.toHaveBeenCalled();
    expect(f.deps.kill).not.toHaveBeenCalled();
  });

  it("does not replace a different file at the finished archive name", async () => {
    const f = setup();
    const archive = `${lockFile()}.finished-${fs.statSync(lockFile()).ino}`;
    fs.writeFileSync(archive, "another archive\n");
    const result = await start(f.deps) as Awaited<ReturnType<typeof startDaemon>>;
    expect(result.finished).toMatchObject({ publication: "written", reservation: { kept: expect.any(String) } });
    expect(fs.readFileSync(archive, "utf8")).toBe("another archive\n");
    expect(fs.readFileSync(lockFile(), "utf8")).toBe(reservation());
  });

  it("is an ordinary start afterwards: the published daemon is already running, and nothing spawns", async () => {
    const f = setup();
    expect(await start(f.deps)).not.toBeInstanceOf(Error);
    const after = await start(f.deps);
    expect(after).toBeInstanceOf(Error);
    expect((after as Error).message).toMatch(/Daemon already running \(pid 5151 on port 7433\)/);
    expect(f.deps.spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(lockFile())).toBe(false);
  });
});

describe("the start that ends pending", () => {
  it("records its database in the child record, and the next start finishes it once the child is ready", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-28T02:26:29.000Z") });
    const f = setup({ lock: null });
    const child = Object.assign(new EventEmitter(), { pid: CHILD, exitCode: null, signalCode: null, unref: vi.fn() }) as unknown as ChildProcess;
    let spawned = false;
    let ready = false;
    f.deps.spawn = vi.fn(() => { spawned = true; return child; });
    f.deps.fetch = vi.fn(async () => {
      if (!spawned || !ready) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { ok: true, json: async () => ({ pid: CHILD, bind: BIND }) };
    });
    // This test's own process is the launcher; once its start has returned, the reservation's launcher reads as exited.
    let launcherExited = false;
    f.deps.processLiveness = (pid) => pid === CHILD ? "alive" : pid === process.pid && !launcherExited ? "alive" : "dead";

    const pending = await start(f.deps);
    expect(pending).toBeInstanceOf(Error);
    expect((pending as Error).message).toMatch(/pending after the readiness deadline \(child PID 5151\)/);
    expect((pending as Error).message).toContain("Once child PID 5151 is ready, run 'rig daemon start' again to finish this start");
    const lines = fs.readFileSync(lockFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[1]).toMatchObject({ childPid: CHILD, startToken: TOKEN, pidNamespace: NS, host: "127.0.0.1", port: 7433, db: DB });

    launcherExited = true;
    ready = true;
    const finished = await start(f.deps) as Awaited<ReturnType<typeof startDaemon>>;
    expect(finished.finished).toMatchObject({ publication: "written", reservation: { retired: expect.stringContaining(".finished-") } });
    expect(JSON.parse(f.files.get(STATE_FILE)!)).toMatchObject({ pid: CHILD, port: 7433, db: DB });
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect(f.deps.databaseHeldBy).not.toHaveBeenCalled(); // the reservation names its database
  });
});

describe("the database-holder check an older reservation's finish relies on", () => {
  it("answers from the process's own open files, and reports a process it can't list as unread, never as not holding it", () => {
    const check = realDeps().databaseHeldBy!;
    const held = path.join(home, "held.sqlite"), other = path.join(home, "other.sqlite");
    fs.writeFileSync(held, ""); fs.writeFileSync(other, "");
    const fd = fs.openSync(held, "r");
    try {
      expect(check(process.pid, held)).toBe(true);
      expect(check(process.pid, other)).toBe(false);
      // A process that has exited: whatever lsof answers (exit 1, or not installed), it's a failure, not "not held".
      const gone = spawnSync(process.execPath, ["-e", ""]).pid;
      expect(check(gone, held)).toEqual({ failure: expect.any(String) });
    } finally {
      fs.closeSync(fd);
    }
  });
});

// The reviewer's transition probe (R2-F1): a real listener on the port that isn't OpenRig, the production reservation
// read and reclaim, and a spawn spy. Start's preflight lets the reserved child's port through; the child then dies before
// the finish, so the reservation is reclaimed and the start falls through to an ordinary start. No spawn may follow.
describe("a reservation whose child dies after preflight let its port through", () => {
  it.each([false, true])("never spawns onto the occupied port (a dead daemon's daemon.json too: %s)", async (withState) => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const f = setup(withState ? { state: descriptor({ pid: 999 }) } : {});
    fs.writeFileSync(lockFile(), header() + childRecord({ port, db: DB }));
    const live = realDeps();
    f.deps.fetch = vi.fn(live.fetch);
    f.deps.isPortOccupied = vi.fn(live.isPortOccupied!);
    const preflight = new SystemPreflight({
      exec: async (cmd) => cmd === "tmux list-sessions" ? "" : "tmux 3.6a",
      configStore: { resolve: () => ({ daemon: { host: "127.0.0.1", port }, db: { path: path.join(home, "db.sqlite") }, transcripts: { path: home } }) } as never,
      getDaemonStatus: async () => ({ state: withState ? "stale" : "unverified" }),
      pendingStart: () => pendingStartEndpoint(f.deps), openrigHome: home,
    });
    try {
      expect((await preflight.run({ host: "127.0.0.1", port })).ready).toBe(true);
      f.alive.delete(CHILD);
      const outcome = await startDaemon({ ...opts, port }, f.deps).catch((error: Error) => error);
      expect(f.deps.spawn).not.toHaveBeenCalled();
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/already in use|EADDRINUSE|occupied/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
