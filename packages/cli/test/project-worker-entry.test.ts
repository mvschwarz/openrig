import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { projectCommand, type ProjectDeps } from "../src/commands/project.js";
import { projectsRoutes } from "../../daemon/src/routes/projects.js";
// The route under test imports source classes; built exports are different constructor instances.
import { ClassifierLeaseError, type ClassifierLease } from "../../daemon/src/domain/classifier-lease-manager.js";
import { ClassificationAttemptError } from "../../daemon/src/domain/classification-attempts.js";
import { classifierOccupant, sourceHash } from "../../daemon/src/domain/classification-sources.js";
import { JEV_MODEL, setExperiment } from "../src/commands/project-jev.js";

vi.mock("../src/daemon-lifecycle.js", () => ({ getDaemonStatus: async () => ({running: true}), daemonStatusGuard: () => true, getDaemonUrl: () => "http://offline.invalid" }));
vi.mock("../src/commands/daemon.js", () => ({ realDeps: () => { throw Error("real lifecycle forbidden"); } }));

// Actual command -> DaemonClient identity -> in-memory HTTP routes -> async worker.
// Fake stores only: no daemon startup, schema/migration, socket, provider or terminal.
function fixture() {
  vi.stubEnv("OPENRIG_SESSION_NAME", "classifier@fixture");
  vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worker-entry-")));
  fs.mkdirSync(path.join(root,"missions/not-the-id/slices/not-the-slice-id"), {recursive:true});
  fs.writeFileSync(path.join(root,"project.yaml"), "id: FIX\n");
  fs.writeFileSync(path.join(root,"SPEC.md"), "---\nid: FIX\n---\nFixture project\n");
  const mission = path.join(root,"missions/not-the-id/SPEC.md");
  fs.writeFileSync(mission,"---\nid: FIX.1.0\n---\nAuthored scope\n");
  fs.writeFileSync(path.join(root,"missions/not-the-id/slices/not-the-slice-id/SPEC.md"),"---\nid: FIX.1.0.1\n---\nSlice\n");
  const input = new Map<string,string>([["taxonomy", `version: fixture-v1\nfields:\n${["kind","urgency","maturity","area"].map(k=>`  ${k}:\n    question: "Which ${k}?"\n    values: { chosen: meaning }`).join("\n")}\n`]]);
  const items = [1,2].map(n=>({streamItemId:`item-${n}`,body:`text-${n}`,sortKey:`${n}`,sourceSession:"author@fixture"}));
  let generation = "g1", lease: ClassifierLease | null = null;
  const writes: Record<string,unknown>[] = [], attempts = new Map<string,Record<string,unknown>>(), done = new Set<string>();
  const requests: {url:string; method:string; sender:string|null}[] = [];
  let hook: (url:string)=>void = () => {};
  const leases = {
    evaluateDeadness: () => null,
    acquire(session:string) { lease ??= {leaseId:"lease-1",classifierSession:session,state:"active",acquiredAt:new Date().toISOString(),lastHeartbeat:new Date().toISOString(),expiresAt:new Date(Date.now()+90_000).toISOString()} as ClassifierLease; return lease; },
    getActiveLease: () => lease,
    requireActiveHolder(session:string,id?:string) { if (!lease || session !== lease.classifierSession || (id && id !== lease.leaseId)) throw new ClassifierLeaseError("lease_mismatch","changed"); return lease; },
    heartbeat(id:string,session:string) { return leases.requireActiveHolder(session,id); },
  };
  const db = {prepare(sql:string) {
    return {all(arg:string) {
      if (sql.includes("o.generation_uuid AS generation")) return arg === "classifier@fixture" ? [{nodeId:"node-1",rigId:"rig-1",session:arg,generation}] : [];
      if (sql.includes("ORDER BY session")) return [{session:"classifier@fixture"}];
      throw Error("unexpected SQL");
    }};
  }};
  const ledger = {
    eligible({limit=20}:{limit?:number}) { const selected = items.filter(x=>!done.has(x.streamItemId)); return {items:selected.slice(0,limit),nextAfterSortKey:selected.length>limit?"next":null}; },
    begin(input:Record<string,unknown>) { leases.requireActiveHolder(input.classifierSession as string,input.leaseId as string); const a={...input,attemptId:`attempt-${input.streamItemId}`,executionId:`exec-${input.streamItemId}`,status:"running"}; attempts.set(a.attemptId,a); return a; },
    abstain(input:Record<string,unknown>) { const a=finish(input); done.add(a.streamItemId as string); return {...a,status:"abstained"}; },
    fail(input:Record<string,unknown>) { const a=finish(input); return {...a,status:"retryable",reason:input.reason}; },
  };
  function finish(input:Record<string,unknown>) {
    leases.requireActiveHolder(input.classifierSession as string,input.leaseId as string);
    const a=attempts.get(input.attemptId as string);
    if (!a || input.executionId!==a.executionId) throw new ClassificationAttemptError("attempt_superseded","stale execution");
    return a;
  }
  const app = new Hono();
  app.use("*",async(c,next)=>{
    for(const [k,v] of Object.entries({db,settingsStore:{resolveOne:(key:string)=>({value:key==="workspace.root"?root:undefined})},streamStore:{list:()=>items},classifierLeaseManager:leases,classificationAttemptLedger:ledger,
      projectClassifier:{classify:(input:Record<string,unknown>)=>{finish(input);writes.push(input);done.add(input.streamItemId as string);return input;}}})) c.set(k as never,v);
    await next();
  });
  app.route("/api/projects",projectsRoutes());
  app.get("/api/stream/:id",c=>c.json(items.find(x=>x.streamItemId===c.req.param("id"))!));
  const client = new DaemonClient("http://offline.invalid",{fetchImpl:async(url,init)=>{
    const u=String(url), headers=new Headers(init?.headers);
    requests.push({url:u,method:init?.method??"GET",sender:headers.get("x-openrig-session")}); hook(u);
    return app.request(u,init);
  }});
  const options=["--project","FIX","--taxonomy","taxonomy","--classifier-version","fixture-v1","--evidence-epoch","owner-epoch","--limit","1"];
  async function command(verb:string,extra:string[]=[], overrides:Partial<ProjectDeps> = {}) {
    const out: string[]=[];
    const spy=vi.spyOn(console,"log").mockImplementation(x=>{out.push(String(x));});
    try { await new Command().addCommand(projectCommand({lifecycleDeps:{},clientFactory:()=>client,workerRead:(file:string)=>input.get(file) ?? fs.readFileSync(file,"utf8"), ...overrides} as unknown as ProjectDeps)).parseAsync(["project",verb,...options,...extra],{from:"user"}); }
    finally {spy.mockRestore();}
    return JSON.parse(out.at(-1)!);
  }
  async function decisions(labels:Record<string,unknown>={classificationType:"chosen",scopeRef:"FIX.1.0.1",classificationDestination:"classifier@fixture",needsHuman:true}) {
    const prepared=await command("candidates");
    input.set("decisions",JSON.stringify({candidateSetVersion:prepared.candidates.version,decisions:items.map(x=>({streamItemId:x.streamItemId,bodyHash:sourceHash(x.body),decision:{kind:"classify",labels}}))}));
    return prepared;
  }
  return {root,mission,input,items,writes,attempts,done,requests,command,decisions,client,app,setHook:(h:typeof hook)=>{hook=h;},replaceOccupant:()=>{generation="g2";},replaceLease:()=>{if(lease)lease.leaseId="lease-2";}};
}
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();process.exitCode=0;});
describe("supported occupant wake entry",()=>{
  it.each(["true", "false", "__unknown__", ["true"], true, ["__unknown__"]].map(choice=>({choice})))("F1 stream choice $choice preserves typed truth or abstains",async({choice})=>{
    const f=fixture(),config=path.join(f.root,"experiment.json");setExperiment(config,true,{maxRequests:1});
    const send=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      const {questions}=JSON.parse(init!.body as string);
      const answers=Object.fromEntries(Object.entries(questions).map(([field,q])=>{
        const selected=field==="needs_human"?choice:"__unknown__";
        return [field,{type:"choice",choice:selected,confidence:1,probabilities:Object.fromEntries(Object.keys((q as {criteria:object}).criteria).map(v=>[v,v===String(selected)?1:0]))}];
      }));
      return Response.json({model:JEV_MODEL,answers});
    });
    const out=await f.command("wake",["--experiment",config],{experimentEnv:{OPENROUTER_API_KEY:"synthetic"},experimentFetch:send});
    expect(send).toHaveBeenCalledTimes(1);
    if(typeof choice!=="string") {
      expect(f.writes).toHaveLength(0);expect(out.experiment.lastResult.status).toBe("unavailable");expect(out.experiment.stopped).toBe(true);
    } else if(choice==="__unknown__") {
      expect(f.writes).toHaveLength(0);expect(out.result.outcomes[0].status).toBe("abstained");
    } else {
      expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({needsHuman:choice==="true",attemptId:"attempt-item-1",executionId:"exec-item-1"});
    }
  });
  it.each(["valid","unknown","invalid","occupant","lease","execution","disabled"])("experimental %s traverses actual command/client/routes/worker/provider with fenced advisory writes",async kind=>{
    const f=fixture(), config=path.join(f.root,"experiment.json");setExperiment(config,true,{maxRequests:1});
    const send=vi.fn(async (_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      const payload=JSON.parse(init!.body as string);
      expect(payload.state.item.text).toBe("text-1");expect(payload.questions.destination.criteria).toHaveProperty("pool");
      const answers=Object.fromEntries(Object.entries(payload.questions).map(([field,q])=>{
        const choices=Object.keys((q as {criteria:object}).criteria);
        const choice=kind==="unknown"?"__unknown__":field==="scope_ref"?"FIX.1.0.1":field==="destination"?"pool":choices[0]!;
        return [field,{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(choices.map(v=>[v,v===choice?1:0]))}];
      }));
      if(kind==="invalid")answers.kind!.probabilities.chosen=0.99;
      if(kind==="occupant")f.replaceOccupant();
      if(kind==="lease")f.replaceLease();
      if(kind==="execution")f.attempts.get("attempt-item-1")!.executionId="new";
      if(kind==="disabled")setExperiment(config,false);
      return Response.json({model:JEV_MODEL,answers});
    });
    const result=await f.command("wake",["--experiment",config],{experimentEnv:{OPENROUTER_API_KEY:"synthetic"},experimentFetch:send});
    expect(send).toHaveBeenCalledTimes(1);expect(result.registered).toBe(false);expect(result.wakeRequest).toBeNull();
    if(kind==="valid") {
      expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({classificationType:"chosen",scopeRef:"FIX.1.0.1",classificationDestination:"pool",identityProvenance:"transport:v1",executionId:"exec-item-1"});
      expect(f.writes[0]!.action).toBeUndefined();expect(f.writes[0]!.classificationConfidence).toBeUndefined();
    } else expect(f.writes).toHaveLength(0);
    if(kind==="occupant"||kind==="lease")expect(result.result.state).toBe("lease_lost");
    if(kind==="execution")expect(result.result.outcomes[0].status).toBe("attempt_superseded");
    if(kind==="invalid"||kind==="disabled")expect(result.experiment.stopped).toBe(true);
    if(kind==="valid"||kind==="unknown"){
      await f.command("wake",["--experiment",config],{experimentEnv:{OPENROUTER_API_KEY:"synthetic"},experimentFetch:async()=>Response.json({error:"offline"})});
      expect(f.attempts.size).toBe(2); // item 1 was terminal; no replay of the first attempt.
    }
  });
  it.each(["off","missing-key"])("experimental %s reaches neither daemon nor attempt creation",async kind=>{
    const f=fixture(), config=path.join(f.root,"experiment.json");setExperiment(config,kind!=="off");
    const out=await f.command("wake",["--experiment",config],{experimentEnv:{},experimentFetch:()=>{throw Error("provider forbidden");}});
    expect(f.requests).toHaveLength(0);expect(f.attempts.size).toBe(0);
    if(kind==="off")expect(out.enabled).toBe(false);else expect(out.error).toBe("experiment_unavailable");
  });
  it("invalid provider criterion is rejected before an attempt or forward",async()=>{
    const f=fixture(),config=path.join(f.root,"experiment.json");setExperiment(config,true);
    f.input.set("taxonomy",f.input.get("taxonomy")!.replace("chosen: meaning","chosen: 123"));
    const send=vi.fn(()=>{throw Error("provider forbidden");});
    const result=await f.command("wake",["--experiment",config],{experimentEnv:{OPENROUTER_API_KEY:"synthetic"},experimentFetch:send});
    expect(result.error).toBe("worker_unavailable");expect(f.attempts.size).toBe(0);expect(send).not.toHaveBeenCalled();
  });
  it.each(["pool", "classifier@fixture", "unavailable@fixture", null])("F1 destination %s uses the supported bound wake",async(destination)=>{
    const f=fixture();
    f.input.set("taxonomy",f.input.get("taxonomy")+'  destination:\n    question: "Which destination?"\n    values: { pool: "Retain in the pool" }\n');
    const prepared=await f.decisions({classificationType:"chosen",classificationDestination:destination});
    const result=await f.command("wake",["--decisions","decisions"]);
    if(destination==="unavailable@fixture") {
      expect(result.result.outcomes[0].status).toBe("abstained");expect(f.writes).toHaveLength(0);
    } else {
      expect(result.result.outcomes[0].status).toBe("written");
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]).toMatchObject({classificationType:"chosen",candidateSetVersion:prepared.candidates.version,identityProvenance:"transport:v1"});
      expect(f.writes[0]!.classificationDestination).toBe(destination ?? undefined);
    }
    expect([...f.attempts.values()][0]!.evidenceEpoch).toBe("owner-epoch");
  });
  it("F1 pre-correction candidate versions require preparation without reopening attempts",async()=>{
    const f=fixture(),prepared=await f.decisions({classificationDestination:"pool"});
    // Reproduce the prior public input-binding algorithm, not a guessed historical epoch.
    const priorVersion=sourceHash(JSON.stringify({sourceVersion:prepared.snapshot.version,taxonomyHash:prepared.taxonomy.hash}));
    const packet=JSON.parse(f.input.get("decisions")!);packet.candidateSetVersion=priorVersion;
    f.input.set("decisions",JSON.stringify(packet));
    const refused=await f.command("wake",["--decisions","decisions"]);
    expect(refused.error).toBe("worker_unavailable");expect(f.attempts.size).toBe(0);expect(f.writes).toHaveLength(0);
    expect((await f.command("candidates")).candidates.version).toBe(prepared.candidates.version);
  });
  it("current occupant query rejects a historical running row behind a stopped latest session",()=>{
    const db=new Database(":memory:");
    // Four tiny fixture tables only. No production migration or DB file is opened.
    try {
      db.exec(`CREATE TABLE nodes(id TEXT,rig_id TEXT); CREATE TABLE bindings(node_id TEXT,tmux_session TEXT);
        CREATE TABLE sessions(id TEXT,node_id TEXT,session_name TEXT,status TEXT);
        CREATE TABLE occupant_tenures(node_id TEXT,generation_ordinal INTEGER,generation_uuid TEXT);
        INSERT INTO nodes VALUES('n','r'); INSERT INTO bindings VALUES('n','seat@rig');
        INSERT INTO sessions VALUES('01','n','seat@rig','running');
        INSERT INTO occupant_tenures VALUES('n',1,'old'),('n',2,'current');`);
      expect(classifierOccupant(db,"seat@rig")).toEqual({nodeId:"n",rigId:"r",session:"seat@rig",generation:"current"});
      db.exec("INSERT INTO sessions VALUES('02','n','seat@rig','stopped')");
      expect(classifierOccupant(db,"seat@rig")).toBeNull();
      expect(classifierOccupant(db,"invented@rig")).toBeNull();
    } finally {db.close();}
  });
  it("reaches the worker through real HTTP routes, retains wire provenance and catches up one page per command",async()=>{
    const f=fixture(), p=await f.decisions();
    expect(p.candidates.values.scopeRef).toEqual(["FIX.1.0","FIX.1.0.1"]);
    expect(p.snapshot.sources.project.files.every((x:{hash:string})=>x.hash.startsWith("sha256:"))).toBe(true);
    const first=await f.command("wake",["--decisions","decisions"]);
    expect(first.result).toMatchObject({state:"processed",moreEligible:true,outcomes:[{streamItemId:"item-1",status:"written"}]});
    expect(first.registered).toBe(false);
    expect(first.wakeRequest).toMatchObject({targetSession:"classifier@fixture",targetGenerationUuid:"g1",policy:"periodic-reminder"});
    expect(first.wakeRequest.specYaml).toContain("rig project wake");
    expect(f.writes[0]).toMatchObject({classifierSession:"classifier@fixture",identityProvenance:"transport:v1",leaseId:"lease-1",executionId:"exec-item-1",candidateSetVersion:p.candidates.version});
    expect(f.requests.every(x=>x.sender==="classifier@fixture")).toBe(true);
    const second=await f.command("wake",["--decisions","decisions"]);
    expect(second.result.outcomes).toEqual([{streamItemId:"item-2",status:"written"}]);
    expect((await f.command("wake",["--decisions","decisions"])).result.outcomes).toEqual([]);
    expect(f.writes).toHaveLength(2);
  });
  it.each(["occupant","lease","execution"])("a changed %s between async requests cannot classify",async(kind)=>{
    const f=fixture(); await f.decisions();
    f.setHook(url=>{if(new URL(url).pathname==="/api/projects/project") {
      if(kind==="occupant")f.replaceOccupant();
      if(kind==="lease")f.replaceLease();
      if(kind==="execution")f.attempts.get("attempt-item-1")!.executionId="new-execution";
    }});
    const out=await f.command("wake",["--decisions","decisions"]);
    expect(f.writes).toHaveLength(0);
    if(kind==="execution")expect(out.result.outcomes[0].status).toBe("attempt_superseded");
    else expect(out.result.state).toBe("lease_lost");
  });
  it("candidate source misses abstain without treating names or retrieval misses as evidence",async()=>{
    const f=fixture(); fs.writeFileSync(f.mission,"# A mission without canonical ID\n");
    const p=await f.decisions(); expect(p.snapshot.unavailable.length).toBeGreaterThan(0);
    expect(p.candidates.values.scopeRef).toEqual([]);
    const out=await f.command("wake",["--decisions","decisions"]);
    expect(out.result.outcomes[0].status).toBe("abstained"); expect(f.writes).toHaveLength(0);
  });
  it.each([{scopeRef:"directory-name"},{duplicateOfStreamItemId:"absent",duplicateEvidenceRef:"invented"}])("unavailable label/evidence abstains: %j",async(labels)=>{
    const f=fixture();await f.decisions(labels);const out=await f.command("wake",["--decisions","decisions"]);
    expect(out.result.outcomes[0].status).toBe("abstained");expect(f.writes).toHaveLength(0);
  });
  it("missing/stale decisions never mint attempts; current source edits change candidate version, not evidence epoch",async()=>{
    const f=fixture();await f.decisions(); fs.appendFileSync(f.mission,"changed source\n");
    const out=await f.command("wake",["--decisions","decisions"]);
    expect(out.error).toBe("worker_unavailable");expect(f.attempts.size).toBe(0);expect(f.writes).toHaveLength(0);
  });
  it("wire identity is necessary for the worker source, but no stronger sender provenance is invented",async()=>{
    const f=fixture(); vi.stubEnv("OPENRIG_SESSION_NAME","");vi.stubEnv("RIGGED_SESSION_NAME","");
    expect((await f.command("candidates")).error).toBe("worker_unavailable");expect(f.attempts.size).toBe(0);
  });
  it("asynchronous transport error gives unavailable/backoff, with no write or success claim",async()=>{
    const f=fixture(); await f.decisions();f.setHook(url=>{if(url.includes("lease/acquire"))throw Error("offline fault");});
    const out=await f.command("wake",["--decisions","decisions"]);
    expect(out.result.state).toBe("unavailable");expect(Date.parse(out.result.nextWakeAt)).toBeGreaterThan(Date.now());expect(f.writes).toHaveLength(0);
  });
});
