import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { GatewaySubsystem } from "../src/domain/gateway/gateway-subsystem.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
const cleanup: (() => void)[]=[];
afterEach(()=>{for(const c of cleanup.splice(0))c();vi.unstubAllEnvs();});

it("wires recovery after bind and serves cached socket/coverage without scanning the dispatch buffer or Slack", async()=>{
  const home=mkdtempSync(join(tmpdir(),"slack-status-"));const db=createFullTestDb();
  cleanup.push(()=>{db.close();rmSync(home,{recursive:true,force:true});});
  const queueRepo=new QueueRepository(db,new EventBus(db),{validateRig:()=>true});
  saveConfig({...DEFAULT_CONFIG,enabled:true,channel:"C1",inboundDestination:"owner@test"},home);
  vi.stubEnv("SLACK_BOT_TOKEN","fixture-bot");vi.stubEnv("SLACK_APP_TOKEN","fixture-app");
  new SeenStore(join(home,"state","slack-inbound-seen.jsonl")).mark("C1:1000.000001","landed");
  const calls:string[]=[];
  let opened!:()=>void;const ready=new Promise<void>(resolve=>{opened=resolve;});
  const ws:WsLike={send:()=>{},close:()=>{},onopen:null,onclose:null,onmessage:null,onerror:null};
  const subsystem=new GatewaySubsystem({home,wire:()=>buildSlackGatewayWire({home,queueRepo,
    registry:{loadHumanRegistry:()=>({ok:true,entities:[]}),resolveSlackHandle:()=>({kind:"registered",address:"human-fixture@external",entityId:"fixture"})} as never,
    fetchImpl:async url=>{calls.push(url);return Response.json(url.includes("connections.open")?{ok:true,url:"wss://fixture"}:{ok:true,messages:[{type:"message",user:"U1",text:"retained",ts:"1001.000001"}],has_more:false});},
    wsFactory:()=>{opened();return ws;}})});
  cleanup.unshift(()=>subsystem.stop());subsystem.start();expect(calls).toHaveLength(0);
  subsystem.startServices();await ready;ws.onopen?.();
  await vi.waitFor(()=>expect(queueRepo.list({limit:100})).toHaveLength(1));
  const before=calls.length;
  vi.spyOn(subsystem,"status").mockImplementation(()=>{throw new Error("must not scan outbound buffer");});
  const app=new Hono();app.use("*",async(c,next)=>{c.set("gatewaySubsystem" as never,subsystem as never);await next();});
  app.route("/api/gateway",gatewayRoutes({home}));
  const res=await app.request("/api/gateway/slack/status");expect(res.status).toBe(200);
  const body=await res.json();expect(body).toMatchObject({state:"active",connector:{inbound:{state:"connected"},recovery:{state:"scanned",acceptedThisProcess:1}}});
  expect(calls).toHaveLength(before);expect(JSON.stringify(body)).not.toContain("fixture-bot");
});

it("names unavailable daemon connector state without starting or repairing it",async()=>{
  const app=gatewayRoutes();const res=await app.request("/slack/status");
  expect(await res.json()).toMatchObject({state:"unavailable",connector:null});
});
