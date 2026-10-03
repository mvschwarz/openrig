import { ClaimService } from "../src/domain/claim-service.js";
import { TerminalSessionBroker } from "../src/terminal/TerminalSessionBroker.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { ModelDivergenceMonitor } from "../src/domain/model-divergence/model-divergence-monitor.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { downRoutes } from "../src/routes/down.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, formatWatchdogDeliveryMessage } from "../src/domain/watchdog-policy-engine.js";
import { Hono } from "hono";
import { seatRoutes } from "../src/routes/seat.js";
import { transportRoutes } from "../src/routes/transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { SeatDeliveryGuard, type GuardTarget } from "../src/domain/seat-delivery-guard.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('a'),('b');");
  db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
  const targets: Record<string, GuardTarget> = {
    a: { nodeId: "a", session: "a", occupant: "g1", pane: "%1" },
    b: { nodeId: "b", session: "b", occupant: "g2", pane: "%2" },
  };
  return { db, targets, guard: new SeatDeliveryGuard(db, name => Object.values(targets).find(t => t.nodeId === name || t.session === name || t.pane === name) ?? null), outbox: new OutboxHandler(db) };
}
function signal() { let release!: () => void; const ready = new Promise<void>(r => { release = r; }); return { ready, release }; }

describe("delivery pause and durable custody", () => {
  it("does not activate between paste/submit or before lifecycle finishes", async () => {
    const { db, guard } = fixture(); const pasted = signal(); const finish = signal(); const writes: string[] = [];
    const running = guard.operation("a", async () => {
      await guard.input("a", async () => { writes.push("paste"); }); pasted.release(); await finish.ready;
      await guard.input("a", async () => { writes.push("submit"); }); writes.push("lifecycle complete");
    });
    await pasted.ready;
    const pending = await guard.set("a", true, "actor", "protect draft", 1);
    expect(pending).toMatchObject({ desired: true, effective: false, pending: true });
    finish.release(); await running; await new Promise(r => setTimeout(r, 0));
    expect(writes).toEqual(["paste", "submit", "lifecycle complete"]);
    expect(guard.preference("a")).toMatchObject({ effective: true, pending: false });
    await expect(guard.input("a", async () => { writes.push("bad"); })).rejects.toMatchObject({ code: "typing_guard_enabled" });
    db.close();
  });
  it("service-level strict pause permits only explicit human input and sibling", async () => {
    const { db, guard } = fixture(); await guard.set("a", true, "actor", "draft"); const writes: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(guard.input("a", async () => { writes.push("automated"); })).rejects.toMatchObject({ code: "typing_guard_enabled" });
    }
    await guard.humanInput("a", () => guard.input("a", async () => { writes.push("human"); }));
    await guard.input("b", async () => { writes.push("sibling"); });
    expect(writes).toEqual(["human", "sibling"]);
    await guard.set("a", false, "actor", "resume new delivery");
    await guard.input("a", async () => { writes.push("off"); }); expect(writes.at(-1)).toBe("off"); db.close();
  });
  it("refuses stale occupants, unknown identity and escaped lease writes", async () => {
    const { db, guard, targets } = fixture();
    await guard.operation("a", async () => {
      targets.a = { ...targets.a!, occupant: "replacement" };
      await expect(guard.input("a", async () => {})).rejects.toMatchObject({ code: "guard_target_changed" });
    });
    await expect(guard.input("unknown", async () => {})).rejects.toMatchObject({ code: "guard_target_unknown" });
    const go=signal(); let detached!: Promise<void>;
    await guard.operation("a", async () => { detached = go.ready.then(() => guard.input("a", async () => {})); });
    await guard.set("a", true, "actor", "pause");go.release();
    await expect(detached).rejects.toMatchObject({ code: "typing_guard_enabled" }); db.close();
  });
  it("retains one ID; detects mismatch; retirement frees quota without deleting evidence", () => {
    const { db, targets, outbox } = fixture(); const input = { outboxId: "id", senderSession: "sender", destinationSession: "a", body: "draft-safe" };
    expect(outbox.retain(input, targets.a!).deliveryState).toBe("retained");
    expect(outbox.retain(input, targets.a!).outboxId).toBe("id");
    expect(() => outbox.retain({ ...input, body: "different" }, targets.a!)).toThrow("different content");
    expect(outbox.markDelivered("id").deliveryState).toBe("retained");
    expect(outbox.retire("id", "person", "read outside pane")).toMatchObject({ deliveryState: "retired", deliveredAt: null, body: "draft-safe", retiredBy: "person" });
    expect(outbox.heldForNode("a").total).toBe(0);
    expect(outbox.listPending("id")).toEqual([]); db.close();
  });
  it("rolls back rejected staging but retains committed overflow members with original bodies", () => {
    const { db, targets, outbox } = fixture();
    for(let i=0;i<100;i++) outbox.retain({ outboxId: `h${i}`, senderSession: "s", destinationSession:"a", body:`body${i}` },targets.a!);
    const next={outboxId:"next",senderSession:"s",destinationSession:"a",body:"new"};
    expect(() => db.transaction(() => { outbox.retain(next,targets.a!); })()).toThrow("quota");
    expect(outbox.getById("next")).toBeNull();
    for(const id of ["committed1","committed2"]) { outbox.record({...next,outboxId:id,body:id});outbox.claimForDelivery(id);outbox.retain({...next,outboxId:id,body:id},targets.a!,true); }
    expect(outbox.heldForNode("a",100).total).toBe(102);expect(outbox.heldForNode("a",100).truncated).toBe(true);
    expect(outbox.getById("committed2")!.body).toBe("committed2");
    outbox.retire("h0","person","ack");outbox.retire("h1","person","ack");outbox.retire("h2","person","ack");
    expect(outbox.retain(next,targets.a!).deliveryState).toBe("retained");db.close();
  });
  it("guard DB failure cannot fall through to input; crash activation honors desired", async () => {
    const { db, guard } = fixture(); let writes=0;
    db.prepare("INSERT INTO seat_delivery_guards VALUES ('a',1,0,'actor','crash','now')").run();
    guard.recoverActivation();expect(guard.preference("a")).toMatchObject({desired:true,effective:true});
    db.exec("DROP TABLE seat_delivery_guards");await expect(guard.input("a", async () => {writes++;})).rejects.toThrow();
    expect(writes).toBe(0);db.close();
  });
});

