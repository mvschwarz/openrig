import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { codexPluginContentHash, codexLegacyPluginTrustPath, planOwnedCodexContentApproval } from "../src/domain/codex-owned-plugin-trust.js";

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
  expect(Object.values(states).every((state: any) => state.trusted_content_hash === codexPluginContentHash(shipped))).toBe(true);
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
it.each(["hooks/codex.json","hooks/scripts/refocus.cjs",".codex-plugin/plugin.json"])("modified vendored %s is not automatically installed or trusted", async relative => {
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

// The interrupted-upgrade state: the new bundle is already installed, but Codex0.164
// retains the declaration-only grants and immutable content baseline from published0.7.0.
async function legacyUpgrade() {
  const f = fixture();
  await f.adapter().ensureCodexCorePlugin();
  fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace(/^trusted_content_hash = .*\n/gm, ""));
  fs.rmSync(path.join(f.home, ".openrig-core-hook-trust.json"), { force: true });
  const identity = createHash("sha256");
  for (const part of [f.file, "openrig-core@openrig"]) {
    const bytes = Buffer.from(part), length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length));
    identity.update(length); identity.update(bytes);
  }
  const baseline = path.join(f.home, ".hook-trust", identity.digest("hex"));
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  fs.writeFileSync(baseline, process.platform === "win32" ? "sha256:f94b92a51872b7a5c0ba57d762a8cd68208a10f4e4ffed701220feafab626889" : "sha256:3317076e0df0d10402c17f26a17f26a21264980a6f0b551a1e21a3c0f785efca");
  return { ...f, baseline };
}

it("an already-installed owned upgrade renews all six content approvals without changing other choices or the native baseline", async () => {
  const f = await legacyUpgrade();
  fs.appendFileSync(f.file, '\n[hooks.state."outside:stop:0:0"]\nenabled = false\ntrusted_hash = "outside-choice"\n\n\n');
  const before = fs.readFileSync(f.file, "utf8"), baseline = fs.readFileSync(f.baseline, "utf8"), calls = f.calls.length;
  const expectedContent = codexPluginContentHash(shipped);
  await f.adapter().ensureCodexCorePlugin();
  const states = Object.entries(f.read().hooks.state).filter(([key]) => key.startsWith("openrig-core@openrig:"));
  expect(states).toHaveLength(6);
  for (const [, state] of states as Array<[string, any]>) {
    expect(state.trusted_content_hash).toBe(expectedContent);
  }
  expect(fs.readFileSync(f.file, "utf8").replace(/^trusted_content_hash = .*\n/gm, "")).toBe(before);
  expect(fs.readFileSync(f.baseline, "utf8")).toBe(baseline);
  expect(f.calls).toHaveLength(calls);
  const renewed = fs.readFileSync(f.file, "utf8");
  await f.adapter().ensureCodexCorePlugin();
  expect(fs.readFileSync(f.file, "utf8")).toBe(renewed);
  expect(JSON.parse(fs.readFileSync(path.join(f.home, ".openrig-core-hook-trust.json"), "utf8"))).toMatchObject({
    contentHash: expectedContent,
  });
});

it.each(["disabled", "refused", "unknown baseline", "changed script", "changed skill", "extra file", ...(process.platform === "win32" ? [] : ["symlink"]), "unknown layer", "profile refusal", "profile plugin disable", "invalid provenance"])(
  "an owned upgrade preserves native review for %s", async condition => {
    const f = await legacyUpgrade();
    const header = '[hooks.state."openrig-core@openrig:hooks/codex.json:stop:0:0"]';
    if (condition === "disabled") fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace(header, `${header}\nenabled = false`));
    if (condition === "refused") fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace(/trusted_hash = "sha256:bb444[^"]+"/, 'trusted_hash = "not-the-owned-declaration"'));
    if (condition === "unknown baseline") fs.writeFileSync(f.baseline, "unknown");
    if (condition === "changed script") fs.appendFileSync(path.join(f.cache, "hooks/scripts/refocus.cjs"), "\nmodified");
    if (condition === "changed skill") fs.appendFileSync(path.join(f.cache, "skills/openrig-user/SKILL.md"), "\nmodified");
    if (condition === "extra file") fs.writeFileSync(path.join(f.cache, "unexpected"), "extra");
    if (condition === "symlink") fs.symlinkSync(f.plugin, path.join(f.cache, "unexpected-link"));
    if (condition === "unknown layer") { fs.mkdirSync(path.join(f.home, "../etc")); fs.writeFileSync(path.join(f.home, "../etc/config.toml"), "not valid toml"); }
    if (condition === "profile refusal") fs.appendFileSync(f.file, '\n[profiles.special.hooks.state."openrig-core@openrig:hooks/codex.json:stop:0:0"]\nenabled = false\n');
    if (condition === "profile plugin disable") fs.appendFileSync(f.file, '\n[profiles.special.plugins."openrig-core@openrig"]\nenabled = false\n');
    if (condition === "invalid provenance") fs.writeFileSync(path.join(f.home, ".openrig-core-hook-trust.json"), "broken");
    const before = fs.readFileSync(f.file, "utf8");
    await f.adapter().ensureCodexCorePlugin();
    expect(fs.readFileSync(f.file, "utf8")).toBe(before);
    if (condition !== "invalid provenance") expect(fs.existsSync(path.join(f.home, ".openrig-core-hook-trust.json"))).toBe(false);
  });

