import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  CLAUDE_ACTIVITY_RUNG_INVENTORY,
  CODEX_ACTIVITY_RUNG_INVENTORY,
  TMUX_GENERIC_RUNG_INVENTORY,
  PI_ACTIVITY_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { readClaudeSelfReportEvidence, verifiedSelfReportPid, type ClaudeSelfReportRead } from "../src/adapters/claude-code-adapter.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";

// OPR.0.5.5.19 A5 — per-harness rung inventories + the Claude self-report rung (r3) +
// the production wiring (sweep auto-declaration, self-report consultation, silent fall).
// The CONTRACT layer (ladder ranks, falls, admission) carried its watched REDs in A3;
// these pin the adapter declarations and the reader/wiring built on top.

describe("S19 A5 — per-harness rung inventories (one data source)", () => {
  it("claude staffs all four rungs, full-lifecycle, authoritative (the standing rungs r1-r4)", () => {
    const rungs = new Map(CLAUDE_ACTIVITY_RUNG_INVENTORY.rungs.map((r) => [r.rung, r]));
    for (const rung of ["self-report", "lifecycle-hooks", "needs-input-chrome", "window-sampling"] as const) {
      expect(rungs.get(rung), rung).toBeDefined();
      expect(rungs.get(rung)!.lifecycleCoverage).toBe("full");
      expect(rungs.get(rung)!.initialTrust).toBe("authoritative");
    }
  });

  it("codex: hooks enter at TRIAL (AM-2), sampling authoritative, and NO self-report rung (no pid.json analog — verified on-box)", () => {
    const rungs = new Map(CODEX_ACTIVITY_RUNG_INVENTORY.rungs.map((r) => [r.rung, r]));
    expect(rungs.get("lifecycle-hooks")!.initialTrust).toBe("trial");
    expect(rungs.get("window-sampling")!.initialTrust).toBe("authoritative");
    expect(rungs.has("self-report")).toBe(false); // absent rung — rendered honestly, never manufactured
  });

  it("runtime resolution: claude/codex map to their inventories; anything else gets the generic floor", () => {
    expect(runtimeRungInventory("claude-code")).toBe(CLAUDE_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("codex")).toBe(CODEX_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("pi")).toBe(PI_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("terminal")).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    expect(runtimeRungInventory(null)).toBe(TMUX_GENERIC_RUNG_INVENTORY);
  });
});

