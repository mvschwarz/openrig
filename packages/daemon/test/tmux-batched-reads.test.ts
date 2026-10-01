// The 1 Hz seat-activity sweep spawned one `tmux display-message` per seat (~85/s, 51.7% of daemon CPU at 87 seats); the
// identity sweep one getPanePid + one getPaneCommand per seat. Each sweep now reads every seat with ONE tmux call and falls
// back to the per-seat read only on a miss. Outputs must equal the per-seat path. (#161)
import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

// A tmux "server": sessions (one current window each, plus an inactive one for s2) and panes.
const WINDOWS = [
  ["s1@rig", 1, 1790000100], ["s2@rig", 0, 1790000999], ["s2@rig", 1, 1790000050], ["s3@rig", 1, 0], ["s4@rig", 1, 1790000200],
] as const;
const PANES = [["%1", 4242, "node"], ["%2", 5151, "zsh"], ["%3", 0, ""], ["%4", 7777, "codex"]] as const;
const unquote = (t: string) => t.replace(/^'(.*)'$/, "$1");
function fakeExec() {
  const calls: string[] = [];
  const exec = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd.startsWith("tmux list-windows -a")) return WINDOWS.map(([s, a, t]) => `${a}|${t}|${s}`).join("\n") + "\n";
    if (cmd.startsWith("tmux list-panes -a")) return PANES.map(([p, pid, c]) => `${p}|${pid}|${c}`).join("\n") + "\n";
    const m = cmd.match(/^tmux display-message -p -t (\S+) ["']#\{(\w+)\}["']$/);
    if (!m) throw new Error(`unexpected: ${cmd}`);
    const target = unquote(m[1]!), field = m[2]!;
    if (field === "window_activity") { const w = WINDOWS.find(([s, a]) => s === target && a === 1); if (!w) throw new Error("no session"); return `${w[2]}\n`; }
    const p = PANES.find(([id]) => id === target); if (!p) throw new Error("no pane");
    return field === "pane_pid" ? `${p[1]}\n` : `${p[2]}\n`;
  });
  return { exec, calls };
}

describe("batched tmux reads", () => {
  it("readAllSessionWindowActivity equals readPaneLastActivity(<session>) for every session, in one call", async () => {
    const { exec, calls } = fakeExec(); const tmux = new TmuxAdapter(exec as never);
    const batch = await tmux.readAllSessionWindowActivity();
    expect(calls).toHaveLength(1);
    for (const s of ["s1@rig", "s2@rig", "s3@rig", "s4@rig"]) {
      const per = await tmux.readPaneLastActivity(s);
      expect(batch!.get(s) ?? null, s).toBe(per);
    }
    expect(batch!.get("s2@rig")).toBe(1790000050);   // the CURRENT window, as display-message -t <session> reads
    expect(batch!.has("s3@rig")).toBe(false);          // 0 is not a timestamp: left out, like the per-target null
  });

  it("readAllPaneProcesses equals getPanePid/getPaneCommand for every pane, in one call", async () => {
    const { exec, calls } = fakeExec(); const tmux = new TmuxAdapter(exec as never);
    const batch = await tmux.readAllPaneProcesses();
    expect(calls).toHaveLength(1);
    for (const [id] of PANES) {
      const pid = await tmux.getPanePid(id), cmd = await tmux.getPaneCommand(id);
      if (pid === null) expect(batch!.has(id), id).toBe(false);
      else expect(batch!.get(id), id).toEqual({ pid, command: cmd });
    }
  });

  it("a tmux failure makes the batch null (callers then read per seat)", async () => {
    const tmux = new TmuxAdapter((async () => { throw new Error("no server running"); }) as never);
    expect(await tmux.readAllSessionWindowActivity()).toBeNull();
    expect(await tmux.readAllPaneProcesses()).toBeNull();
  });
});

function seed(db: Database.Database, seats: Array<[string, string, string, string?]>) {
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig')").run();
  for (const [node, session, pane, runtime] of seats) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, 'rig-1', ?, ?, '/tmp')").run(node, `p.${node}`, runtime ?? "claude-code");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, 'running', 'ready')").run(`s-${node}`, node, session);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, 'tmux', ?, ?)").run(`b-${node}`, node, session, pane);
  }
}
const SEATS: Array<[string, string, string, string?]> = [["n1", "s1@rig", "%1"], ["n2", "s2@rig", "%2"], ["n3", "s3@rig", "%3"], ["n4", "s4@rig", "%9"], ["n5", "gone@rig", "%5"]];
const NOW = () => new Date(1790000102 * 1000);

describe("batched tmux reads: the separator inside a session name or a command", () => {
  it("keeps a session name and a pane command that contain the field separator intact", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith("tmux list-windows -a")) return "1|1790000100|odd|name@rig\n0|1790000200|odd|name@rig\n";
      if (cmd.startsWith("tmux list-panes -a")) return "%9|4242|a|b\n";
      throw new Error(`unexpected: ${cmd}`);
    });
    const tmux = new TmuxAdapter(exec as never);
    expect(await tmux.readAllSessionWindowActivity()).toEqual(new Map([["odd|name@rig", 1790000100]]));
    expect(await tmux.readAllPaneProcesses()).toEqual(new Map([["%9", { pid: 4242, command: "a|b" }]]));
  });
});

