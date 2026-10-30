import { afterEach, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGuestActivityApp, type AppDeps } from "../src/server.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
it("confines the actual guest HTTP port to grant-bound hooks", async () => {
  const db = createFullTestDb(); cleanups.push(() => db.close());
  const rigs = new RigRepository(db), rig = rigs.createRig("guest-fixture");
  const node = rigs.addNode(rig.id,"team.worker",{runtime:"synth"});
  const sessions = new SessionRegistry(db), eventBus = new EventBus(db);
  const seat = "team-worker@guest-fixture";
  const session = sessions.registerSession(node.id,seat); sessions.updateStatus(session.id,"running"); sessions.recordCommunityHarnessSelection(session.id,"synth",true);
  const store = new AgentActivityStore({db,eventBus,resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration:(id,g) => sessions.isOccupantGenerationRegistered(id,g)});
  const app = createGuestActivityApp({rigRepo:rigs,sessionRegistry:sessions,eventBus,agentActivityStore:store, activityHookToken:"install-token"} as AppDeps);
  const server = serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});
  cleanups.push(() => new Promise<void>((done,reject) => server.close(error => error ? reject(error) : done())));
  if (!server.listening) await new Promise<void>(done => server.once("listening",done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
  const origin = `http://127.0.0.1:${address.port}`, grants = new ActivityGrantStore(db);
  const issue = () => grants.issue({nodeId:node.id,generation:sessions.currentOccupantTenure(node.id)!.generationUuid,issuedBy:"test"});
  const post = (token:string,body:Record<string,unknown>={}) => fetch(origin+"/api/activity/hooks",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
    body:JSON.stringify({runtime:"synth",hookEvent:"UserPromptSubmit",subtype:"accepted",occurredAt:new Date().toISOString(),...body})});
  const grant=issue(); expect((await post(grant.token)).status).toBe(200);
  expect((await post(grant.token,{sessionName:"other@guest-fixture"})).status).toBe(403);
  expect((await post("install-token")).status).toBe(401);
  for (const [method,path] of [["GET","/api/config"],["POST","/api/queue/create"],["GET","/api/activity/events"],["GET","/api/activity/parked"],["POST","/api/activity/pi-usage"],["POST","/api/activity/pi-usage-charges"],["GET","/healthz"]]) {
    const response=await fetch(origin+path,{method,headers:{authorization:`Bearer ${grant.token}`,"content-type":"application/json"},...(method === "POST" ? {body:"{}"} : {})});
    expect(response.status,`${method} ${path}`).toBe(404);
  }
  sessions.registerSession(node.id,seat,"handover");
  expect((await post(grant.token)).status).toBe(409);
  const next=issue(); grants.revoke({grantId:next.grantId},"test");
  expect((await post(next.token)).status).toBe(401);
});
it("the shipped provider policy exposes the two confined ports and no main API port", () => {
  const policy=readFileSync(resolve(import.meta.dirname,"../assets/openshell/policy.yaml"),"utf8");
  expect(policy).toContain("port: 7781"); expect(policy).toContain("port: 7782"); expect(policy).not.toContain("7433");
});
