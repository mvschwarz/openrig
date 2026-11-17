import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { attachAgentActivity, getNodeInventory } from "../src/domain/node-inventory.js";

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

const lastIdle = { state: "idle", reason: "stop_hook", evidenceSource: "runtime_hook", sampledAt: "2026-01-01T00:00:00Z", evidence: null };
const lastRunning = { ...lastIdle, state: "running", reason: "prompt_submit_hook" };
async function activity(db: Database.Database, hook: object) {
  const [entry] = getNodeInventory(db, "rig");
  const [out] = await attachAgentActivity([entry!], { tmuxAdapter: {} as never, activityStore: { getLatestForNode: () => hook } as never });
  return { entry: entry!, activity: out!.agentActivity! };
}

describe("rig ps after the seat's tmux server is gone", () => {
  it("a server that's gone reads the seat stopped, not idle", async () => {
    const db = fixture();
    const tmux = noListing({ state: "transport_unavailable", cause: "no server running on /tmp/tmux-501/default" });
    await new SeatIdentityReconciler({ db, tmux }).reconcileAll();
    expect(tmux.probeSession).toHaveBeenCalledWith("worker@rig");
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ verdict: "pane_missing", reason: "session_missing" });
    const { entry, activity: read } = await activity(db, lastIdle);
    expect(entry).toMatchObject({ sessionStatus: "detached", storedSessionStatus: "running" });
    expect(entry.lifecycleState).not.toBe("running");
    expect(read).toMatchObject({ state: "unknown", reason: "session_missing" });
  });

  it("a live server without the session reads it stopped too", async () => {
    const db = fixture();
    await new SeatIdentityReconciler({ db, tmux: noListing({ state: "absent" }) }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ reason: "session_missing" });
    expect((await activity(db, lastIdle)).activity.state).toBe("unknown");
  });

  it("tmux it can't read reads unknown: the seat isn't called stopped, and its last idle isn't served", async () => {
    const db = fixture();
    await new SeatIdentityReconciler({ db, tmux: noListing({ state: "transport_unavailable", cause: "error connecting to /tmp/tmux-501/default (Permission denied)" }) }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
    const idle = await activity(db, lastIdle);
    expect(idle.entry.sessionStatus).toBe("running");
    expect(idle.activity).toMatchObject({ state: "unknown", reason: "tmux_unavailable" });
    // A working reading is the agent's own report of work, and stays.
    expect((await activity(db, lastRunning)).activity.state).toBe("running");
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
  });
});
