import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createDefaultRestoreRig } from "../src/domain/crash-cart-conductor.js";

const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(opts: { status?: string; noRow?: boolean; token?: string | null; policy?: string; kind?: string } = {}) {
  const db = createFullTestDb(); databases.push(db);
  const live = new Set<string>();
  const tmux = {
    hasSession: vi.fn(async (name: string) => live.has(name)),
    probeSession: vi.fn(async (name: string) => ({ state: live.has(name) ? "present" : "absent" })),
    createSession: vi.fn(async (name: string) => { live.add(name); return { ok: true }; }),
    killSession: vi.fn(async (name: string) => { live.delete(name); return { ok: true }; }),
    listSessions: vi.fn(async () => [...live].map(name => ({ name }))),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%fixture", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 100),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n❯"),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    setSessionOption: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  const setup = createTestApp(db, { tmux, wireRuntimeAdapters: true, listProcesses: async () => [
    {pid:100,ppid:1,pgid:100,tpgid:100,executableName:"bash",command:"-bash",startedAt:"Sat Oct 10 20:00:00 2026"}
  ] });
  const { rigRepo, sessionRegistry, snapshotCapture } = setup;
  const rig = rigRepo.createRig("stopped-review");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "Review");
  const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "claude-code", podId: "pod", cwd: "/tmp" });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
  if (!opts.noRow) {
    const row = sessionRegistry.registerSession(node.id, "dev-worker@stopped-review");
    sessionRegistry.updateStatus(row.id, opts.status ?? "exited");
    sessionRegistry.updateStartupStatus(row.id, "ready");
    if (opts.token !== null) sessionRegistry.updateResumeToken(row.id, "claude_id", opts.token ?? "00000000-0000-4000-8000-000000000005", "hook");
    if (opts.policy) db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?").run(opts.policy, row.id);
  }
  const snapshot = snapshotCapture.captureSnapshot(rig.id, (opts.kind ?? "manual") as never);
  const post = (path: string, body: unknown = {}) => setup.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...setup, db, tmux, rig, node, snapshot, post, live };
}


// A preserved idle shell's advice forecasts what launching from the pinned snapshot would do. For a
// snapshot taken while the seat was stopped, that forecast must follow the restore's own absent-history
// rule: with an earlier token it asks for a decision, without one it starts fresh (dev-review, 41a6b3ba).
describe("stopped-seat preserved-shell forecast",()=>{
  it.each(["history-token","no-token"])("preserved-shell advice agrees with the pinned snapshot apply: %s",async mode=>{
    const h=fixture(mode==="no-token"?{token:null}:{});
    const name="dev-worker@stopped-review";
    const session=h.sessionRegistry.getSessionsForRig(h.rig.id).find(s=>s.nodeId===h.node.id)!;
    // The chosen snapshot was taken while stopped. A later launch now left a preserved shell.
    h.sessionRegistry.updateStatus(session.id,"running");
    h.sessionRegistry.updateBinding(h.node.id,{tmuxSession:name,tmuxPane:"%fixture"});
    h.live.add(name);vi.mocked(h.tmux.getPaneCommand).mockResolvedValue("bash");
    const endpoint=`/api/rigs/${h.rig.id}/nodes/launch-subset`;
    const body={seats:[h.node.logicalId],snapshotId:h.snapshot.id};
    const adviceResponse=await h.post(endpoint,body);
    const advice=await adviceResponse.json();
    expect(adviceResponse.status).toBe(409);
    expect(advice.launched[0].status).toBe("attention_required");
    expect(advice.launched[0].error).toMatch(/Session alive, agent not running/);
    expect(h.tmux.createSession).not.toHaveBeenCalled();
    // Emulate a successful stop's durable state, retaining the selected snapshot.
    h.sessionRegistry.updateStatus(session.id,"exited");h.sessionRegistry.clearBinding(h.node.id);h.live.delete(name);
    vi.mocked(h.tmux.getPaneCommand).mockResolvedValue("claude");
    const applied=await (await h.post(endpoint,body)).json();
    const promised=advice.launched[0].error.includes("start a fresh conversation")?"fresh-primed":"awaiting-decision";
    expect(applied.launched[0].status,"advice must forecast the same pinned snapshot").toBe(promised);
  });
  // In a rig whose other seats started, `rig up --existing --fresh` is refused (rig_not_stopped), so the
  // held seat's own fresh start is `rig seat launch <seat> --fresh`.
  it("a held seat in a rig whose other seats started can be started fresh on its own",async()=>{
    const h=fixture();
    const peer=h.rigRepo.addNode(h.rig.id,"dev.newcomer",{runtime:"claude-code",podId:"pod",cwd:"/tmp"});
    h.db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(peer.id);
    h.snapshotCapture.captureSnapshot(h.rig.id,"manual");
    const up=await (await h.post(`/api/rigs/${h.rig.id}/up`)).json();
    expect(up.nodes.find((n:any)=>n.nodeId===h.node.id)?.status).toBe("awaiting-decision");
    expect(up.nodes.find((n:any)=>n.nodeId===peer.id)?.status).toBe("fresh-primed");
    const retry=await h.post("/api/up",{sourceRef:h.rig.name,existing:true,freshLogicalIds:[h.node.logicalId]});
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe("rig_not_stopped");
    const fresh=await h.post(`/api/seat/launch/${encodeURIComponent(`${h.node.logicalId}@${h.rig.name}`)}`,{fresh:true,reason:"start the held seat fresh"});
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).ok).toBe(true);
  });
});
