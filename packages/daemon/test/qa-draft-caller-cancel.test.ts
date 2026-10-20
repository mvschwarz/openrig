// QA additions, retaining the real draft-aware integration fixture.
import Database from "better-sqlite3";
import { Hono } from "hono";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendOpts } from "../src/domain/session-transport.js";
import { seatRoutes } from "../src/routes/seat.js";
import { transportRoutes } from "../src/routes/transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n");
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

function signal() {
  let release!: () => void;
  return { ready: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

function fixture(saved?: Buffer, opts: { runtime?: string; idleHook?: boolean } = {}) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','${opts.runtime ?? "terminal"}'),('b','rig','sibling','terminal');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  }
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  const bodies: Record<string, string | null> = { a: "", b: "" };
  const history: Record<string, string> = { a: "", b: "" };
  const writes: string[] = [], submissions: string[] = [];
  const hooks: { load?: () => void | Promise<void>; paste?: () => void | Promise<void>; sleep?: (ms: number) => void | Promise<void> } = {};
  let staged = "";
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("load-buffer")) await hooks.load?.();
    const node = command.includes("%2") ? "b" : "a";
    if (command.includes("paste-buffer")) {
      await hooks.paste?.();
      writes.push(`paste:${node}:${staged}`); bodies[node] = staged;
    }
    if (command.includes("send-keys")) {
      writes.push(`keys:${node}:${command}`);
      if (command.includes("Enter")) {
        submissions.push(bodies[node] ?? ""); history[node] += `${bodies[node]}\n`; bodies[node] = "";
      }
    }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async name => {
    const body = bodies[guard.target(name).nodeId]; return body == null ? null : frame(body);
  });
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async name => {
    const node = guard.target(name).nodeId; return bodies[node] == null ? null : history[node] + frame(bodies[node]!).screen;
  });
  let at = Date.now();
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), outbox = new OutboxHandler(db);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo, sessionRegistry, now: () => new Date(at), sleep: async ms => { await hooks.sleep?.(ms); },
    agentActivityStore: { getLatestForNode: () => opts.idleHook === false ? null
      : ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  const guarded = transport.guardedDelivery!;
  const repo = new QueueRepository(db, new EventBus(db), { transport, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tmuxAdapter" as never, tmux); c.set("rigRepo" as never, rigRepo);
    c.set("sessionTransport" as never, transport); c.set("outboxHandler" as never, outbox); await next();
  });
  app.route("/api/seat", seatRoutes); app.route("/api/transport", transportRoutes());
  cleanup.push(async () => { await guarded.stop(); db.close(); });
  return { db, guard, tmux, transport, guarded, outbox, repo, app, bodies, history, writes, submissions, hooks,
    advance: (ms = 4000) => { at += ms; },
    enable: (settings = {}) => guard.set("a", { mode: "draft-aware", ...settings }, "human@test", "keep draft"),
    send: (id: string, text = "incoming message", opts: SendOpts = {}) => transport.send("worker@test", text, { deliveryId: id, actorSession: "human@test", verify: true, ...opts }),
    post: (path: string, body: unknown, actor = "human@test") => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": actor }, body: JSON.stringify(body) }),
  };
}



describe("independent QA draft-aware cancellation boundary",()=>{
  it("an abort during lease wait before any record exists must never later commit and type",async()=>{
    const f=fixture();await f.enable();const entered=signal();const release=signal();
    const holder=f.guard.operation("worker@test",async()=>{entered.release();await release.ready;});
    await entered.ready;
    const op=vi.spyOn(f.guard,"operation");const caller=new AbortController();
    const pending=f.app.request("/api/transport/send",{method:"POST",headers:{"content-type":"application/json","x-openrig-session":"human@test"},
      body:JSON.stringify({session:"worker@test",text:"QA WORK",deliveryId:"qa-before-commit"}),signal:caller.signal});
    await vi.waitFor(()=>expect(op).toHaveBeenCalled());caller.abort();
    const recordBeforeRelease=f.outbox.getById("qa-before-commit");
    console.log("QA PRECOMMIT CANCEL",JSON.stringify({aborted:caller.signal.aborted,recordBeforeRelease,writes:f.writes}));
    release.release();await holder;const response=await pending;const result=await response.json();
    console.log("QA POST RELEASE",JSON.stringify({status:response.status,result,submissions:f.submissions,record:f.outbox.getById("qa-before-commit")}));
    expect(recordBeforeRelease).toBeNull();
    expect(f.submissions).toEqual([]);
    expect(result).toMatchObject({reason:"caller_cancelled",sent:false,inputPhase:"not_reached"});
  });
  it("a cancel after draft-aware acceptance never cancels the accepted delivery",async()=>{
    const f=fixture();await f.enable();const caller=new AbortController();let committedAtAbort=false;
    f.hooks.load=()=>{committedAtAbort=f.outbox.getById("qa-after-commit")?.deliveryState==="sending";caller.abort();};
    const result=await f.send("qa-after-commit","QA WORK",{signal:caller.signal,verify:false});
    console.log("QA POSTCOMMIT CANCEL",JSON.stringify({committedAtAbort,result,submissions:f.submissions}));
    expect(committedAtAbort).toBe(true);expect(f.submissions).toEqual(["QA WORK"]);
    expect(result).toMatchObject({ok:true,sent:true});expect(result.reason).not.toBe("caller_cancelled");
  });
});
