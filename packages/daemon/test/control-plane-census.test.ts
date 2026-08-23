// OPR.0.5.3.10 mini-req 5 — deterministic invocation-counting discriminators.
// Each test pins "how many times did the underlying process enumeration run"
// across a full cycle. At base (pre-correction) these counts were per-seat and
// per-attempt: the divergence poll spawned one `ps` PER SEAT, the snapshot
// refresh up to EIGHT per codex seat — the measured control-plane collapse
// (171 list_processes spans, mean 9.39s; 298 resolve_home spans, mean 8.24s).
import { describe, it, expect, vi } from "vitest";
import { ProcessCensus } from "../src/domain/process-census.js";
import { ModelDivergenceMonitor } from "../src/domain/model-divergence/model-divergence-monitor.js";
import { resolveLiveCodexThreadId } from "../src/domain/model-divergence/current-generation-record.js";
import { CodexThreadIdResolver } from "../src/domain/codex-thread-id.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const ROWS = [{ pid: 10, ppid: 1, command: "zsh" }];

function advancingClock(step = 60_000): () => number {
  let t = 0;
  return () => (t += step);
}

describe("OPR.0.5.3.10 — one census per cycle", () => {
  it("mini-req 1: a divergence pass over THREE pinned seats runs the underlying enumeration ONCE", async () => {
    const underlying = vi.fn(async () => ROWS);
    // freshness defeated by the advancing clock: only the cycle memo can dedupe.
    const census = new ProcessCensus({ list: underlying, freshnessMs: 0, now: advancingClock() });
    const seats = ["a", "b", "c"].map((id) => ({
      nodeId: `n-${id}`, rigId: "r", rigName: "rig", runtime: "codex",
      pinnedModel: "gpt-x", sessionName: `${id}@rig`, generation: `gen-${id}`,
    }));
    const monitor = new ModelDivergenceMonitor({
      processCensus: census,
      listPinnedSeats: () => seats,
      // Mirrors the startup closure's shape: the cycle lister when threaded,
      // a per-seat enumeration otherwise (the BASE behavior — at base this
      // test counts 3, which is the discriminator).
      readEffectiveModel: async (seat, cycle) => {
        const live = await resolveLiveCodexThreadId(seat.sessionName, {
          getPanePid: async () => 10,
          listProcesses: cycle ? cycle.listProcesses : () => census.list(),
          readThreadIdByPid: () => undefined,
        });
        return live.ok ? { ok: true, model: "gpt-x" } : { ok: false, reason: live.reason };
      },
      sendToSession: async () => ({ ok: true }),
      resolveOrchSeats: () => [],
      resolveOperatorSeat: () => null,
      resolveOversightSeat: () => null,
      recordProclamation: () => {},
    });
    await monitor.checkOnce();
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("mini-req 2: a snapshot tick over TWO rigs with codex seats runs the underlying enumeration ONCE, single-attempt", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    for (const rigName of ["rig-a", "rig-b"]) {
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", cwd: "/w" });
      const session = sessionRegistry.registerSession(node.id, `dev-qa@${rigName}`);
      sessionRegistry.updateStatus(session.id, "running");
    }

    const underlying = vi.fn(async () => ROWS);
    const census = new ProcessCensus({ list: underlying, freshnessMs: 0, now: advancingClock() });
    const getPanePid = vi.fn(async () => 10);
    const sleep = vi.fn(async () => {});
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: { getPanePid } as unknown as TmuxAdapter,
      // The instance lister COUNTS too: if the tick bypassed the census and fell
      // back here, the count assertion below catches it.
      listProcesses: () => { throw new Error("tick must use the cycle census, not the instance lister"); },
      readCodexThreadIdByPid: () => undefined,
      sleep,
    });
    const scheduler = new PeriodicSnapshotScheduler({
      db,
      snapshotCapture: { captureSnapshot: () => {} } as never,
      snapshotRepo: { pruneSnapshotsByKind: () => {} } as never,
      sessionRegistry,
      resumeMetadataRefresher: refresher,
      processCensus: census,
    });
    await scheduler.tick();
    // ONE enumeration for both rigs' seats…
    expect(underlying).toHaveBeenCalledTimes(1);
    // …and SINGLE-ATTEMPT discovery: no inter-attempt sleeps at all (base ran
    // the 8-attempt loop: 7+ sleeps per tokenless codex seat).
    expect(sleep).not.toHaveBeenCalled();
    // Each seat's pane was probed exactly once.
    expect(getPanePid).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("addendum: default-home thread-id hit spawns ZERO pid-home resolutions; a non-default home is resolved once then cached; failure is never cached", async () => {
    // Default-home hit: no resolver call.
    const resolveHome = vi.fn(async () => "/other/home");
    const hitDefault = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome,
      readFromLogs: (_pid, home) => (home === "/home/me" ? "thread-1" : undefined),
    });
    expect(await hitDefault.resolve(42)).toBe("thread-1");
    expect(resolveHome).toHaveBeenCalledTimes(0);

    // Non-default home: resolved once, then served from the bounded cache.
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome,
      readFromLogs: (_pid, home) => (home === "/other/home" ? "thread-2" : undefined),
    });
    expect(await resolver.resolve(43)).toBe("thread-2");
    expect(await resolver.resolve(43)).toBe("thread-2");
    expect(resolveHome).toHaveBeenCalledTimes(1);

    // A FAILED resolution is not cached: the next call retries.
    const failing = vi.fn(async () => { throw new Error("ps died"); });
    const failed = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: failing as never,
      readFromLogs: () => undefined,
    });
    await expect(failed.resolve(44)).rejects.toThrow("ps died");
    await expect(failed.resolve(44)).rejects.toThrow("ps died");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("addendum coalescing: two CONCURRENT resolves for the same non-default pid spawn at most ONE home probe", async () => {
    let release!: (home: string) => void;
    const resolveHome = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/other/home" ? "thread-9" : undefined),
    });
    const a = resolver.resolve(77);
    const b = resolver.resolve(77);
    release("/other/home");
    expect(await a).toBe("thread-9");
    expect(await b).toBe("thread-9");
    expect(resolveHome).toHaveBeenCalledTimes(1);
  });

  it("addendum stability: a pid whose HOME resolves to the DEFAULT (no thread log anywhere) is cached — no repeat subprocess every poll", async () => {
    // Explicit decision: a pid's HOME cannot change for the life of the process,
    // so a successful HOME=default answer is cached like any other; the default
    // home was already read first, so later resolves for that pid spawn nothing.
    // (Bounded-staleness tradeoff on pid reuse is the same class as the
    // non-default cache and is accepted.)
    const resolveHome = vi.fn(async () => "/home/me");
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: () => undefined,
    });
    expect(await resolver.resolve(88)).toBeUndefined();
    expect(await resolver.resolve(88)).toBeUndefined();
    expect(await resolver.resolve(88)).toBeUndefined();
    expect(resolveHome).toHaveBeenCalledTimes(1);
  });

  it("r2-B1: the pid-home cache EXPIRES — a reused PID with a new HOME re-probes after the TTL and returns the NEW thread", async () => {
    // r2's discriminator: without freshness, a size-bounded cache serves a
    // RETIRED occupant's thread id for a reused pid indefinitely on a quiet
    // daemon. TTL bounds that staleness; coalescing and the size bound stay.
    let t = 0;
    let liveHome = "/home/old";
    const resolveHome = vi.fn(async () => liveHome);
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/home/old" ? "old-thread" : home === "/home/new" ? "new-thread" : undefined),
      homeTtlMs: 60_000,
      now: () => t,
    });
    expect(await resolver.resolve(4242)).toBe("old-thread");
    // The pid is reused by a NEW process with a different HOME.
    liveHome = "/home/new";
    t = 30_000; // inside the TTL: cache serves (bounded staleness, accepted)
    expect(await resolver.resolve(4242)).toBe("old-thread");
    expect(resolveHome).toHaveBeenCalledTimes(1);
    t = 60_001; // past the TTL: re-probe, new answer
    expect(await resolver.resolve(4242)).toBe("new-thread");
    expect(resolveHome).toHaveBeenCalledTimes(2);
  });

  it("r1 remedy: PROCESS IDENTITY invalidates a reused PID immediately — no TTL wait, no extra subprocess", async () => {
    // orch-lead's freeze-boundary ruling: TTL alone still serves another
    // occupant's thread inside the window. The census rows already carry the
    // process's start time; threading it as an identity key makes reuse
    // invalidate at the very next resolve.
    let liveHome = "/home/old";
    const resolveHome = vi.fn(async () => liveHome);
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/home/old" ? "old-thread" : home === "/home/new" ? "new-thread" : undefined),
      homeTtlMs: 60_000,
      now: () => 0, // clock frozen INSIDE the TTL — only identity can invalidate
    });
    expect(await resolver.resolve(4242, "Sun Aug 23 10:00:00 2026")).toBe("old-thread");
    expect(await resolver.resolve(4242, "Sun Aug 23 10:00:00 2026")).toBe("old-thread");
    expect(resolveHome).toHaveBeenCalledTimes(1); // same identity: cached
    // The pid is REUSED: same number, different start time, different HOME.
    liveHome = "/home/new";
    expect(await resolver.resolve(4242, "Sun Aug 23 18:30:00 2026")).toBe("new-thread");
    expect(resolveHome).toHaveBeenCalledTimes(2); // identity mismatch: immediate re-probe
  });

  it("r1 remedy: the strict census rows CARRY the start-time identity the resolver needs", async () => {
    const { defaultListProcessesStrict } = await import("../src/domain/resume-metadata-refresher.js");
    const rows = await defaultListProcessesStrict();
    expect(rows.length).toBeGreaterThan(0);
    const withStart = rows.filter((r) => typeof (r as { startedAt?: string }).startedAt === "string" && (r as { startedAt?: string }).startedAt!.length > 0);
    // Every row carries a parseable start time, and commands survive the extra column.
    expect(withStart.length).toBe(rows.length);
    expect(rows.some((r) => r.command.length > 0)).toBe(true);
  });

  it("r2 round-3: a known identity NEVER joins an in-flight probe belonging to a DIFFERENT identity (pid reused mid-probe)", async () => {
    // r2's deferred-pressure discriminator: probe A for pid 4242 (identity-A)
    // is in flight when the pid is reused and B resolves with identity-B.
    // Coalescing by pid alone handed B the retired occupant's answer — B must
    // start its OWN probe and get the NEW thread, in both completion orders,
    // and a late A completion must not clobber B's cached entry.
    for (const order of ["a-first", "b-first"] as const) {
      const waiters = new Map<string, (home: string) => void>();
      let probeSeq = 0;
      const resolveHome = vi.fn((_pid: number) => new Promise<string>((r) => { waiters.set(`p${++probeSeq}`, r); }));
      const resolver = new CodexThreadIdResolver({
        defaultHome: "/home/me",
        resolveHomeDirByPid: resolveHome as never,
        readFromLogs: (_pid, home) => (home === "/home/old" ? "old-thread" : home === "/home/new" ? "new-thread" : undefined),
        homeTtlMs: 60_000,
        now: () => 0,
      });
      const a = resolver.resolve(4242, "identity-A");
      const b = resolver.resolve(4242, "identity-B");
      expect(resolveHome).toHaveBeenCalledTimes(2); // B started its OWN probe
      if (order === "a-first") {
        waiters.get("p1")!("/home/old");
        waiters.get("p2")!("/home/new");
      } else {
        waiters.get("p2")!("/home/new");
        waiters.get("p1")!("/home/old");
      }
      expect(await a).toBe("old-thread");
      expect(await b).toBe("new-thread");
      // B's cached entry survives regardless of completion order: a subsequent
      // B read is served fresh/cached with no third probe.
      expect(await resolver.resolve(4242, "identity-B")).toBe("new-thread");
      expect(resolveHome).toHaveBeenCalledTimes(2);
    }
  });

  it("r2 round-4: the DEFAULT-HOME fast path never returns a RETIRED occupant's log row to a reused pid (real sqlite, time-gated)", async () => {
    // r2's effect-level discriminator: logs rows key on pid:<pid>:<opaque-uuid>
    // and the pid-only LIKE read returned a retired process's thread to the
    // NEW occupant BEFORE identity participated — on the zero-subprocess fast
    // path. The honest gate is TIME (measured schema: ts = epoch seconds): a
    // row belongs to the current occupant only if written at/after the
    // identity's start time. Zero HOME probes throughout.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s10-r4-home-"));
    try {
      fs.mkdirSync(nodePath.join(home, ".codex"), { recursive: true });
      const db = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT, process_uuid TEXT, thread_id TEXT)");
      // Only the RETIRED occupant's row exists: written 2026-08-23 10:00 local.
      const retiredTs = Math.floor(new Date("Aug 23, 2026 10:00:00").getTime() / 1000);
      db.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(retiredTs, "pid:4242:retired-process-uuid", "retired-thread");
      db.close();

      // A genuine default-home MISS may legitimately probe (the process could
      // live under a non-default home); the zero-subprocess contract is for
      // the HIT path. The probe honestly answers "default home".
      const homeProbes = vi.fn(async () => home);
      const resolver = new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: homeProbes as never });

      // The NEW occupant (started 19:30) must NOT receive the retired thread.
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      const probesAfterMiss = homeProbes.mock.calls.length;
      // Once the NEW occupant's own row exists (written after its start), it resolves.
      const db2 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      const newTs = Math.floor(new Date("Aug 23, 2026 19:31:00").getTime() / 1000);
      db2.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(newTs, "pid:4242:new-process-uuid", "new-thread");
      db2.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBe("new-thread");
      // An identity-less caller keeps the legacy read (TTL-bounded elsewhere).
      expect(await resolver.resolve(4242)).toBe("new-thread");
      // The HIT path spawned nothing: no probes beyond the one honest miss.
      expect(homeProbes.mock.calls.length).toBe(probesAfterMiss);
      expect(probesAfterMiss).toBeLessThanOrEqual(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("r2 round-5: the reuse BOUNDARY is exact — a retired row at startTs-1 never resolves; B's same-second row does (real sqlite)", async () => {
    // r2's boundary control: the 2s slack readmitted the retired token at the
    // exact reuse boundary. Both ts and lstart are second-aligned, and a
    // process cannot emit its own log BEFORE its start second — so the gate
    // is ts >= startTs exactly, no slack.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s10-r5-home-"));
    try {
      fs.mkdirSync(nodePath.join(home, ".codex"), { recursive: true });
      const startTs = Math.floor(new Date("Aug 23, 2026 19:30:00").getTime() / 1000);
      const db = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT, process_uuid TEXT, thread_id TEXT)");
      // ONLY the retired occupant's row, ONE second before B's start.
      db.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs - 1, "pid:4242:retired-process-uuid", "retired-thread");
      db.close();

      const homeProbes = vi.fn(async () => home);
      const resolver = new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: homeProbes as never });
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();

      // r2 round-6 superseded round-5's same-second acceptance: ownership
      // inside the start second is undecidable (no subsecond lstart), so a
      // same-second row — even B's own — fails CLOSED; the next second resolves.
      const db2 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db2.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs, "pid:4242:new-process-uuid", "new-thread");
      db2.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      const db3 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db3.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs + 1, "pid:4242:new-process-uuid", "new-thread");
      db3.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBe("new-thread");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("r2 round-6: the AMBIGUOUS start second fails CLOSED — no row at ts == startTs resolves; a row after it does (real sqlite)", async () => {
    // r2's same-second control: retired A can log at ts == B.startTs and exit,
    // B reuses the pid in the same second — lstart carries no subsecond
    // component, so ownership inside that second is UNDECIDABLE. The ruled
    // shape is honest INDETERMINATE over masked stale: ts > startTs strictly;
    // a genuinely-current same-second row resolves one poll later instead of
    // a retired token resolving now.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s10-r6-home-"));
    try {
      fs.mkdirSync(nodePath.join(home, ".codex"), { recursive: true });
      const startTs = Math.floor(new Date("Aug 23, 2026 19:30:00").getTime() / 1000);
      const db = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT, process_uuid TEXT, thread_id TEXT)");
      // ONLY retired A's row, INSIDE B's start second.
      db.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 100000000, 'info', ?, ?)")
        .run(startTs, "pid:4242:retired-process-uuid", "retired-thread");
      db.close();

      const resolver = new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: (async () => home) as never });
      // The ambiguous second fails closed: the retired row must not resolve…
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      // …and even B's OWN same-second row stays unresolved (undecidable ownership).
      const db2 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db2.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 200000000, 'info', ?, ?)")
        .run(startTs, "pid:4242:new-process-uuid", "new-thread");
      db2.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      // A row strictly AFTER the start second resolves.
      const db3 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db3.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs + 1, "pid:4242:new-process-uuid", "new-thread");
      db3.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBe("new-thread");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("soak finding: an identity-keyed cache entry OUTLIVES the poll cadence — two polls 60s apart make ONE probe total", async () => {
    // Live soak at 413e2d541: list_processes +6 (census fix works) but
    // resolve_home +53/5min — the 60s TTL EQUALS the 60s divergence cadence,
    // so identity-keyed entries expired exactly when next needed and every
    // pending codex seat re-probed every poll. Identity invalidates pid
    // reuse STRUCTURALLY (rounds 3-6), so time is not load-bearing for
    // identity-keyed entries: their TTL defaults long (15 min); the 60s
    // bound remains for identity-less callers only.
    let t = 0;
    const resolveHome = vi.fn(async () => "/other/home");
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/other/home" ? "thread-x" : undefined),
      now: () => t,
    });
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    t = 61_000; // the next divergence poll
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    t = 601_000; // ten minutes on, same identity: still cached
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    expect(resolveHome).toHaveBeenCalledTimes(1);
    // Identity-less callers keep the SHORT bound: their slot serves within
    // 60s and re-probes after it.
    expect(await resolver.resolve(501)).toBe("thread-x"); // probe #2
    t = 631_000; // +30s: inside the identity-less TTL — cached, no probe
    expect(await resolver.resolve(501)).toBe("thread-x");
    expect(resolveHome).toHaveBeenCalledTimes(2);
    t = 692_000; // +61s past the entry: expired — re-probe
    expect(await resolver.resolve(501)).toBe("thread-x"); // probe #3
    expect(resolveHome).toHaveBeenCalledTimes(3);
  });

  it("r2-B2: the census's PRODUCTION lister REJECTS on enumeration failure — a failed ps is never cached as an empty success", async () => {
    // r2's discriminator: defaultListProcesses swallows a spawn failure into []
    // — through the census that empty array became a CACHED SUCCESS for the
    // whole freshness window. The census's production seam must reject instead.
    const { defaultListProcessesStrict } = await import("../src/domain/resume-metadata-refresher.js");
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-bin";
      await expect(defaultListProcessesStrict()).rejects.toThrow();
    } finally {
      process.env.PATH = savedPath;
    }
    const rows = await defaultListProcessesStrict();
    expect(rows.length).toBeGreaterThan(0);
    // And the census default is wired to the STRICT lister, not the lenient one.
    const censusSrc = await import("node:fs").then((f) => f.readFileSync("src/domain/process-census.ts", "utf-8"));
    expect(censusSrc).toContain("defaultListProcessesStrict");
  });

  it("mini-req 4 guard: the adoption-boundary capture keeps its retry loop (attempts default is unchanged off the snapshot path)", async () => {
    const db = createFullTestDb();
    const sessionRegistry = new SessionRegistry(db);
    const listProcesses = vi.fn(async () => ROWS);
    const sleep = vi.fn(async () => {});
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: { getPanePid: async () => 10 } as unknown as TmuxAdapter,
      listProcesses,
      readCodexThreadIdByPid: () => undefined,
      sleep,
    });
    await refresher.captureCodexThreadId("seat@rig");
    // The direct (non-snapshot) capture still makes its 8 attempts.
    expect(listProcesses).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledTimes(7);
    db.close();
  });
});
