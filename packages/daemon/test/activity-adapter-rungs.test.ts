import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import {
  CLAUDE_ACTIVITY_RUNG_INVENTORY,
  CODEX_ACTIVITY_RUNG_INVENTORY,
  TMUX_GENERIC_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { readClaudeSelfReportEvidence, type ClaudeSelfReportRead } from "../src/adapters/claude-code-adapter.js";
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
    expect(runtimeRungInventory("pi")).toBe(TMUX_GENERIC_RUNG_INVENTORY);
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
    const db = { prepare: () => ({ all: () => [{ session_name: NAME, node_id: SEAT, runtime: opts.runtime }] }) } as unknown as Database.Database;
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

  it("a codex seat never consults self-report (rung absent by inventory) and shows the honest rung set", async () => {
    const { svc, db } = harness({ runtime: "codex", selfReport: "busy" });
    await svc.pollAllRunningTmuxSeats(db);
    const s = svc.getSeatState(SEAT)!;
    expect(s.decidedBy).toBe("window-sampling");
    expect(s.rungs.some((r) => r.rung === "self-report")).toBe(false); // absent, not guessed
    expect(s.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust).toBe("trial");
  });
});
