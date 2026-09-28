import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { projectCommand, type ProjectDeps } from "../src/commands/project.js";
import { JevRun, JEV_MODEL, JEV_ENDPOINT, CAPTURE_QUESTIONS, classifyCapture, readExperiment, setExperiment, validateJev } from "../src/commands/project-jev.js";

vi.mock("../src/daemon-lifecycle.js", () => ({getDaemonStatus: async () => ({running:true}), daemonStatusGuard: () => true, getDaemonUrl: () => "http://offline.invalid"}));
vi.mock("../src/commands/daemon.js", () => ({realDeps: () => { throw Error("real lifecycle forbidden"); }}));
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

function fixture(maxRequests = 3, timeoutMs = 1000) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jev-experiment-")));
  const config = path.join(dir, "experiment.json"); setExperiment(config, true, {maxRequests, timeoutMs});
  return {dir, config};
}
function answer(questions = CAPTURE_QUESTIONS) {
  return {model:JEV_MODEL, provider:"TypeSafe", answers:Object.fromEntries(Object.entries(questions).map(([k,q]) => {
    const choice = Object.keys(q.criteria)[0]!;
    return [k,{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(v => [v,v===choice?1:0]))}];
  }))};
}
const observation = () => ({attemptId:"attempt-1",binding:{sessionName:"seat@fixture",nodeId:"node",occupant:"generation-1",pane:"%9"},post:{state:"captured",content:"synthetic working screen"}});
async function command(args:string[], overrides:Partial<ProjectDeps> = {}) {
  const out:string[]=[]; const log=vi.spyOn(console,"log").mockImplementation(x => {out.push(String(x));});
  try {
    await new Command().addCommand(projectCommand({lifecycleDeps:{},clientFactory:()=>{throw Error("daemon forbidden");}, ...overrides} as ProjectDeps)).parseAsync(["project",...args],{from:"user"});
    return JSON.parse(out.at(-1)!);
  } finally { log.mockRestore(); }
}