it("the owned receipt carries approval into a later bundle while preserving the previous declarations", async () => {
  const f = fixture(); await f.adapter().ensureCodexCorePlugin();
  const next = path.join(f.home, "next-shipped"); fs.cpSync(shipped, next, { recursive: true });
  fs.appendFileSync(path.join(next, "skills/openrig-user/SKILL.md"), "\nnext shipped revision");
  fs.cpSync(next, f.cache, { recursive: true });
  const plan = planOwnedCodexContentApproval({ configPath: f.file, content: fs.readFileSync(f.file, "utf8"),
    layers: [{ name: "user config", path: f.file, state: "read", content: fs.readFileSync(f.file, "utf8") }], shipped: next, installed: f.cache });
  expect(plan).toBeDefined();
  expect(Object.values(plan!.hashes)).toEqual(Array(6).fill(codexPluginContentHash(next)));
  expect(f.read().hooks.state["openrig-core@openrig:hooks/codex.json:stop:0:0"].trusted_hash).toBe(plan!.approval.declarations["openrig-core@openrig:hooks/codex.json:stop:0:0"]);
});

it("records an already-approved current legacy bundle for subsequent upgrades", async () => {
  const f = await legacyUpgrade(), current = codexPluginContentHash(shipped);
  fs.writeFileSync(f.baseline, current);
  await f.adapter().ensureCodexCorePlugin();
  expect(Object.values(f.read().hooks.state).every((state: any) => state.trusted_content_hash === current)).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.home, ".openrig-core-hook-trust.json"), "utf8"))).toMatchObject({ contentHash: current });
  expect(fs.readFileSync(f.baseline, "utf8")).toBe(current);
});

it("renews only the selected Codex home when the daemon has a different default home", async () => {
  const f = await legacyUpgrade(), selected = path.join(f.home, "selected-home"), file = path.join(selected, "config.toml");
  const before = fs.readFileSync(f.file, "utf8");
  fs.mkdirSync(selected); fs.writeFileSync(file, before);
  const version = path.basename(f.cache);
  fs.cpSync(f.cache, path.join(selected, "plugins/cache/openrig/openrig-core", version), { recursive: true });
  const baseline = codexLegacyPluginTrustPath(file);
  fs.mkdirSync(path.dirname(baseline), { recursive: true }); fs.copyFileSync(f.baseline, baseline);
  await f.adapter().ensureCodexCorePlugin(selected);
  const states = (parse(fs.readFileSync(file, "utf8")) as any).hooks.state;
  expect(Object.values(states).every((state: any) => state.trusted_content_hash === codexPluginContentHash(shipped))).toBe(true);
  expect(fs.readFileSync(f.file, "utf8")).toBe(before);
  expect(fs.existsSync(path.join(f.home, ".openrig-core-hook-trust.json"))).toBe(false);
  expect(fs.existsSync(path.join(selected, ".openrig-core-hook-trust.json"))).toBe(true);
});

