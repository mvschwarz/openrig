import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { RESERVE_PREFIX, REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { createTestApp } from "./helpers/test-app.js";
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); cleanup.splice(0).reverse().forEach(f => f()); });
function fixture(file?: string) {
  const db = createDb(file); migrate(db, ALL_MIGRATIONS);
  const rigs = new RigRepository(db);
  for (const name of ["source", "target", "other"]) if (!rigs.listRigs().some(r => r.name === name)) rigs.createRig(name);
  const bus = new EventBus(db); const queue = new QueueRepository(db, bus, { validateRig: () => true });
  const jobs = new WatchdogJobsRepository(db);
  const begin = (name: string) => queue.deliveryDrains.begin(rigs.listRigs().find(r => r.name === name)!.id,
    { drainId: "window", owner: "owner@other", reviewAt: new Date(Date.now() + 60_000).toISOString() }, jobs);
  return { db, rigs, bus, queue, jobs, begin };
}
async function baton(t: ReturnType<typeof fixture>, dest = "worker@target", source = "relay@source") {
  const first = await t.queue.create({ sourceSession: "sender@source", destinationSession: source, body: "work", nudge: false });
  const { created } = await t.queue.handoff({ qitemId: first.qitemId, fromSession: source, toSession: dest, nudge: false });
  t.db.prepare("UPDATE queue_items SET last_nudge_attempt=?,last_nudge_result='failed:offline' WHERE qitem_id=?")
    .run(new Date(Date.now()-3600_000).toISOString(), created.qitemId);
  return created;
}
it.each(["source", "target"])("preserves ladder position across due ticks and reopen when %s rig is drained", async held => {
  const dir = mkdtempSync(join(tmpdir(), "drain-ladder-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let t = fixture(join(dir, "db.sqlite"));
  const row = await baton(t); const other = await baton(t, "worker@other", "relay@other");
  const before = t.queue.listTransitions(row.qitemId); const drain = t.begin(held);
  const calls: string[] = []; const attemptWake = async (id: string) => { calls.push(id); return "failed:offline"; };
  const base = Date.now();
  for (let n=1;n<=4;n++) await runWakeLadderTick({ db:t.db,queueRepo:t.queue,attemptWake,now:new Date(base+n*301_000),resolveOrchestrator:()=>null });
  expect(calls).not.toContain(row.qitemId); expect(calls).toContain(other.qitemId);
  expect(t.queue.listTransitions(row.qitemId)).toEqual(before);
  t.db.close(); t = fixture(join(dir, "db.sqlite")); cleanup.push(() => t.db.close());
  await runWakeLadderTick({db:t.db,queueRepo:t.queue,attemptWake,now:new Date(base+1800_000),resolveOrchestrator:()=>null});
  expect(t.queue.listTransitions(row.qitemId)).toEqual(before);
  t.queue.deliveryDrains.end(drain.rigId, drain.drainId,t.jobs);
  await runWakeLadderTick({db:t.db,queueRepo:t.queue,attemptWake,now:new Date(base+2100_000),resolveOrchestrator:()=>null});
  expect(calls.filter(id=>id===row.qitemId)).toHaveLength(1);
  expect(t.queue.listTransitions(row.qitemId).filter(x=>x.transitionNote?.startsWith("wake-attempt:"))).toHaveLength(1);
});
it("rechecks a drain beginning across an async ladder boundary", async () => {
  const t=fixture(); cleanup.push(()=>t.db.close()); const row=await baton(t); const before=t.queue.listTransitions(row.qitemId);
  const attemptWake=vi.fn(async()=>"verified");
  await runWakeLadderTick({db:t.db,queueRepo:t.queue,attemptWake,getProviderReadModel:async()=>{t.begin("target");return {signals:[],bindings:[]};}});
  expect(attemptWake).not.toHaveBeenCalled(); expect(t.queue.listTransitions(row.qitemId)).toEqual(before);
});
it("holds the prompt-refusal continuation without accounting or new escalation", async () => {
  const t=fixture(); cleanup.push(()=>t.db.close()); const row=await baton(t); const key=`${row.destinationSession}|episode`;
  for(const note of [`${RESERVE_PREFIX} ${key}; obligations ${row.qitemId}`,`${REFUSED_PREFIX} ${key}; Refused: interactive prompt`])
    t.queue.transitionLog.append({qitemId:row.qitemId,state:"pending",actorSession:"daemon@kernel",transitionNote:note});
  const before=t.queue.listTransitions(row.qitemId); const count=t.queue.list({limit:100}).length;const drain=t.begin("target");
  const attemptWake=vi.fn(async()=>"verified");const tick=()=>runWakeLadderTick({db:t.db,queueRepo:t.queue,attemptWake,readPromptState:()=>"blocked",resolveOrchestrator:()=>null});
  await tick();expect(t.queue.listTransitions(row.qitemId)).toEqual(before);expect(t.queue.list({limit:100})).toHaveLength(count);
  t.queue.deliveryDrains.end(drain.rigId,drain.drainId,t.jobs);await tick();
  expect(t.queue.list({limit:100}).length).toBeGreaterThan(count);
});
it("delivers and reports a drain-only read failure, while control reads remain errors", async () => {
  const t=fixture(); cleanup.push(()=>t.db.close());t.begin("target");t.queue.attachOutbox(new OutboxHandler(t.db));
  const send=vi.fn(async()=>({ok:true,verified:true}));t.queue.attachTransport({send});
  const {app}=createTestApp(t.db);
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});const prepare=t.db.prepare.bind(t.db);
  vi.spyOn(t.db,"prepare").mockImplementation((sql:string)=>{if(sql.includes("rig_delivery_drains"))throw new Error("injected drain read");return prepare(sql);});
  await t.queue.create({sourceSession:"sender@other",destinationSession:"worker@target",body:"held control unreadable"});
  await t.queue.create({sourceSession:"sender@other",destinationSession:"worker@other",body:"unrelated"});
  await t.queue.drainPendingWakeIntents();await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(2));expect(log).toHaveBeenCalled();
  const job=t.jobs.register({policy:"periodic-reminder",targetSession:"worker@target",registeredBySession:"owner@other",intervalSeconds:1,specYaml:JSON.stringify({target:{session:"worker@target"},message:"work"})});
  const deliver=vi.fn(async()=>({status:"ok" as const})); const engine=new WatchdogPolicyEngine({jobsRepo:t.jobs,historyLog:new WatchdogHistoryLog(t.db),eventBus:t.bus,deliver,deliveryDeferred:(id,seat)=>t.queue.deliveryDrains.holds(seat,id)});
  await engine.evaluate(job);expect(deliver).toHaveBeenCalledTimes(1);
  const rig=t.rigs.listRigs().find(r=>r.name==="target")!;
  expect((await app.request(`/api/rigs/${rig.id}/delivery-drain`)).status).toBe(500);
});
it("a past review deadline prompts once then waits at least five minutes before repeating", async () => {
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
  const t=fixture();cleanup.push(()=>t.db.close());const rig=t.rigs.listRigs().find(r=>r.name==="target")!;
  const drain=t.queue.deliveryDrains.begin(rig.id,{drainId:"window",owner:"owner@target",reviewAt:"2026-11-14T23:59:00Z"},t.jobs);
  const deliver=vi.fn(async()=>({status:"ok" as const}));const engine=new WatchdogPolicyEngine({jobsRepo:t.jobs,historyLog:new WatchdogHistoryLog(t.db),eventBus:t.bus,deliver,deliveryDeferred:(id,seat)=>t.queue.deliveryDrains.holds(seat,id)});
  const evaluate=()=>engine.evaluate(t.jobs.getByIdOrThrow(drain.reviewJobId));await evaluate();expect(deliver).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-11-15T00:00:01Z"));await evaluate();expect(deliver).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-11-15T00:05:00Z"));await evaluate();expect(deliver).toHaveBeenCalledTimes(2);expect(t.queue.deliveryDrains.get(rig.id)?.endedAt).toBeNull();
});
it("an explicit resolve notifies its owner even during the owner's delivery drain", async()=>{
  const t=fixture();cleanup.push(()=>t.db.close());const send=vi.fn(async()=>({ok:true,verified:true}));t.queue.attachTransport({send});
  const row=await t.queue.create({sourceSession:"sender@other",destinationSession:"worker@target",body:"decision",nudge:false});
  t.queue.claim({qitemId:row.qitemId,destinationSession:row.destinationSession});
  t.queue.update({qitemId:row.qitemId,actorSession:row.destinationSession,state:"blocked",blockedOn:"external:decision"});
  t.begin("target");const contract=new MissionControlWriteContract({db:t.db,eventBus:t.bus,queueRepo:t.queue,actionLog:new MissionControlActionLog(t.db)});
  await contract.act({verb:"resolve",qitemId:row.qitemId,actorSession:"sender@other",decision:"Use the recorded option"});
  expect(send).toHaveBeenCalledTimes(1);expect(t.queue.getById(row.qitemId)?.state).toBe("in-progress");
});