describe("SeatActivityService sweep with the batch", () => {
  async function sweep(batched: boolean) {
    const db = createFullTestDb(); seed(db, SEATS);
    const { exec, calls } = fakeExec(); const real = new TmuxAdapter(exec as never);
    const tmux = batched
      ? { readPaneLastActivity: (p: string) => real.readPaneLastActivity(p), readAllSessionWindowActivity: () => real.readAllSessionWindowActivity() }
      : { readPaneLastActivity: (p: string) => real.readPaneLastActivity(p) };
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: NOW });
    await svc.pollAllRunningTmuxSeats(db);
    const out = Object.fromEntries(SEATS.map(([, s]) => [s, svc.getSeatActivity(s)]));
    db.close();
    return { out, calls };
  }

  it("same observations as the per-seat path; one tmux call plus per-seat reads only for the misses", async () => {
    const per = await sweep(false), bat = await sweep(true);
    expect(bat.out).toEqual(per.out);
    expect(per.calls).toHaveLength(5);                                   // one display-message per seat before
    expect(bat.calls.filter((c) => c.startsWith("tmux list-windows -a"))).toHaveLength(1);
    // misses fall back: s3 (no valid timestamp) and gone@rig (no such session); s1, s2, s4 come from the batch
    expect(bat.calls.filter((c) => c.startsWith("tmux display-message")).map((c) => c.match(/-t (\S+)/)![1]).map(unquote).sort()).toEqual(["gone@rig", "s3@rig"]);
    expect(bat.out["s1@rig"]!.isActiveWithinWindow).toBe(true);
    expect(bat.out["s2@rig"]!.isActiveWithinWindow).toBe(false);
  });

  it("a failed batch reads every seat per target, as before", async () => {
    const db = createFullTestDb(); seed(db, SEATS);
    const { exec } = fakeExec(); const real = new TmuxAdapter(exec as never);
    const readPaneLastActivity = vi.fn((p: string) => real.readPaneLastActivity(p));
    const svc = new SeatActivityService({ tmux: { readPaneLastActivity, readAllSessionWindowActivity: async () => null }, defaultWindowSeconds: 3, now: NOW });
    await svc.pollAllRunningTmuxSeats(db);
    expect(readPaneLastActivity).toHaveBeenCalledTimes(5);
    db.close();
  });

  it("pollSeat called directly still reads per target (no stale batch)", async () => {
    const { exec, calls } = fakeExec(); const real = new TmuxAdapter(exec as never);
    const svc = new SeatActivityService({ tmux: { readPaneLastActivity: (p: string) => real.readPaneLastActivity(p), readAllSessionWindowActivity: () => real.readAllSessionWindowActivity() }, defaultWindowSeconds: 3, now: NOW });
    await svc.pollSeat("s1@rig");
    expect(calls).toEqual([expect.stringMatching(/^tmux display-message -p -t .*s1@rig/)]);
  });
});

describe("SeatIdentityReconciler with the batch", () => {
  async function reconcile(batched: boolean) {
    const db = createFullTestDb(); seed(db, SEATS.slice(0, 4));
    const { exec, calls } = fakeExec(); const real = new TmuxAdapter(exec as never);
    const tmux = {
      listSessions: async () => ["s1@rig", "s2@rig", "s3@rig", "s4@rig"].map((name) => ({ name })) as never,
      getPanePid: (p: string) => real.getPanePid(p), getPaneCommand: (p: string) => real.getPaneCommand(p),
      ...(batched ? { readAllPaneProcesses: () => real.readAllPaneProcesses() } : {}),
    };
    await new SeatIdentityReconciler({ db, tmux, now: () => new Date("2026-09-30T07:00:00Z") }).reconcileAll();
    const store = new SeatIdentityStore(db);
    const out = Object.fromEntries(["n1", "n2", "n3", "n4"].map((n) => [n, store.getForNode(n)]));
    db.close();
    return { out, calls };
  }

  it("same verdicts as per-pane reads; one list-panes instead of a pid + command read per seat", async () => {
    const per = await reconcile(false), bat = await reconcile(true);
    expect(bat.out).toEqual(per.out);
    expect(per.out.n1?.verdict).toBe("verified");
    expect(per.out.n2?.verdict).toBe("mismatch");
    expect(per.out.n3?.verdict).toBe("pane_missing");
    expect(per.calls.filter((c) => c.startsWith("tmux display-message"))).toHaveLength(6);   // 4 pids + 2 commands (no command read once the pid is gone)
    expect(bat.calls.filter((c) => c.startsWith("tmux list-panes -a"))).toHaveLength(1);
    // only the misses (%3 without a pid, %9 unknown) are read per pane
    expect(bat.calls.filter((c) => c.startsWith("tmux display-message")).map((c) => unquote(c.match(/-t (\S+)/)![1]!)).sort()).toEqual(["%3", "%9"]);
  });
});