describe("public finite Jev experiment", () => {
  it.each(["working", "__unknown__", ["working"], ["__unknown__"]].map(choice=>({choice})))("F1 capture choice $choice uses the shared typed validator",async({choice})=>{
    const f=fixture(),send=vi.fn(async()=>{
      const a=answer();Object.assign(a.answers.state!,{choice,probabilities:Object.fromEntries(Object.keys(CAPTURE_QUESTIONS.state.criteria).map(v=>[v,v===String(choice)?1:0]))});
      return Response.json(a);
    });
    const run=new JevRun(f.config,undefined,{OPENROUTER_API_KEY:"synthetic"},send);
    const out=await classifyCapture(run,observation());
    expect(out.delivery).toBe("INDETERMINATE");expect(send).toHaveBeenCalledTimes(1);
    if(typeof choice==="string")expect(out.result).toMatchObject({status:"answered",answers:{state:{choice}}});
    else {
      expect(out.result?.status).toBe("unavailable");
      await classifyCapture(run,observation());expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("unset/off does not read credentials, input, or daemon and creates no output",async () => {
    const f=fixture();fs.unlinkSync(f.config);
    const env=new Proxy({}, {get:()=>{throw Error("credential read while off");}});
    const send=vi.fn(()=>{throw Error("provider forbidden");});
    const status=await command(["experimental","status","--config",f.config],{experimentEnv:env,experimentFetch:send});
    expect(status).toMatchObject({enabled:false,advisoryOnly:true,retries:0});
    const disabled=await command(["experimental","capture","--config",f.config,"--input","missing","--output",path.join(f.dir,"out")],{experimentEnv:env,experimentFetch:send});
    expect(disabled.enabled).toBe(false);expect(send).not.toHaveBeenCalled();expect(fs.existsSync(path.join(f.dir,"out"))).toBe(false);
    expect((await command(["experimental","enable","--config",f.config,"--max-requests","2"])).enabled).toBe(true);
    expect((await command(["experimental","disable","--config",f.config])).enabled).toBe(false);
    expect(readExperiment(f.config).maxRequests).toBe(2);
  });
  it("missing credentials stop before output or provider work; config has no credentials",async () => {
    const f=fixture(), send=vi.fn();
    const result=await command(["experimental","capture","--config",f.config,"--input","missing","--output",path.join(f.dir,"out")],{experimentEnv:{},experimentFetch:send});
    expect(result.error).toBe("capture_experiment_unavailable");expect(send).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.dir,"out"))).toBe(false);expect(Object.keys(JSON.parse(fs.readFileSync(f.config,"utf8"))).sort()).toEqual(["enabled","maxRequests","timeoutMs"]);
  });
  it("Commander to archive/provider retains identity and input, bounds calls, and never overwrites output",async () => {
    const f=fixture(1), input=path.join(f.dir,"in.jsonl"), output=path.join(f.dir,"out.jsonl");
    const bytes=JSON.stringify(observation())+"\n"+JSON.stringify(observation())+"\n";fs.writeFileSync(input,bytes);
    const send=vi.fn(async (url:Parameters<typeof fetch>[0],init?:RequestInit) => {
      expect(url).toBe(JEV_ENDPOINT);expect(init!.redirect).toBe("error");
      const payload=JSON.parse(init!.body as string);expect(payload.provider).toEqual({allow_fallbacks:false,max_price:{prompt:0.05,completion:0,request:0}});
      expect(payload.model).toBe(JEV_MODEL);expect(payload.questions.state.instructions).toContain("advisory");
      return Response.json(answer());
    });
    const result=await command(["experimental","capture","--config",f.config,"--input",input,"--output",output],{experimentEnv:{OPENROUTER_API_KEY:"synthetic-test-value"},experimentFetch:send});
    expect(result).toMatchObject({calls:1,inspected:1,remaining:1,unavailable:0});
    const row=JSON.parse(fs.readFileSync(output,"utf8"));expect(row).toMatchObject({attemptId:"attempt-1",binding:observation().binding,delivery:"INDETERMINATE",advisoryOnly:true,result:{status:"answered"}});
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);expect(fs.readFileSync(input,"utf8")).toBe(bytes);
    const saved=fs.readFileSync(output,"utf8");
    expect((await command(["experimental","capture","--config",f.config,"--input",input,"--output",output],{experimentEnv:{OPENROUTER_API_KEY:"synthetic-test-value"},experimentFetch:send})).error).toBe("capture_experiment_unavailable");
    expect(send).toHaveBeenCalledTimes(1);expect(fs.readFileSync(output,"utf8")).toBe(saved);
  });
  it("missing captures are unavailable, never negative evidence; mutable caller cannot rebind returned bytes",async () => {
    const f=fixture();let release!:(value:Response)=>void;
    const send=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;}));
    const run=new JevRun(f.config,undefined,{OPENROUTER_API_KEY:"synthetic"},send);
    expect(await classifyCapture(run,{...observation(),post:{state:"unavailable"}})).toMatchObject({status:"unavailable"});expect(send).not.toHaveBeenCalled();
    const obs=observation(), pending=classifyCapture(run,obs);obs.binding.occupant="successor";obs.post.content="successor bytes";
    release(Response.json(answer()));expect(await pending).toMatchObject({binding:{occupant:"generation-1"}});
  });
  it.each(["bad-sum","wrong-model","wrong-provider","missing-answer","extra-answer","outside-choice","nonfinite","http","oversize"])("%s refuses the complete answer and never retries",async kind => {
    const f=fixture(); const send=vi.fn(async()=>{
      const a=answer();
      if(kind==="bad-sum")a.answers.state!.probabilities.working=0.99;
      if(kind==="wrong-model")a.model="other";
      if(kind==="wrong-provider")a.provider="other";
      if(kind==="missing-answer")delete a.answers.state;
      if(kind==="extra-answer")a.answers.extra=a.answers.state!;
      if(kind==="outside-choice")a.answers.state!.choice="invented";
      if(kind==="nonfinite")a.answers.state!.confidence=NaN;
      if(kind==="http")return new Response("not available",{status:503});
      if(kind==="oversize")return new Response(" ".repeat(256*1024+1));
      return Response.json(a);
    });
    const run=new JevRun(f.config,undefined,{OPENROUTER_API_KEY:"synthetic"},send);
    expect((await run.request({},CAPTURE_QUESTIONS)).status).toBe("unavailable");
    expect((await run.request({},CAPTURE_QUESTIONS)).status).toBe("unavailable");expect(send).toHaveBeenCalledTimes(1);
    expect(run.status()).toMatchObject({calls:1,stopped:true});
  });
  it("request bytes and call count have hard limits; unknown remains unknown",async()=>{
    const f=fixture(1), send=vi.fn(async()=>Response.json(answer()));
    const run=new JevRun(f.config,undefined,{OPENROUTER_API_KEY:"synthetic"},send);
    expect((await run.request({text:"x".repeat(24*1024)},CAPTURE_QUESTIONS)).status).toBe("unavailable");expect(send).not.toHaveBeenCalled();
    await run.request({},CAPTURE_QUESTIONS);expect((await run.request({},CAPTURE_QUESTIONS)).status).toBe("unavailable");expect(send).toHaveBeenCalledTimes(1);
    const a=answer();a.answers.state!.choice="__unknown__";a.answers.state!.probabilities=Object.fromEntries(Object.keys(CAPTURE_QUESTIONS.state.criteria).map(k=>[k,k==="__unknown__"?1:0]));
    expect(validateJev(a,CAPTURE_QUESTIONS).answers.state!.choice).toBe("__unknown__");
  });
  it.each(["timeout","abort","disable"])("%s discards late results and will not start a second request",async kind=>{
    const f=fixture();let release!:(response:Response)=>void;
    const send=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;}));
    const run=new JevRun(f.config,undefined,{OPENROUTER_API_KEY:"synthetic"},send), pending=run.request({},CAPTURE_QUESTIONS);
    if(kind==="abort")run.stop();
    if(kind==="disable"){setExperiment(f.config,false);release(Response.json(answer()));}
    expect((await pending).status).toBe("unavailable");expect((await run.request({},CAPTURE_QUESTIONS)).status).toBe("unavailable");expect(send).toHaveBeenCalledTimes(1);
    if(kind!=="disable"){expect(run.status().pending).toBe(true);release(Response.json(answer()));await new Promise(r=>setTimeout(r,0));}
    expect(run.status().pending).toBe(false);
  });
});