it("uses the native bundle fingerprint and legacy identity recipes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fingerprint-")); roots.push(root);
  fs.mkdirSync(path.join(root, "nested")); fs.writeFileSync(path.join(root, "hello.txt"), "hello\n");
  fs.writeFileSync(path.join(root, "nested/other.txt"), "world\n");
  // Independent Python implementation of the rust-v0.164.0 byte stream, not the grant planner.
  expect(codexPluginContentHash(root)).toBe(process.platform === "win32" ? "sha256:e7690d54fade38332715024d03cf7c7e5cb26f77dbba1c60e589e2be9ef42d5e" : "sha256:bc4d2c619163c3c9e4fd0a0740b7de1e5b39b3eb2cef3d52b8a8f582a1f13ce5");
  fs.mkdirSync(path.join(root, ".venv")); fs.writeFileSync(path.join(root, ".venv/ignored"), "generated");
  expect(codexPluginContentHash(root)).toBe(process.platform === "win32" ? "sha256:e7690d54fade38332715024d03cf7c7e5cb26f77dbba1c60e589e2be9ef42d5e" : "sha256:bc4d2c619163c3c9e4fd0a0740b7de1e5b39b3eb2cef3d52b8a8f582a1f13ce5");
  expect(codexPluginContentHash(root, true)).not.toBe(codexPluginContentHash(root));
  expect(path.basename(codexLegacyPluginTrustPath("/home/operator/.codex/config.toml"))).toBe("5107db44b2124b5303069076c8cbcc824811a62710c30a9188b2f8465e5e7cb4");
});

// Independent review controls. All homes and plugin copies belong to fixture().
it("R2 preserves a quoted content-approval key without invalidating TOML", async () => {
  const f = await legacyUpgrade();
  const previous = fs.readFileSync(f.baseline, "utf8");
  fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace(/^(trusted_hash = .*\n)/gm, `$1"trusted_content_hash" = "${previous}"\n`));
  expect(Object.values(f.read().hooks.state).every((s: any) => s.trusted_content_hash === previous)).toBe(true);
  const before = fs.readFileSync(f.file, "utf8");
  await f.adapter().ensureCodexCorePlugin();
  expect(() => f.read()).not.toThrow();
  expect(fs.readFileSync(f.file, "utf8")).toBe(before);
  expect(fs.existsSync(path.join(f.home, ".openrig-core-hook-trust.json"))).toBe(false);
});
it("R2 keeps an unrelated multiline instruction containing table examples exact", async () => {
  const f = await legacyUpgrade();
  const sample = Object.keys(f.read().hooks.state).map(key => `[hooks.state.${JSON.stringify(key)}]`).join("\n");
  fs.writeFileSync(f.file, `developer_instructions = '''\n${sample}\n'''\n` + fs.readFileSync(f.file, "utf8"));
  const before = f.read().developer_instructions;
  await f.adapter().ensureCodexCorePlugin();
  expect(f.read().developer_instructions).toBe(before);
  expect(fs.existsSync(path.join(f.home, ".openrig-core-hook-trust.json"))).toBe(false);
});
it("an unshipped vendored file permits the upgrade but leaves content approval under native review", async () => {
  const f = await legacyUpgrade(), before = fs.readFileSync(f.file, "utf8"), calls = f.calls.length;
  const older = path.join(path.dirname(f.cache), "previous-version");
  fs.renameSync(f.cache, older);
  fs.writeFileSync(path.join(f.plugin, "unshipped-file"), "fixture extra");
  expect(await f.adapter().ensureCodexCorePlugin()).toMatchObject({ outcome: "installed" });
  expect(f.calls).toHaveLength(calls + 1);
  expect(fs.existsSync(older)).toBe(true);
  expect(fs.readFileSync(path.join(f.cache, "unshipped-file"), "utf8")).toBe("fixture extra");
  expect(fs.readFileSync(f.file, "utf8")).toBe(before);
  expect(fs.existsSync(path.join(f.home, ".openrig-core-hook-trust.json"))).toBe(false);
});

it("R2 oa fresh nonmatching bundle gains no declaration-only legacy approval", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.plugin, "unshipped-file"), "fixture extra");
  expect(await f.adapter().ensureCodexCorePlugin()).toMatchObject({outcome: "installed"});
  expect(fs.readFileSync(path.join(f.cache, "unshipped-file"), "utf8")).toBe("fixture extra");
  expect(fs.existsSync(codexLegacyPluginTrustPath(f.file))).toBe(false);
  expect(fs.existsSync(path.join(f.home, ".openrig-core-hook-trust.json"))).toBe(false);
  expect(Object.keys(f.read().hooks?.state ?? {})).toHaveLength(0);
});
