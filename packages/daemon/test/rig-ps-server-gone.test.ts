import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";
import { attachAgentActivity, attachTerminalActivityAndWork, getNodeInventory } from "../src/domain/node-inventory.js";
import { formatSeatActivity } from "../../cli/src/lib/seat-activity.js";

// What `rig ps` reads for a seat after its tmux server is gone (`tmux kill-server`), or can't be reached: the
// reconciler's verdict, the inventory's status, and the activity a hook last reported.
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function fixture(runtime = "claude-code") {
  const db = createFullTestDb(); dbs.push(db);
  db.prepare("INSERT INTO rigs (id,name) VALUES ('rig','rig')").run();
  db.prepare("INSERT INTO nodes (id,rig_id,logical_id,runtime,cwd) VALUES ('worker','rig','worker',?,'/tmp')").run(runtime);
  db.prepare("INSERT INTO sessions (id,node_id,session_name,status,startup_status,created_at) VALUES ('session','worker','worker@rig','running','ready','2026-01-01 00:00:00')").run();
  db.prepare("INSERT INTO bindings (id,node_id,attachment_type,tmux_session,tmux_pane) VALUES ('binding','worker','tmux','worker@rig','%1')").run();
  return db;
}

/** The adapter after its server is gone or unreadable: listSessions reports none, as it does for "no server running";
 *  probeSession reports what tmux said about this session. */
function noListing(probe: Awaited<ReturnType<TmuxAdapter["probeSession"]>>) {
  return {
    listSessions: async () => [] as never,
    getPanePid: vi.fn(async () => null), getPaneCommand: vi.fn(async () => null),
    probeSession: vi.fn(async () => probe),
  };
}
const noServer = { state: "transport_unavailable" as const, cause: "no server running on /tmp/tmux-501/default" };
const unreadable = { state: "transport_unavailable" as const, cause: "error connecting to /tmp/tmux-501/default (Permission denied)" };

const lastIdle = { state: "idle", reason: "stop_hook", evidenceSource: "runtime_hook", sampledAt: "2026-01-01T00:00:00Z", evidence: null };
const lastRunning = { ...lastIdle, state: "running", reason: "prompt_submit_hook" };
async function activity(db: Database.Database, hook: object) {
  const [entry] = getNodeInventory(db, "rig");
  const [out] = await attachAgentActivity([entry!], { tmuxAdapter: {} as never, activityStore: { getLatestForNode: () => hook } as never });
  return { entry: entry!, activity: out!.agentActivity! };
}

/** The arbitrated activity the seat-activity service serves for the seat, as the nodes route attaches it. */
const oracle = (activity: string, needsInput = 0) => ({
  getSeatActivity: () => null,
  getSeatStateBySession: () => ({ seatNodeId: "worker", activity, needsInput: { count: needsInput, reason: needsInput ? "permission_prompt" : null },
    needsInputEvidence: null, decidedBy: "lifecycle-hooks", seq: 1, changedAt: "2026-01-01T00:00:00Z", rungs: [], lastSwap: null }),
});
/** The word `rig ps` (and the MCP team read) shows for the seat: the nodes route's enrichment, in its order, then the
 *  CLI's formatter. */
async function shown(db: Database.Database, hook: object, arbitrated: ReturnType<typeof oracle>) {
  const withActivity = await attachAgentActivity(getNodeInventory(db, "rig"),
    { tmuxAdapter: {} as never, activityStore: { getLatestForNode: () => hook } as never });
  const [row] = attachTerminalActivityAndWork(withActivity, { db, seatActivity: arbitrated as never,
    agentActivity: { getLatestForNode: () => hook } as never });
  return formatSeatActivity(row as never);
}