function transportFixture() {
  const f = fixture();
  const commands: string[] = [];
  const files: string[] = [];
  const tmux = new TmuxAdapter(async command => { commands.push(command); return ""; }, {
    writeFile: async (_path, text) => { files.push(text); }, unlink: async () => {},
    tmpName: () => "/inert/launch", bufferName: () => "inert-buffer",
  });
  tmux.deliveryGuard = f.guard;
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => {
    const target = f.guard.maybeTarget(name);
    return target?.pane ? [{ id: target.pane } as never] : [];
  });
  const transport = new SessionTransport({ db: f.db, tmuxAdapter: tmux, rigRepo: {} as never, sessionRegistry: {} as never, sleep: async () => {} });
  return { ...f, tmux, transport, commands, files };
}

describe("real adapter/transport guard boundaries with no external effects", () => {
  it("retains raw/force/verify/danger sends without even capturing or writing; submit-only refuses", async () => {
    const f = transportFixture(); await f.guard.set("a", true, "person", "draft");
    for (const options of [{}, {force:true}, {verify:true}, {dangerouslyInteract:true,reason:"explicit"}, {waitForIdleMs:10}]) {
      const result = await f.transport.send("a", "message", options);
      expect(result).toMatchObject({ok:true,outcome:"retained",sent:false,verified:false});
      expect(result.outboxIds).toHaveLength(1);
    }
    expect(await f.transport.send("a", "", {submitOnly:true,expectedStagedText:"message"})).toMatchObject({ok:false,reason:"typing_guard_enabled",sent:false});
    expect(f.commands).toEqual([]);expect(f.files).toEqual([]);expect(f.tmux.listPanes).not.toHaveBeenCalled();
    expect(f.outbox.heldForNode("a").total).toBe(5);f.db.close();
  });
  it("one retained ID stays not-delivered after disable/retirement, and preserves committed coalesced IDs", async () => {
    const f = transportFixture();await f.guard.set("a",true,"person","draft");
    const opts={deliveryId:"exact",actorSession:"sender"};
    await f.transport.send("a","body",opts);await f.transport.send("a","body",opts);
    expect(f.outbox.heldForNode("a").total).toBe(1);
    expect(await f.transport.send("a","changed",opts)).toMatchObject({ok:false,reason:"delivery_identity_conflict"});
    for (const id of ["wake1","wake2"]) { f.outbox.record({outboxId:id,senderSession:"sender",destinationSession:"a",body:`original ${id}`});f.outbox.claimForDelivery(id); }
    expect(await f.transport.send("a","combined",{committedOutboxIds:["wake1","wake2"]})).toMatchObject({outcome:"retained",outboxIds:["wake1","wake2"]});
    expect(f.outbox.getById("wake2")!.body).toBe("original wake2");
    await f.guard.set("a",false,"person","new sends only");f.outbox.retire("exact","person","acknowledge");
    expect(await f.transport.send("a","body",opts)).toMatchObject({outcome:"retained",sent:false});
    expect(f.commands).toEqual([]);expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get()).toEqual({n:3});f.db.close();
  });
  it("automatic low-level keys/text/shell and lifecycle creation refuse, human broker path and sibling write", async () => {
    const f=transportFixture();await f.guard.set("a",true,"person","draft");
    expect(await f.tmux.sendText("a","automatic")).toMatchObject({ok:false,code:"typing_guard_enabled"});
    expect(await f.tmux.sendKeys("%1",["Enter"])).toMatchObject({ok:false,code:"typing_guard_enabled"});
    expect(await f.tmux.sendShellCommand("a","command")).toMatchObject({ok:false,code:"typing_guard_enabled"});
    expect(await f.tmux.createSession("a",undefined,{OPENRIG_NODE_ID:"a"})).toMatchObject({ok:false,code:"guard_lease_required"});
    expect(f.commands).toEqual([]);
    expect(await f.tmux.humanInput("a",()=>f.tmux.sendKeys("a",["x"]))).toEqual({ok:true});
    expect(await f.tmux.sendKeys("b",["Enter"])).toEqual({ok:true});
    expect(f.commands).toHaveLength(2);expect(f.commands[0]).toContain("%1");expect(f.commands[1]).toContain("%2");f.db.close();
  });
  it("checks actual pane identity after asynchronous observation and refuses replacement/unknown targets", async () => {
    const f=transportFixture();
    vi.mocked(f.tmux.listPanes).mockResolvedValue([{id:"%replacement"} as never]);
    expect(await f.tmux.sendText("a","bad")).toMatchObject({ok:false,code:"guard_target_unknown"});
    expect(await f.tmux.sendKeys("unknown",["Enter"])).toMatchObject({ok:false,code:"guard_target_unknown"});
    vi.mocked(f.tmux.listPanes).mockImplementation(async () => { f.targets.a={...f.targets.a!,occupant:"other"};return [{id:"%1"} as never]; });
    expect(await f.tmux.sendKeys("a",["Enter"])).toMatchObject({ok:false,code:"guard_target_changed"});
    expect(f.commands).toEqual([]);expect(f.files).toEqual([]);f.db.close();
  });
  it("whole multi-node lifecycle keeps activation pending through rebind and final submit", async () => {
    const f=transportFixture();const started=signal(),finish=signal();
    const work=f.guard.lifecycle(["b","a"],async()=>{
      started.release();await finish.ready;
      f.targets.a={...f.targets.a!,occupant:"new",pane:"%3"};f.guard.rebindLifecycle("a");
      await f.guard.lifecycle(["a"],async()=>{expect(await f.tmux.sendKeys("a",["Enter"])).toEqual({ok:true});});
    });
    await started.ready;expect(await f.guard.set("a",true,"person","draft",1)).toMatchObject({pending:true,effective:false});
    finish.release();await work;await new Promise(r=>setTimeout(r,0));
    expect(f.guard.preference("a").effective).toBe(true);expect(f.commands).toHaveLength(1);expect(f.commands[0]).toContain("%3");f.db.close();
  });
  it("private probe exemption requires fresh allocation, never an existing managed or recycled pane", async () => {
    const f=transportFixture();await f.guard.set("a",true,"person","draft");
    expect(await f.tmux.createProbeSession("a")).toMatchObject({ok:false,code:"guard_target_managed"});
    expect(f.commands).toEqual([]);
    vi.mocked(f.tmux.listPanes).mockResolvedValue([{id:"%probe"} as never]);
    expect(await f.tmux.createProbeSession("private-probe")).toEqual({ok:true});
    expect(await f.tmux.sendKeys("private-probe",["Enter"])).toEqual({ok:true});
    const count=f.commands.length;
    vi.mocked(f.tmux.listPanes).mockResolvedValue([{id:"%recycled"} as never]);
    expect(await f.tmux.sendText("private-probe","bad")).toMatchObject({ok:false});
    expect(await f.tmux.killSession("private-probe")).toMatchObject({ok:false});
    expect(f.commands).toHaveLength(count);f.db.close();
  });
});