describe("S19 A5 — readClaudeSelfReportEvidence: the pid.json rung, undocumented-internal discipline", () => {
  const SEAT = "node-sr-1";
  const NAME = "dev50-qa@v-openrig-build";
  const record = (over: Record<string, unknown>) => JSON.stringify({
    pid: 123, name: NAME, status: "busy", statusUpdatedAt: 1_787_787_000_000, ...over,
  });
  const readOf = (files: Record<string, string>, throwOnList = false): ClaudeSelfReportRead => ({
    listFiles: () => { if (throwOnList) throw new Error("ENOENT"); return Object.keys(files); },
    readFile: (p) => { const f = p.split("/").pop()!; if (f in files) return files[f]!; throw new Error("ENOENT"); },
  });
  const input = (read: ClaudeSelfReportRead) => ({ sessionsDir: "/cfg/sessions", sessionName: NAME, seatNodeId: SEAT, read });

  it("busy → working, SELF-DATED from statusUpdatedAt (evidence carries its own clock)", () => {
    const ev = readClaudeSelfReportEvidence(input(readOf({ "123.json": record({}) })))!;
    expect(ev.rung).toBe("self-report");
    expect(ev.activity).toBe("working");
    expect(ev.observedAt).toBe(new Date(1_787_787_000_000).toISOString());
    expect(ev.seq).toBe(1_787_787_000_000);
  });

  it("idle and shell both → idle-at-prompt (turn over; a background shell is not a working turn)", () => {
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "idle" }) })))!.activity).toBe("idle-at-prompt");
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "shell" }) })))!.activity).toBe("idle-at-prompt");
  });

  it("shell keeps its own fact, backgroundWork, and idle carries none (#2661)", () => {
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "shell" }) })))!.backgroundWork).toBe(true);
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "idle" }) })))!.backgroundWork).toBeUndefined();
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "busy" }) })))!.backgroundWork).toBeUndefined();
  });

  it("waiting → needs-input count+reason (Claude's dialog state — kept OUT of the activity enum)", () => {
    const ev = readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "waiting" }) })))!;
    expect(ev.activity).toBeUndefined();
    expect(ev.needsInput!.count).toBe(1);
  });

  it("resolves by the seat's canonical NAME; other seats' files never match; the freshest record wins", () => {
    const ev = readClaudeSelfReportEvidence(input(readOf({
      "1.json": record({ name: "someone-else@rig", status: "busy" }),
      "2.json": record({ status: "idle", statusUpdatedAt: 1_787_787_000_000 }),
      "3.json": record({ status: "busy", statusUpdatedAt: 1_787_787_999_000 }),
    })))!;
    expect(ev.activity).toBe("working"); // 3.json is fresher than 2.json; 1.json is a different seat
  });

  it("#3604: the verified PID's own file is the seat's after /rename, whatever its title; not another process's, not a stopped one", () => {
    const renamed = readOf({ "123.json": record({ name: "Some Title", status: "idle" }) });
    const running = (read: ClaudeSelfReportRead, pids: number[]) => ({ ...read, isAlive: (pid: number) => pids.includes(pid) });
    expect(readClaudeSelfReportEvidence({ ...input(running(renamed, [123])), pid: 123 })!.activity).toBe("idle-at-prompt");
    expect(readClaudeSelfReportEvidence(input(running(renamed, [123])))).toBeNull(); // no PID: the title no longer names the seat
    expect(readClaudeSelfReportEvidence({ ...input(running(renamed, [])), pid: 123 })).toBeNull(); // not running
    const other = running(readOf({ "124.json": record({ pid: 999, name: "Some Title" }) }), [124]);
    expect(readClaudeSelfReportEvidence({ ...input(other), pid: 124 })).toBeNull(); // the file names another process
  });

  it("#3605: the PID comes only from a verified verdict for this same session", () => {
    const verdict = (over: Record<string, unknown> = {}, evidence: Record<string, unknown> = {}) => ({ nodeId: SEAT, verdict: "verified",
      evidenceSource: null, reason: null, sessionName: NAME, observedAt: "2026-11-20T07:00:00Z",
      evidence: { registeredPane: "%1", observedPid: 123, observedCommand: "claude", matchedLayer: 1, ...evidence }, ...over }) as never;
    expect(verifiedSelfReportPid(verdict(), NAME)).toBe(123);
    expect(verifiedSelfReportPid(verdict({ verdict: "unverified" }), NAME)).toBeUndefined();
    expect(verifiedSelfReportPid(verdict({ sessionName: "another-seat" }), NAME)).toBeUndefined();
    expect(verifiedSelfReportPid(verdict({}, { observedPid: null }), NAME)).toBeUndefined();
    expect(verifiedSelfReportPid(null, NAME)).toBeUndefined();
  });

  it("unreadable dir, malformed file, unknown status, wrong shape — ALL return null, never throw (fall down the ladder)", () => {
    expect(readClaudeSelfReportEvidence(input(readOf({}, true)))).toBeNull();
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": "{not json" })))).toBeNull();
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "levitating" }) })))).toBeNull();
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ statusUpdatedAt: "yesterday" }) })))).toBeNull();
  });
});

