import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { parse } from "smol-toml";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const shipped = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(config = "", corruptCache = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-codex-hooks-")); roots.push(root);
  const plugin = path.join(root, "plugins/openrig-core"), home = path.join(root, "codex");
  fs.cpSync(shipped, plugin, { recursive: true }); fs.mkdirSync(home);
  const file = path.join(home, "config.toml"); fs.writeFileSync(file, config);
  const version = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin/plugin.json"), "utf8")).version;
  const cache = path.join(home, "plugins/cache/openrig/openrig-core", version);
  const calls: string[][] = [];
  const adapter = () => new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, codexHome: home,
    fsOps: { readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p,c) => fs.writeFileSync(p,c), exists: fs.existsSync, mkdirp: p => fs.mkdirSync(p,{recursive:true}) },
    resolveCorePluginDir: () => plugin, codexSystemConfigDir: path.join(root, "etc"),
    runCodexCli: async args => {
      calls.push(args);
      if (args[1] === "add") {
        fs.cpSync(plugin, cache, {recursive:true});
        if (corruptCache) fs.appendFileSync(path.join(cache,"hooks/scripts/refocus.cjs"),"\nmodified");
        if (!(parse(fs.readFileSync(file, 'utf8')) as any).plugins?.['openrig-core@openrig']) fs.appendFileSync(file, '\n[plugins."openrig-core@openrig"]\nenabled = true\n');
      }
      if (args[1] === "marketplace") fs.appendFileSync(file, `\n[marketplaces.openrig]\nsource = ${JSON.stringify(path.dirname(plugin))}\n`);
      return {status:0,stdout:"",stderr:""};
    },
  });
  const read = () => parse(fs.readFileSync(file,"utf8")) as any;
  return {adapter, read, file, plugin, cache, calls, home};
}
it("a fresh install has all six exact plugin hooks trusted before the first seat starts", async () => {
  const f = fixture(); await f.adapter().ensureCodexCorePlugin();
  const states = f.read().hooks?.state ?? {};
  expect(Object.keys(states)).toHaveLength(6);
  // Source-derived Codex0.163 normalized identities, independently calculated with Python sorted JSON/SHA256.
  const expected = {
  "openrig-core@openrig:hooks/codex.json:session_start:0:0": "sha256:a746b5abb568d50725b08bf39660bbf08d15fa3d3a5961208862e7beaadba43d",
  "openrig-core@openrig:hooks/codex.json:user_prompt_submit:0:0": "sha256:f56dfb2a70982d6a7ae4a6c4ace58b943e16dcb08fe3bc87d3c8803477f4a5c1",
  "openrig-core@openrig:hooks/codex.json:user_prompt_submit:1:0": "sha256:c648714b3a02675ba4ea029b8e62dbcd77569afc317ad4f1bc3e8cbfbe7b34ee",
  "openrig-core@openrig:hooks/codex.json:stop:0:0": "sha256:bb444b151db38aff570d0ceadc2cc84b21afb021f00b15b326aef55a27d87d40",
  "openrig-core@openrig:hooks/codex.json:post_compact:0:0": "sha256:f4dd49518599c67ac23c80daef3537bb03b02e23a1e8c1da1210534766afefae",
  "openrig-core@openrig:hooks/codex.json:permission_request:0:0": "sha256:75c66b08f505a22f84def73ecf6d61e98dd1b24ed8ecdcc05306eba3013e64d4"
};
  expect(Object.fromEntries(Object.entries(states).map(([key,value]:[string,any])=>[key,value.trusted_hash]))).toEqual(expected);
  expect(f.calls.map(a=>a.slice(0,2))).toEqual([["plugin","marketplace"],["plugin","add"]]);
});
it.each(['[plugins."openrig-core@openrig"]\nenabled = false\n','[plugins._default]\nenabled = false\n'])("a disabled plugin stays disabled on restart and upgrade: %s", async config => {
  const f = fixture(config); await f.adapter().ensureCodexCorePlugin(); await f.adapter().ensureCodexCorePlugin();
  expect(fs.readFileSync(f.file,"utf8")).toBe(config); expect(f.calls).toEqual([]);
});
it("an existing untrusted installation stays untrusted after restart or an upgrade", async () => {
  const f = fixture('[plugins."openrig-core@openrig"]\nenabled = true\n');
  fs.mkdirSync(path.join(f.home,"plugins/cache/openrig/openrig-core/older"), {recursive:true});
  await f.adapter().ensureCodexCorePlugin(); await f.adapter().ensureCodexCorePlugin();
  expect(f.read().hooks?.state ?? {}).toEqual({});
});
it("a recorded hook decline and outside hook state survive restart and upgrade byte-for-byte", async () => {
  const key = "openrig-core@openrig:hooks/codex.json:stop:0:0";
  const original = `[hooks.state.${JSON.stringify(key)}]\nenabled = false\n[hooks.state."outside:stop:0:0"]\ntrusted_hash = "person-choice"\n`;
  const f = fixture(original); await f.adapter().ensureCodexCorePlugin(); await f.adapter().ensureCodexCorePlugin();
  expect(f.read().hooks.state[key]).toEqual({enabled:false});
  expect(f.read().hooks.state["outside:stop:0:0"]).toEqual({trusted_hash:"person-choice"});
});
it.each(["hooks/codex.json","hooks/scripts/refocus.cjs"])("modified vendored %s is not automatically installed or trusted", async relative => {
  const f=fixture(); fs.appendFileSync(path.join(f.plugin,relative),"\n ");
  await f.adapter().ensureCodexCorePlugin(); expect(f.read().hooks?.state ?? {}).toEqual({}); expect(f.calls).toEqual([]);
});
it("native installation with different cached script bytes gains no trust", async () => {
  const f=fixture("", true); await f.adapter().ensureCodexCorePlugin();
  expect(f.read().hooks?.state ?? {}).toEqual({});
});
it("a person disabling a previously trusted hook keeps that choice through a fresh adapter and cache upgrade", async () => {
  const f=fixture(); await f.adapter().ensureCodexCorePlugin();
  const key="openrig-core@openrig:hooks/codex.json:stop:0:0";
  const before=f.read().hooks.state[key];
  fs.writeFileSync(f.file,fs.readFileSync(f.file,"utf8").replace(`[hooks.state.${JSON.stringify(key)}]`, `[hooks.state.${JSON.stringify(key)}]\nenabled = false`));
  fs.renameSync(f.cache, path.join(path.dirname(f.cache),"older"));
  await f.adapter().ensureCodexCorePlugin(); await f.adapter().ensureCodexCorePlugin();
  expect(f.read().hooks.state[key]).toEqual({...before,enabled:false});
});
it("running both actual relay commands posts each Codex activity event once", async () => {
  const received: any[]=[];
  const server=http.createServer((req,res)=>{ let body="";req.on("data",chunk=>{body+=chunk;});req.on("end",()=>{received.push(JSON.parse(body));res.end("{}");}); });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"one-codex-event-"));roots.push(root);
  try {
    const port=(server.address() as {port:number}).port;
    for (const event of ["SessionStart","UserPromptSubmit","Stop","PermissionRequest"]) {
      for (const args of [[],["--from-plugin"]]) await new Promise<void>((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(shipped,"hooks/scripts/activity-relay.cjs"),...args],{timeout:5000,env:{
          HOME:root,OPENRIG_HOME:root,OPENRIG_RUNTIME:"codex",OPENRIG_NODE_ID:"fixture",OPENRIG_SESSION_NAME:"fixture-seat",
          OPENRIG_OCCUPANT_GENERATION:"fixture-generation",OPENRIG_URL:`http://127.0.0.1:${port}`,OPENRIG_ACTIVITY_HOOK_TOKEN:"fixture-token",
        }});
        child.stdout.resume();child.stderr.resume();child.on("error",reject);child.on("close",code=>code===0?resolve():reject(new Error(`relay exit ${code}`)));
        child.stdin.end(JSON.stringify({hook_event_name:event}));
      });
    }
    expect(received.map(p=>[p.hookEvent,p.relayRoute])).toEqual(["SessionStart","UserPromptSubmit","Stop","PermissionRequest"].map(e=>[e,"managed"]));
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

it("a same-named marketplace owned by someone else is not installed or trusted", async () => {
  const config='[marketplaces.openrig]\nsource = "/another/source"\n';
  const f=fixture(config);await f.adapter().ensureCodexCorePlugin();
  expect(fs.readFileSync(f.file,"utf8")).toBe(config);expect(f.calls).toEqual([]);
});