function queueFixture() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','rig','worker'),('b','rig','sibling');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  const guard = new SeatDeliveryGuard(db, name=>resolveGuardTarget(db,name));
  const writes:string[]=[];
  const tmux = new TmuxAdapter(async command=>{writes.push(command);return "";}); tmux.deliveryGuard=guard;
  const rigRepo=new RigRepository(db), sessionRegistry=new SessionRegistry(db);
  db.exec("INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');");
  vi.spyOn(tmux,"probeSession").mockResolvedValue({state:"present"});
  vi.spyOn(tmux,"getPaneCommand").mockResolvedValue("bash");
  vi.spyOn(tmux,"listPanes").mockImplementation(async name=>[{id:guard.target(name).pane!} as never]);
  const transport=new SessionTransport({db,tmuxAdapter:tmux,rigRepo,sessionRegistry,sleep:async()=>{}});
  const bus=new EventBus(db), outbox=new OutboxHandler(db);
  const repo=new QueueRepository(db,bus,{validateRig:()=>true,transport,loadHumanRegistry:()=>({ok:true,entities:[],warnings:[]})});
  repo.attachOutbox(outbox);
  return {db,guard,transport,outbox,bus,repo,writes,tmux,rigRepo,sessionRegistry};
}

describe("real queue transaction and retained delivery",()=>{
  it("precommit quota refusal rolls back closure, successor, transitions and events",async()=>{
    const f=queueFixture();const source=await f.repo.create({sourceSession:"sender@test",destinationSession:"relay@test",body:"work",nudge:false});
    await f.guard.set("a",true,"person","draft");
    for(let i=0;i<100;i++) f.outbox.retain({outboxId:`full${i}`,senderSession:"sender@test",destinationSession:"worker@test",body:"held"},f.guard.target("a"));
    const before=JSON.stringify(f.db.prepare("SELECT * FROM queue_transitions").all());
    const events=JSON.stringify(f.db.prepare("SELECT * FROM events").all());
    await expect(f.repo.handoff({qitemId:source.qitemId,fromSession:"relay@test",toSession:"worker@test"})).rejects.toThrow("quota");
    expect(f.repo.getById(source.qitemId)!.state).toBe("pending");
    expect(f.db.prepare("SELECT count(*) n FROM queue_items").get()).toEqual({n:1});
    expect(JSON.stringify(f.db.prepare("SELECT * FROM queue_transitions").all())).toBe(before);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM events").all())).toBe(events);
    expect(f.writes).toEqual([]);f.db.close();
  });
  it("handoff retains one audited intent without duplicate transport record or delivered label",async()=>{
    const f=queueFixture();const source=await f.repo.create({sourceSession:"sender@test",destinationSession:"relay@test",body:"work",nudge:false});
    await f.guard.set("a",true,"person","draft");
    const {created,closed}=await f.repo.handoff({qitemId:source.qitemId,fromSession:"relay@test",toSession:"worker@test"});
    expect(closed.state).toBe("handed-off");expect(created.state).toBe("pending");expect(created.lastNudgeResult).toBe("retained:typing_guard");
    const held=f.outbox.heldForNode("a");expect(held.total).toBe(1);
    expect(held.items[0]).toMatchObject({outboxId:`wake-intent-${created.qitemId}`,auditPointer:created.qitemId,deliveryState:"retained",deliveredAt:null,guardBinding:{nodeId:"a",occupant:"g1",pane:"%1"}});
    expect(held.items[0]!.body).toContain(created.qitemId);
    await f.repo.deliverWakeForSuccessor(created.qitemId,"worker@test",true,"relay@test");
    await f.guard.set("a",false,"person","new sends");
    expect(await f.repo.drainPendingWakeIntents()).toEqual({delivered:0,indeterminate:0,failed:0,retained:0});
    f.outbox.retire(held.items[0]!.outboxId,"person","read");
    expect(f.repo.getById(created.qitemId)!.state).toBe("pending");expect(f.writes).toEqual([]);f.db.close();
  });
  it("postcommit activation retains exact staged intent beyond quota, without fictional rollback",async()=>{
    const f=queueFixture();const source=await f.repo.create({sourceSession:"sender@test",destinationSession:"relay@test",body:"work",nudge:false});
    for(let i=0;i<100;i++) f.outbox.retain({outboxId:`full${i}`,senderSession:"sender@test",destinationSession:"worker@test",body:"held"},f.guard.target("a"));
    let activation:Promise<unknown>|undefined;
    const off=f.bus.subscribe(event=>{if(event.type==="queue.handed_off") activation=f.guard.set("a",true,"person","postcommit");});
    const {created,closed}=await f.repo.handoff({qitemId:source.qitemId,fromSession:"relay@test",toSession:"worker@test"});
    await activation;off();expect(closed.state).toBe("handed-off");expect(created.lastNudgeResult).toBe("retained:typing_guard");
    expect(f.outbox.heldForNode("a").total).toBe(101);expect(f.outbox.getById(`wake-intent-${created.qitemId}`)!.body).toContain(created.qitemId);
    expect(f.writes).toEqual([]);f.db.close();
  });
  it("pending coalesced members retain individual frozen bodies and refuse a changed occupant",async()=>{
    const f=queueFixture();const ids:string[]=[];
    for(let i=0;i<2;i++) {
      const item=await f.repo.create({sourceSession:"sender@test",destinationSession:"worker@test",body:`work${i}`,nudge:false});
      f.repo.stageWakeIntent(item.qitemId,"sender@test","worker@test",null,true);ids.push(`wake-intent-${item.qitemId}`);
      f.db.prepare("UPDATE outbox_entries SET tags=? WHERE outbox_id=?").run(JSON.stringify(["queue:return:common"]),ids[i]);
    }
    const bodies=ids.map(id=>f.outbox.getById(id)!.body);
    await f.guard.set("a",true,"person","pause");await f.repo.drainPendingWakeIntents();
    for(let i=0;i<2;i++) expect(f.outbox.getById(ids[i]!)!).toMatchObject({body:bodies[i],deliveryState:"retained",deliveredAt:null});
    expect(f.outbox.heldForNode("a").total).toBe(2);expect(f.writes).toEqual([]);
    const item=await f.repo.create({sourceSession:"sender@test",destinationSession:"sibling@test",body:"old generation",nudge:false});
    f.repo.stageWakeIntent(item.qitemId,"sender@test","sibling@test",null,true);
    f.db.prepare("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('gb2','b',2,'new','fresh')").run();
    await f.repo.drainPendingWakeIntents();
    expect(f.outbox.getById(`wake-intent-${item.qitemId}`)!.deliveryState).toBe("failed");
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toContain("identity changed");expect(f.writes).toEqual([]);f.db.close();
  });
});

