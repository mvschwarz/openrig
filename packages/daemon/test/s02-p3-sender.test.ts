import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { world, V } from "./helpers/s02-worker-world.js";
import { projectsRoutes } from "../src/routes/projects.js";
import { migrate } from "../src/db/migrate.js";
import { createDb } from "../src/db/connection.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";

describe("S02 P3 project sender identity",()=>{
  let w:ReturnType<typeof world>;let app:Hono;
  beforeEach(()=>{
    w=world();app=new Hono();app.use("*",async(c,next)=>{
      c.set("projectClassifier" as never,w.classifier);c.set("classifierLeaseManager" as never,w.leases);
      c.set("classificationAttemptLedger" as never,w.attempts);c.set("eventBus" as never,w.bus);await next();
    });app.route("/api/projects",projectsRoutes());w.seed("a");w.seed("b");
  });
  afterEach(()=>w.db.close());
  const post=async(path:string,body:unknown,headers:Record<string,string>={})=>{
    const r=await app.request(`/api/projects${path}`,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json() as Record<string,any>};
  };
  it("transport actor wins across acquire, heartbeat, begin, classify, fail/abstain and reclaim",async()=>{
    const headers={"x-openrig-session":"wire@rig"};
    const lease=await post("/lease/acquire",{classifierSession:"body@rig",evaluateDeadnessFirst:true},headers);
    expect(lease.status).toBe(201);expect(lease.body.classifierSession).toBe("wire@rig");
    const common={leaseId:lease.body.leaseId,classifierSession:"body@rig"};
    expect((await post("/lease/heartbeat",common,headers)).status).toBe(200);
    const begin=await post("/attempts/begin",{...V,...common,streamItemId:"a"},headers);
    expect(begin.status).toBe(201);expect(begin.body.classifierSession).toBe("wire@rig");
    const projected=await post("/project",{...V,...common,streamItemId:"a",attemptId:begin.body.attemptId,executionId:begin.body.executionId,identityProvenance:"claimed:v1"},headers);
    expect(projected.status).toBe(201);expect(projected.body).toMatchObject({classifierSession:"wire@rig",identityProvenance:"transport:v1"});
    const begun=await post("/attempts/begin",{...V,...common,streamItemId:"b"},headers);
    const finish={...common,executionId:begun.body.executionId,reason:"unclear"};
    expect((await post(`/attempts/${begun.body.attemptId}/fail`,finish,headers)).status).toBe(200);
    w.clock.ms+=1_000;
    const retry=await post("/attempts/begin",{...V,...common,streamItemId:"b"},headers);
    expect((await post(`/attempts/${retry.body.attemptId}/abstain`,{...finish,executionId:retry.body.executionId},headers)).status).toBe(200);
    const reclaimed=await post("/reclaim-classifier",{byClassifierSession:"body@rig",reason:"test"},{"x-openrig-session":"operator@rig"});
    expect(reclaimed.status).toBe(200);expect(reclaimed.body.reclaimedBySession).toBe("operator@rig");
  });
  it("keeps claimed fallback and does not promote a body provenance field",async()=>{
    const lease=await post("/lease/acquire",{classifierSession:"claimed@rig"});
    const result=await post("/project",{streamItemId:"a",leaseId:lease.body.leaseId,classifierSession:"claimed@rig",identityProvenance:"transport:v1"});
    expect(result.status).toBe(201);expect(result.body).toMatchObject({classifierSession:"claimed@rig",identityProvenance:"claimed:v1"});
  });
  it.each([
    [{"x-openrig-relay":"true","x-openrig-provenance":"transport:v1"},"relay:v1"],
    [{"x-openrig-relay":"true"},"claimed:v1"],
    [{"x-openrig-relay":"true","x-openrig-provenance":"claimed:v1"},"claimed:v1"],
    [{"x-openrig-origin-unknown":"true"},"origin-unknown:v1"],
  ] as Array<[Record<string,string>,string]>)("records existing relay degradation %j",async(extra,expected)=>{
    const headers={"x-openrig-session":"wire@rig",...extra};
    const lease=await post("/lease/acquire",{},headers);
    const r=await post("/project",{streamItemId:"a",leaseId:lease.body.leaseId},headers);
    expect(r.status).toBe(201);expect(r.body.identityProvenance).toBe(expected);
    expect(w.classifier.getByStreamItemId("a")?.identityProvenance).toBe(expected);
  });
  it("requires an actor, validates claim shape, but a wire actor supersedes malformed body claims",async()=>{
    for(const value of [42,{},null])expect((await post("/lease/acquire",{classifierSession:value}))).toMatchObject({status:400,body:{field:"classifierSession"}});
    expect((await post("/lease/acquire",{}))).toMatchObject({status:400,body:{error:"actor_required"}});
    const headers={"x-openrig-session":"wire@rig"};
    const lease=await post("/lease/acquire",{classifierSession:{}},headers);
    expect(lease.status).toBe(201);
    expect((await post("/project",{streamItemId:"a",leaseId:lease.body.leaseId,classifierSession:{}},headers)).status).toBe(201);
  });
  it("a different wire actor cannot finish using the body holder or revive its lease",async()=>{
    const lease=w.leases.acquire("holder@rig");const common={leaseId:lease.leaseId,classifierSession:"holder@rig"};
    const attempt=w.attempts.begin({...common,...V,streamItemId:"a"});const headers={"x-openrig-session":"different@rig"};
    expect((await post("/project",{...common,...V,streamItemId:"a",attemptId:attempt.attemptId,executionId:attempt.executionId},headers)).status).toBe(409);
    expect((await post("/lease/heartbeat",common,headers)).status).toBe(403);
    expect((await post(`/attempts/${attempt.attemptId}/abstain`,{...common,executionId:attempt.executionId,reason:"no"},headers)).status).toBe(409);
    expect(w.classifier.getByStreamItemId("a")).toBeNull();expect(w.attempts.getById(attempt.attemptId)?.status).toBe("in_flight");
  });
  it("upgrades a populated legacy table with one nullable column and preserves old bytes",()=>{
    const db=createDb();
    try {
      migrate(db,[streamItemsSchema,projectClassificationsSchema]);
      db.prepare("INSERT INTO stream_items(stream_item_id,ts_emitted,stream_sort_key,source_session,body) VALUES('old','t','s','actor','body')").run();
      db.prepare("INSERT INTO project_classifications(project_id,stream_item_id,classifier_session,ts_projected) VALUES('p','old','actor','t')").run();
      const before=db.prepare("SELECT * FROM project_classifications").get() as Record<string,unknown>;
      migrate(db,[classificationIdentityProvenanceSchema]);migrate(db,[classificationIdentityProvenanceSchema]);
      expect(db.prepare("SELECT * FROM project_classifications").get()).toEqual({...before,identity_provenance:null});
    } finally {db.close();}
  });
});