describe("rig ps after the seat's tmux server is gone", () => {
  it("a server that's gone reads the seat stopped, not idle", async () => {
    const db = fixture();
    const tmux = noListing(noServer);
    await new SeatIdentityReconciler({ db, tmux }).reconcileAll();
    expect(tmux.probeSession).toHaveBeenCalledWith("worker@rig");
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ verdict: "pane_missing", reason: "session_missing" });
    const { entry, activity: read } = await activity(db, lastIdle);
    expect(entry).toMatchObject({ sessionStatus: "detached", storedSessionStatus: "running" });
    expect(entry.lifecycleState).not.toBe("running");
    expect(read).toMatchObject({ state: "unknown", reason: "session_missing" });
    expect(await shown(db, lastIdle, oracle("idle-at-prompt"))).toBe("unknown");
  });

  it("a live server without the session reads it stopped too", async () => {
    const db = fixture();
    await new SeatIdentityReconciler({ db, tmux: noListing({ state: "absent" }) }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ reason: "session_missing" });
    expect((await activity(db, lastIdle)).activity.state).toBe("unknown");
  });

  it("tmux it can't read reads unknown: the seat isn't called stopped, and its last idle isn't served", async () => {
    const db = fixture();
    await new SeatIdentityReconciler({ db, tmux: noListing(unreadable) }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
    const idle = await activity(db, lastIdle);
    expect(idle.entry.sessionStatus).toBe("running");
    expect(idle.activity).toMatchObject({ state: "unknown", reason: "tmux_unavailable" });
    // A working reading is the agent's own report of work, and stays.
    expect((await activity(db, lastRunning)).activity.state).toBe("running");
  });

  it("what rig ps shows for a seat tmux can't read: unknown for an idle, working and needs-input as they are", async () => {
    const db = fixture();
    await new SeatIdentityReconciler({ db, tmux: noListing(unreadable) }).reconcileAll();
    expect(await shown(db, lastIdle, oracle("idle-at-prompt"))).toBe("unknown");
    expect(await shown(db, lastRunning, oracle("working"))).toBe("working");
    expect(await shown(db, lastIdle, oracle("idle-at-prompt", 1))).toBe("needs-input x1");
  });

  it("a live session is unchanged: running, and its idle reads idle", async () => {
    const db = fixture("stub");
    const tmux = { listSessions: async () => [{ name: "worker@rig" }] as never, getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "node"), probeSession: vi.fn(async () => ({ state: "present" as const })) };
    await new SeatIdentityReconciler({ db, tmux }).reconcileAll();
    expect(tmux.probeSession).not.toHaveBeenCalled();
    expect(["session_missing", "tmux_unavailable"]).not.toContain(new SeatIdentityStore(db).getForNode("worker")?.reason);
    const live = await activity(db, lastIdle);
    expect(live.entry.sessionStatus).toBe("running");
    expect(live.activity.state).toBe("idle");
    expect(await shown(db, lastIdle, oracle("idle-at-prompt"))).toBe("idle");
  });

  // The daemon may be looking at a different tmux server than its seats run on: there "no server running" is its own
  // socket's answer. A seat whose last recorded process still runs stays unavailable, as the boot reconciler reads it.
  it.each([["still runs", true], ["is gone", false]])("on a server that reads gone, a seat whose recorded process %s", async (_label, running) => {
    const db = fixture();
    new SeatIdentityStore(db).upsert({ nodeId: "worker", verdict: "verified", evidenceSource: "pane_process", reason: null,
      sessionName: "worker@rig", observedAt: "2026-01-01T00:00:00.000Z",
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: null } });
    const rows = running ? [{ pid: 4242, ppid: 4241, command: "claude", startedAt: "Wed Jan  1 00:00:00 2025" }] : [];
    await new SeatIdentityReconciler({ db, tmux: noListing(noServer),
      readProcessTableCensus: async () => ({ rows, permissionHiddenPids: [] }) }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("worker")?.reason).toBe(running ? "tmux_unavailable" : "session_missing");
  });

  // As on the observed path: the run whose grant was captured before the sweep has ended once its session is gone, and a
  // replacement activated while the probe awaited stays current. Nothing is revoked when tmux can't be read.
  it.each([
    { probe: noServer, replace: false, ended: true }, { probe: noServer, replace: true, ended: true },
    { probe: { state: "absent" as const }, replace: true, ended: true }, { probe: unreadable, replace: false, ended: false },
  ])("a captured run grant ends with a gone session, and only that one ($probe.state, replacement=$replace)", async ({ probe, replace, ended }) => {
    const db = fixture("pi");
    const generation = new SessionRegistry(db).mintOccupantTenure("worker", "initial").generationUuid;
    const grants = new ActivityGrantStore(db);
    const issue = (runId: string) => grants.issue({ nodeId: "worker", generation, issuedBy: "launch", run: {
      runId, sessionId: "session", binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
    const first = issue("first"); grants.activate(first.grantId);
    let successor: ReturnType<typeof issue> | undefined;
    const tmux = noListing(probe);
    tmux.probeSession = vi.fn(async () => {
      if (replace) { successor = issue("successor"); grants.activate(successor.grantId); }
      return probe;
    });
    await new SeatIdentityReconciler({ db, tmux }).reconcileAll();
    expect(grants.standing(first.grantId)).toBe(ended ? "revoked" : "current");
    if (successor) expect(grants.standing(successor.grantId)).toBe("current");
  });
});