function httpFixture() {
  const f=queueFixture();const app=new Hono();
  app.use("*",async(c,next)=>{
    c.set("tmuxAdapter" as never,f.tmux);c.set("rigRepo" as never,f.rigRepo);
    c.set("sessionRegistry" as never,f.sessionRegistry);c.set("eventBus" as never,f.bus);
    c.set("sessionTransport" as never,f.transport);c.set("outboxHandler" as never,f.outbox);await next();
  });
  app.route("/api/rigs",rigsRoutes);app.route("/api/seat",seatRoutes);app.route("/api/transport",transportRoutes());
  const post=async(path:string,body:unknown)=>app.request(path,{method:"POST",headers:{"content-type":"application/json","x-openrig-session":"human@test"},body:JSON.stringify(body)});
  return {...f,app,post};
}
describe("supported route effects and lifecycle preflight",()=>{
  it("enable/read/send/retire/read-by-ID/disable exposes actual custody once, no body actor override",async()=>{
    const f=httpFixture();
    expect((await f.post("/api/seat/set-typing-guard/worker@test",{enabled:true,reason:"draft"})).status).toBe(200);
    const status=await (await f.app.request("/api/seat/status/worker@test")).json();expect(status.typingGuard).toMatchObject({desired:true,effective:true,heldCount:0});
    for(let i=0;i<2;i++) {
      const r=await f.post("/api/transport/send",{session:"worker@test",text:"message",deliveryId:"http-id",actorSession:"spoof@test",verify:true,force:true});
      expect(r.status).toBe(200);expect(await r.json()).toMatchObject({outcome:"retained",sent:false,outboxIds:["http-id"]});
    }
    expect(f.outbox.getById("http-id")!).toMatchObject({senderSession:"human@test",deliveryState:"retained",deliveredAt:null});
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({n:1});
    expect((await f.post("/api/transport/send",{session:"worker@test",text:"",submitOnly:true})).status).toBe(409);
    const list=await (await f.app.request("/api/seat/held-messages/worker@test")).json();expect(list.total).toBe(1);
    expect((await f.post("/api/seat/retire-held-message/sibling@test/http-id",{reason:"read"})).status).toBe(404);
    expect((await f.post("/api/seat/retire-held-message/worker@test/http-id",{reason:"read outside pane"})).status).toBe(200);
    const retired=await (await f.app.request("/api/seat/held-messages/worker@test?id=http-id")).json();
    expect(retired.entry).toMatchObject({deliveryState:"retired",body:"message",retiredBy:"human@test",retirementReason:"read outside pane",deliveredAt:null});
    await f.post("/api/seat/set-typing-guard/worker@test",{enabled:false,reason:"new sends"});
    expect(f.writes).toEqual([]);expect(f.db.prepare("SELECT count(*) n FROM seat_delivery_guard_changes").get()).toEqual({n:2});f.db.close();
  });
  it("broadcast and concurrent senders retain protected targets while sibling normal send remains active",async()=>{
    const f=httpFixture();await f.guard.set("a",true,"person","draft");
    const r=await f.post("/api/transport/broadcast",{sessions:["worker@test","sibling@test"],text:"broadcast",force:true});
    expect(r.status).toBe(200);expect(await r.json()).toMatchObject({total:2,sent:1,retained:1,failed:0});
    expect(f.writes.some(x=>x.includes("%2"))).toBe(true);expect(f.writes.some(x=>x.includes("%1"))).toBe(false);
    await Promise.all(["first","second"].map(actor=>f.transport.send("worker@test",actor,{actorSession:actor,deliveryId:actor})));
    expect(f.outbox.heldForNode("a").total).toBe(3);f.db.close();
  });
  it("remove refuses before fallback queue mutation and any terminal effect",async()=>{
    const f=queueFixture();const work=await f.repo.create({sourceSession:"sender@test",destinationSession:"worker@test",body:"owned",nudge:false});
    const lifecycle=new RigLifecycleService({db:f.db,rigRepo:f.rigRepo,sessionRegistry:f.sessionRegistry,discoveryRepo:new DiscoveryRepository(f.db),eventBus:f.bus,queueRepo:f.repo,tmuxAdapter:f.tmux});
    await f.guard.set("a",true,"person","draft");
    await expect(lifecycle.removeNode("rig","a",{fallbackDestination:"sibling@test"})).rejects.toMatchObject({code:"typing_guard_enabled"});
    expect(f.repo.getById(work.qitemId)!.destinationSession).toBe("worker@test");
    expect(f.rigRepo.getRig("rig")!.nodes).toHaveLength(2);expect(f.writes).toEqual([]);f.db.close();
  });
  it("reopens persisted preference/retention and reconciles attempted wakes without replay",async()=>{
    const f=queueFixture();await f.guard.set("a",true,"person","draft");await f.transport.send("worker@test","held",{deliveryId:"survivor"});
    f.outbox.record({outboxId:"wake-intent-crash",senderSession:"s",destinationSession:"worker@test",body:"attempted"});f.outbox.claimForDelivery("wake-intent-crash");
    const db=new Database(f.db.serialize());f.db.close();
    const guard=new SeatDeliveryGuard(db,name=>resolveGuardTarget(db,name));guard.recoverActivation();
    const outbox=new OutboxHandler(db);expect(guard.preference("a")).toMatchObject({desired:true,effective:true});
    outbox.reconcileAbandonedSending("wake-intent-");expect(outbox.getById("wake-intent-crash")!.deliveryState).toBe("indeterminate");
    expect(outbox.getById("survivor")!).toMatchObject({deliveryState:"retained",body:"held"});expect(outbox.listPending("")).toEqual([]);db.close();
  });
});