describe("S19 A5 — production wiring: the sweep auto-declares, consults self-report, falls silently", () => {
  const SEAT = "node-sw-1";
  const NAME = "dev50-qa@v-openrig-build";

  function harness(opts: { runtime: string; selfReport?: "busy" | "null" }) {
    const clock = { now: 5_000_000 };
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => clock.now / 1000 - 10 }, // silent > 3s window ⇒ sampling says idle
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
      selfReportReader: (sessionName, seatNodeId) =>
        opts.selfReport === "busy"
          ? { seatNodeId, sessionName, rung: "self-report", sourceId: "claude:pid-json", seq: clock.now, observedAt: new Date(clock.now).toISOString(), activity: "working" }
          : null,
    });
    const db = { prepare: () => ({ all: () => [{ session_name: NAME, node_id: SEAT, runtime: opts.runtime, attachment_type: "tmux" }] }) } as unknown as Database.Database;
    return { svc, db, clock };
  }

  it("a claude seat is auto-declared and the self-report rung DECIDES over contradicting sampling", async () => {
    const { svc, db } = harness({ runtime: "claude-code", selfReport: "busy" });
    await svc.pollAllRunningTmuxSeats(db);
    expect(svc.hasRungInventory(SEAT)).toBe(true);
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working");
    expect(s.decidedBy).toBe("self-report"); // pid.json above sampling (r3 over r1)
  });

  it("reader null (unreadable file) → SILENT fall to sampling, no error, honest idle", async () => {
    const { svc, db } = harness({ runtime: "claude-code", selfReport: "null" });
    await svc.pollAllRunningTmuxSeats(db);
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt");
    expect(s.decidedBy).toBe("window-sampling");
  });

  it("#3604: after /rename an unread self-report retires on its second unread sweep and the Stop hook decides; the verified PID keeps it read", async () => {
    for (const bound of [false, true]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
      try {
        const clock = { now: Date.parse("2026-11-20T07:20:00Z") };
        const pidFile = (name: string, status: string) =>
          fs.writeFileSync(path.join(dir, "4242.json"), JSON.stringify({ pid: 4242, name, status, statusUpdatedAt: clock.now }));
        const read: ClaudeSelfReportRead = { listFiles: (d) => fs.readdirSync(d), readFile: (f) => fs.readFileSync(f, "utf8"), isAlive: () => true };
        const svc = new SeatActivityService({
          tmux: { readPaneLastActivity: async () => clock.now / 1000 - 10 }, defaultWindowSeconds: 3, now: () => new Date(clock.now),
          selfReportReader: (sessionName, seatNodeId) => readClaudeSelfReportEvidence({ sessionsDir: dir, sessionName, seatNodeId, read, ...(bound ? { pid: 4242 } : {}) }),
        });
        const db = { prepare: () => ({ all: () => [{ session_name: NAME, node_id: SEAT, runtime: "claude-code", attachment_type: "tmux" }] }) } as unknown as Database.Database;
        const state = () => { const s = svc.getSeatState(SEAT)!; return [s.activity, s.decidedBy]; };
        pidFile(NAME, "busy"); await svc.pollAllRunningTmuxSeats(db);
        expect(state(), `bound=${bound}`).toEqual(["working", "self-report"]);
        clock.now += 60_000; pidFile("Some Title", "busy"); await svc.pollAllRunningTmuxSeats(db);
        expect(state(), `bound=${bound}: one unread sweep keeps it`).toEqual(["working", "self-report"]);
        clock.now += 60_000; pidFile("Some Title", "idle"); await svc.pollAllRunningTmuxSeats(db);
        svc.reportEvidence({ seatNodeId: SEAT, sessionName: NAME, rung: "lifecycle-hooks", sourceId: "claude:hooks", seq: 2,
          observedAt: new Date(clock.now).toISOString(), activity: "idle-at-prompt" });
        expect(state(), `bound=${bound}: the turn is over`).toEqual(["idle-at-prompt", bound ? "self-report" : "lifecycle-hooks"]);
        clock.now += 30 * 60_000; await svc.pollAllRunningTmuxSeats(db);
        expect(state()[0], `bound=${bound}: still idle 30 minutes on`).toBe("idle-at-prompt");
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  // A first sweep without a verified PID takes a name-matched file; a later one with it takes the PID's own file, whose
  // report can be older. That file's report decides from then on; one file's own older record is still dropped.
  function selfReportFiles() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
    const clock = { now: Date.parse("2026-11-20T08:00:00Z") };
    const write = (file: string, record: Record<string, unknown>) => fs.writeFileSync(path.join(dir, file), JSON.stringify(record));
    const read: ClaudeSelfReportRead = { listFiles: (d) => fs.readdirSync(d), readFile: (f) => fs.readFileSync(f, "utf8"), isAlive: () => true };
    const verified = { pid: undefined as number | undefined };
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => clock.now / 1000 - 10 }, defaultWindowSeconds: 3, now: () => new Date(clock.now),
      selfReportReader: (sessionName, seatNodeId) => readClaudeSelfReportEvidence({ sessionsDir: dir, sessionName, seatNodeId, read,
        ...(verified.pid === undefined ? {} : { pid: verified.pid }) }),
    });
    const db = { prepare: () => ({ all: () => [{ session_name: NAME, node_id: SEAT, runtime: "claude-code", attachment_type: "tmux" }] }) } as unknown as Database.Database;
    const sweep = async () => { await svc.pollAllRunningTmuxSeats(db); const s = svc.getSeatState(SEAT)!; return [s.activity, s.decidedBy]; };
    return { dir, clock, write, verified, sweep };
  }

  it("#3605: the verified PID's own file decides once it's selected, though its report is older than the name match it replaces", async () => {
    const { dir, clock, write, verified, sweep } = selfReportFiles();
    try {
      const t1 = clock.now - 120_000;
      write("5000.json", { pid: 5000, name: NAME, status: "busy", statusUpdatedAt: clock.now }); // a name match, at T2
      write("4242.json", { pid: 4242, name: "Some Title", status: "idle", statusUpdatedAt: t1 }); // the seat's own, at T1 < T2
      expect(await sweep()).toEqual(["working", "self-report"]);
      verified.pid = 4242; // the seat's PID is verified now
      clock.now += 5_000;
      expect(await sweep()).toEqual(["idle-at-prompt", "self-report"]);
      clock.now += 60_000;
      expect(await sweep()).toEqual(["idle-at-prompt", "self-report"]); // unchanged later sweeps stay idle
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("#3605: the same file's older record is still dropped", async () => {
    const { dir, clock, write, verified, sweep } = selfReportFiles();
    try {
      verified.pid = 4242;
      write("4242.json", { pid: 4242, name: NAME, status: "busy", statusUpdatedAt: clock.now });
      expect(await sweep()).toEqual(["working", "self-report"]);
      write("4242.json", { pid: 4242, name: NAME, status: "idle", statusUpdatedAt: clock.now - 1_000 }); // out of order
      clock.now += 5_000;
      expect(await sweep()).toEqual(["working", "self-report"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("#3605: a pane whose activity can't be read still retires an unread self-report on its second unread sweep", async () => {
    const clock = { now: 5_000_000 };
    let readable = true;
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(clock.now),
      selfReportReader: (sessionName, seatNodeId) => readable
        ? { seatNodeId, sessionName, rung: "self-report", sourceId: "claude:pid-json", seq: clock.now, observedAt: new Date(clock.now).toISOString(), activity: "working" }
        : null,
    });
    const db = { prepare: () => ({ all: () => [{ session_name: NAME, node_id: SEAT, runtime: "claude-code", attachment_type: "tmux" }] }) } as unknown as Database.Database;
    await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!.decidedBy).toBe("self-report");
    readable = false; clock.now += 1_000; await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!.decidedBy, "one unread sweep keeps it").toBe("self-report");
    clock.now += 1_000; await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!.decidedBy).not.toBe("self-report");
    expect(svc.getSeatState(SEAT)!.activity).not.toBe("working");
  });

  it("a codex seat never consults self-report (rung absent by inventory) and shows the honest rung set", async () => {
    const { svc, db } = harness({ runtime: "codex", selfReport: "busy" });
    await svc.pollAllRunningTmuxSeats(db);
    const s = svc.getSeatState(SEAT)!;
    expect(s.decidedBy).toBe("window-sampling");
    expect(s.rungs.some((r) => r.rung === "self-report")).toBe(false); // absent, not guessed
    expect(s.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust).toBe("trial");
  });
});