it("automatic reminder records retained custody and no delivered fire or input",async()=>{
  const f=queueFixture();await f.guard.set("a",true,"person","draft");
  const jobs=new WatchdogJobsRepository(f.db), history=new WatchdogHistoryLog(f.db);
  const job=jobs.register({policy:"periodic-reminder",targetSession:"worker@test",specYaml:"target:\n  session: worker@test\nmessage: reminder\n",intervalSeconds:60,registeredBySession:"sender@test"});
  const attempts:string[]=[];
  const engine=new WatchdogPolicyEngine({jobsRepo:jobs,historyLog:history,eventBus:f.bus,resolveTargetGeneration:()=>"g1",onWakeAttempt:x=>{attempts.push(x.deliveryStatus);},
    deliver:async(request,source)=>{
      const id=`guard-watchdog-${source.occurrenceId}`;
      const body=f.outbox.getById(id)?.body??formatWatchdogDeliveryMessage(source,request.message);
      const result=await f.transport.send(request.targetSession,body,{deliveryId:id,actorSession:"watchdog@system",auditPointer:source.jobId});
      return {status:result.outcome==="retained"?"retained":result.ok?"ok":"failed",outboxIds:result.outboxIds};
    }});
  const result=await engine.evaluate(job);
  expect(result.delivery?.status).toBe("retained");expect(result.history).toMatchObject({outcome:"skipped",skipReason:"typing_guard_retained",deliveryStatus:"retained"});
  expect(result.history!.evaluationNotes).toMatchObject({retainedNotDelivered:true});
  expect(attempts).toEqual(["retained"]);expect(f.outbox.heldForNode("a").items[0]!.auditPointer).toBe(job.jobId);
  expect(f.writes).toEqual([]);f.db.close();
});

 it("whole lifecycle refuses launch, teardown, stop, clean and delete before effects with typed HTTP refusal",async()=>{
  const f=httpFixture();await f.guard.set("a",true,"person","draft");
  const snapshot={db:f.db,capture:vi.fn()} as never;
  const launcher=new NodeLauncher({db:f.db,rigRepo:f.rigRepo,sessionRegistry:f.sessionRegistry,eventBus:f.bus,tmuxAdapter:f.tmux});
  const teardown=new RigTeardownOrchestrator({db:f.db,rigRepo:f.rigRepo,sessionRegistry:f.sessionRegistry,eventBus:f.bus,tmuxAdapter:f.tmux,snapshotCapture:snapshot});
  await expect(launcher.launchNode("rig","worker")).rejects.toMatchObject({code:"typing_guard_enabled"});
  await expect(teardown.teardown("rig",{delete:true,force:true})).rejects.toMatchObject({code:"typing_guard_enabled"});
  for(const verb of ["stop","clean","launch"]) {
    const res=await f.post(`/api/seat/${verb}/worker@test`,{reason:"test",fresh:true,stop:true});
    expect(res.status).toBe(409);expect(await res.json()).toMatchObject({code:"typing_guard_enabled"});
  }
  const down=new Hono();down.use("*",async(c,next)=>{c.set("teardownOrchestrator" as never,teardown);await next();});down.route("/",downRoutes);
  expect((await down.request("/",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rigId:"rig",delete:true,force:true})})).status).toBe(409);
  expect((await f.app.request("/api/rigs/rig",{method:"DELETE"})).status).toBe(409);
  expect(f.rigRepo.getRig("rig")!.nodes).toHaveLength(2);expect(f.writes).toEqual([]);expect((snapshot as any).capture).not.toHaveBeenCalled();f.db.close();
 });
 it("fresh launch off rebinds the original lease, then protection prevents lifecycle and stale writes",async()=>{
  const f=queueFixture();f.db.exec("INSERT INTO nodes(id,rig_id,logical_id) VALUES ('c','rig','fresh');");
  vi.mocked(f.tmux.listPanes).mockImplementation(async name=>[{id:name==="r00-test-fresh"?"%3":f.guard.target(name).pane!} as never]);
  const launcher=new NodeLauncher({db:f.db,rigRepo:f.rigRepo,sessionRegistry:f.sessionRegistry,eventBus:f.bus,tmuxAdapter:f.tmux});
  const launched=await launcher.launchNode("rig","fresh");expect(launched.ok).toBe(true);
  expect(f.guard.target("c")).toMatchObject({pane:"%3",session:"r00-test-fresh"});
  await f.guard.set("c",true,"person","draft");const count=f.writes.length;
  expect(await f.tmux.sendText("r00-test-fresh","no")).toMatchObject({ok:false,code:"typing_guard_enabled"});expect(f.writes).toHaveLength(count);f.db.close();
 });
 it("guarded session termination binds the immutable session ID, never recycled name",async()=>{
  const {db,guard}=fixture();const commands:string[]=[];
  const tmux=new TmuxAdapter(async command=>{commands.push(command);return command.includes("display-message")?"$123\n":"";});tmux.deliveryGuard=guard;
  vi.spyOn(tmux,"listPanes").mockResolvedValue([{id:"%1"} as never]);
  expect(await guard.lifecycle(["a"],()=>tmux.killSession("a"))).toEqual({ok:true});
  expect(commands.at(-1)).toBe("tmux kill-session -t '$123'");db.close();
 });

 it("failed first binding compensates only its proven fresh session under the same lifecycle lease",async()=>{
  const f=queueFixture();f.db.exec("INSERT INTO nodes(id,rig_id,logical_id) VALUES ('c','rig','fresh');");
  const commands:string[]=[];const tmux=new TmuxAdapter(async command=>{commands.push(command);return command.includes("display-message")?"$44\n":"";});tmux.deliveryGuard=f.guard;
  vi.spyOn(tmux,"listPanes").mockResolvedValue([{id:"%3"} as never]);
  vi.spyOn(f.bus,"persistWithinTransaction").mockImplementation(()=>{throw Error("injected DB failure");});
  const launcher=new NodeLauncher({db:f.db,rigRepo:f.rigRepo,sessionRegistry:f.sessionRegistry,eventBus:f.bus,tmuxAdapter:tmux});
  expect(await launcher.launchNode("rig","fresh")).toMatchObject({ok:false,code:"db_error"});
  expect(commands.at(-1)).toBe("tmux kill-session -t '$44'");expect(f.guard.target("c").pane).toBeNull();f.db.close();
 });
 it("private probe termination uses only its positively allocated session identity",async()=>{
  const {db,guard}=fixture();const commands:string[]=[];
  const tmux=new TmuxAdapter(async command=>{commands.push(command);return command.includes("display-message")?"$55\n":"";});tmux.deliveryGuard=guard;
  vi.spyOn(tmux,"listPanes").mockResolvedValue([{id:"%55"} as never]);
  expect(await tmux.createProbeSession("probe")).toEqual({ok:true});expect(await tmux.killSession("probe")).toEqual({ok:true});
  expect(commands.at(-1)).toBe("tmux kill-session -t '$55'");const count=commands.length;
  expect(await tmux.sendKeys("probe",["Enter"])).toMatchObject({ok:false});expect(commands).toHaveLength(count);db.close();
 });

 it("claim hint is one retained notification, not an injected adoption message",async()=>{
  const f=queueFixture();await f.guard.set("a",true,"person","draft");
  const claim=new ClaimService({db:f.db,rigRepo:f.rigRepo,sessionRegistry:f.sessionRegistry,discoveryRepo:new DiscoveryRepository(f.db),eventBus:f.bus,tmuxAdapter:f.tmux});
  for(let i=0;i<2;i++)await (claim as any).deliverClaimHint("worker@test",{rigName:"test",logicalId:"worker"});
  expect(f.outbox.heldForNode("a").total).toBe(1);expect(f.outbox.heldForNode("a").items[0]).toMatchObject({senderSession:"claim@system",deliveryState:"retained",deliveredAt:null});
  expect(f.writes).toEqual([]);f.db.close();
 });
 it("broker explicit human text survives while its automatic redraw and compaction refuse",async()=>{
  const f=queueFixture();await f.guard.set("a",true,"person","draft");
  const broker=new TerminalSessionBroker("worker@test",f.tmux);
  await broker.input({type:"text",text:"human draft"});
  expect(f.writes.filter(command=>command.includes("paste-buffer"))).toHaveLength(1);
  expect(f.writes.some(command=>command.includes("send-keys"))).toBe(false);const count=f.writes.length;
  expect(await f.tmux.sendKeys("worker@test",["",""])).toMatchObject({ok:false,code:"typing_guard_enabled"});
  const settings={
    resolveClaudeCompactionPolicy:()=>({enabled:true,thresholdPercent:80,preCompactInstruction:"prep",compactInstruction:"",messageInline:"",messageFilePath:"",postRestoreAuditInstruction:"audit"}),
    resolveOne:()=>{throw Error("unexpected individual setting read while guarded");},
  } as never;
  const enforcer=new ClaudeCompactionEnforcer(settings,f.transport,{openrigHome:process.env.OPENRIG_HOME});
  const input={sessionName:"worker@test",runtime:"claude-code",usedPercentage:99};
  expect(await enforcer.maybeAutoCompact(input)).toMatchObject({triggered:false,reason:"typing_guard_enabled"});
  expect(await enforcer.triggerManualCompact(input,{operatorInitiated:true})).toMatchObject({triggered:false,reason:"typing_guard_enabled"});
  expect(f.writes).toHaveLength(count);f.db.close();
 });
 it("model notice channels label retained custody and reuse producer identity without delivery claim",async()=>{
  const f=queueFixture();await f.guard.set("a",true,"person","draft");const recorded:any[]=[];
  const monitor=new ModelDivergenceMonitor({listPinnedSeats:()=>[{nodeId:"b",sessionName:"sibling@test",rigId:"rig",rigName:"test",runtime:"codex",pinnedModel:"gpt-5.1-codex-mini",generation:"g2"}],
   readEffectiveModel:()=>({ok:true,model:"gpt-5.4-mini"}),resolveOrchSeats:()=>["worker@test"],resolveOperatorSeat:()=>null,resolveOversightSeat:()=>null,recordProclamation:p=>recorded.push(p),warn:()=>{},
   sendToSession:async(target,message,id)=>{
    const result=await f.transport.send(target,f.outbox.getById(id!)?.body??message,{deliveryId:id,actorSession:"model-monitor@system",auditPointer:id});return {ok:result.ok,outcome:result.outcome};
   }});
  await monitor.checkOnce();expect(recorded).toHaveLength(1);expect(recorded[0].channels[0]).toMatchObject({status:"retained",target:"worker@test"});
  await monitor.checkOnce();expect(f.outbox.heldForNode("a").total).toBe(1);expect(f.writes).toEqual([]);f.db.close();
 });

 it("two wake drainers preserve one original intent without duplicate retained ownership",async()=>{
  const f=queueFixture();const item=await f.repo.create({sourceSession:"sender@test",destinationSession:"worker@test",body:"work",nudge:false});
  f.repo.stageWakeIntent(item.qitemId,"sender@test","worker@test",null,true);const id=`wake-intent-${item.qitemId}`;const body=f.outbox.getById(id)!.body;
  await f.guard.set("a",true,"person","draft");await Promise.all([f.repo.drainPendingWakeIntents(),f.repo.drainPendingWakeIntents()]);
  expect(f.outbox.heldForNode("a").items.map(entry=>entry.outboxId)).toEqual([id]);expect(f.outbox.getById(id)).toMatchObject({body,deliveryState:"retained",deliveredAt:null});expect(f.writes).toEqual([]);f.db.close();
 });
