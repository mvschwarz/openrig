// rig auth sign-out: every stored copy of one login leaves the Codex home; other logins, other homes and files it can't read
// as a login stay; no token value reaches a result or output. Fake logins only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { authCommand } from "../src/commands/auth.js";
import { resolveCodexHome, authSignOut, SIGN_OUT_NOTE } from "../src/lib/codex-auth.js";

const SENTINEL = "SENTINEL_TOKEN_SIGNOUT_MUST_NEVER_APPEAR";
/** A ChatGPT login as Codex writes auth.json: the account id, tokens (refresh variant r), last refresh. */
const login = (account: string, r: string) => JSON.stringify({ auth_mode: "chatgpt", last_refresh: "2026-11-28T07:49:33Z",
  tokens: { id_token: `${SENTINEL}.id.${r}`, access_token: `${SENTINEL}-access-${r}`, refresh_token: `${SENTINEL}-refresh-${r}`, account_id: account } });

let root: string;
let paths: ReturnType<typeof resolveCodexHome>;
let other: ReturnType<typeof resolveCodexHome>;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }); };
const profile = (p: ReturnType<typeof resolveCodexHome>, name: string) => path.join(p.profileDir, `${name}.json`);
const names = (p: ReturnType<typeof resolveCodexHome>) => fs.existsSync(p.profileDir) ? fs.readdirSync(p.profileDir).sort() : [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-signout-"));
  paths = resolveCodexHome({ CODEX_HOME: path.join(root, "agents") });
  other = resolveCodexHome({ CODEX_HOME: path.join(root, "other") });
  write(profile(paths, "codex-aaaaaaaaaaaa"), login("acct-A", "r2"));            // a sign-in page's pool copy
  write(profile(paths, "before-switch-20261128T075000.123Z"), login("acct-A", "r1")); // a provider switch's older copy
  write(profile(paths, "codex-bbbbbbbbbbbb"), login("acct-B", "r1"));            // another account
  write(profile(paths, "work"), login("acct-B", "r3"));                          // another account, saved by name
  write(profile(other, "codex-aaaaaaaaaaaa"), login("acct-A", "r2"));            // the same account in another home
});
afterEach(() => { vi.restoreAllMocks(); try { fs.chmodSync(paths.profileDir, 0o700); } catch { /* ignore */ } fs.rmSync(root, { recursive: true, force: true }); });

async function run(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const chunks: string[] = [], log = console.log, err = console.error, code = process.exitCode;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  process.exitCode = undefined;
  try {
    await authCommand({ env: { CODEX_HOME: paths.codexHome, HOME: root } }).parseAsync(["sign-out", ...args], { from: "user" });
    return { out: chunks.join("\n"), exitCode: process.exitCode };
  } finally { console.log = log; console.error = err; process.exitCode = code; }
}

describe("authSignOut: every stored copy of one login, and nothing else", () => {
  it("the reported failure, then the repair: with the active auth file removed, the saved copies stay; sign-out removes every copy of that login", () => {
    write(paths.activeAuth, login("acct-A", "r2"));
    fs.rmSync(paths.activeAuth);   // the reported state after a logout: auth.json gone, the saved copies still there
    expect(names(paths)).toContain("codex-aaaaaaaaaaaa.json");
    const r = authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(r).toEqual({ ok: true, target: "profile", removedActive: false, removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"],
      notRemoved: [], keptProfiles: 2, unchecked: [], note: SIGN_OUT_NOTE });
    expect(names(paths)).toEqual(["codex-bbbbbbbbbbbb.json", "work.json"]);
    expect(names(other)).toEqual(["codex-aaaaaaaaaaaa.json"]);   // another home is never touched
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("with no profile named, signs out the active login (a newer refresh) and every saved copy of it", () => {
    write(paths.activeAuth, login("acct-A", "r9"));
    const r = authSignOut(paths);
    expect(r).toMatchObject({ ok: true, target: "active", removedActive: true, removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], keptProfiles: 2 });
    expect(fs.existsSync(paths.activeAuth)).toBe(false);
  });

  it("keeps the active login when it is another account's", () => {
    write(paths.activeAuth, login("acct-B", "r4"));
    expect(authSignOut(paths, "codex-aaaaaaaaaaaa")).toMatchObject({ ok: true, removedActive: false, keptProfiles: 2 });
    expect(fs.existsSync(paths.activeAuth)).toBe(true);
  });

  it("a repeated sign-out says nothing is left, and changes nothing", () => {
    authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(authSignOut(paths, "codex-aaaaaaaaaaaa")).toMatchObject({ ok: true, target: "absent", removedActive: false, removedProfiles: [], keptProfiles: 2 });
    expect(authSignOut(paths)).toMatchObject({ ok: true, target: "absent", removedProfiles: [] });
    expect(names(paths)).toEqual(["codex-bbbbbbbbbbbb.json", "work.json"]);
  });

  it("an API-key login, which names no account, matches only byte-identical copies", () => {
    write(paths.activeAuth, JSON.stringify({ OPENAI_API_KEY: `${SENTINEL}-key-1` }));
    write(profile(paths, "key-copy"), JSON.stringify({ OPENAI_API_KEY: `${SENTINEL}-key-1` }));
    write(profile(paths, "key-other"), JSON.stringify({ OPENAI_API_KEY: `${SENTINEL}-key-2` }));
    const r = authSignOut(paths);
    expect(r).toMatchObject({ ok: true, removedActive: true, removedProfiles: ["key-copy"], keptProfiles: 5 });
    expect(names(paths)).toContain("key-other.json");
  });

  it("a linked or unreadable profile is kept and named, never followed; a linked profile folder is refused", () => {
    const outside = path.join(root, "outside.json");
    write(outside, login("acct-A", "r2"));
    fs.symlinkSync(outside, profile(paths, "codex-cccccccccccc"));
    fs.linkSync(outside, profile(paths, "hardlinked"));
    write(profile(paths, "torn"), `{"tokens": {"refresh_token": "${SENTINEL}"`);
    const r = authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(r).toMatchObject({ ok: true, removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"],
      unchecked: ["auth-profiles/codex-cccccccccccc.json", "auth-profiles/hardlinked.json", "auth-profiles/torn.json"] });
    expect(fs.lstatSync(profile(paths, "codex-cccccccccccc")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toContain("acct-A");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);

    const linked = resolveCodexHome({ CODEX_HOME: path.join(root, "linked") });
    fs.mkdirSync(linked.codexHome);
    fs.symlinkSync(paths.profileDir, linked.profileDir);
    expect(authSignOut(linked, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(names(paths)).toContain("work.json");
  });

  it("refuses a profile name outside the whitelist", () => {
    expect(authSignOut(paths, "../agents/auth")).toEqual({ ok: false, reason: "invalid_profile" });
  });

  it.skipIf(process.getuid?.() === 0)("names a copy it couldn't remove", () => {
    fs.chmodSync(paths.profileDir, 0o500);
    const r = authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(r).toMatchObject({ ok: true, removedProfiles: [], notRemoved: ["auth-profiles/before-switch-20261128T075000.123Z.json", "auth-profiles/codex-aaaaaaaaaaaa.json"] });
  });
});

describe("rig auth sign-out", () => {
  it("prints what it removed, what it kept and that it didn't revoke; again, that nothing is left; never a token", async () => {
    const first = await run(["--profile", "codex-aaaaaaaaaaaa"]);
    expect(first.exitCode).toBeUndefined();
    expect(first.out).toContain("signed_out: the login saved in codex-aaaaaaaaaaaa");
    expect(first.out).toContain("removed_profiles: before-switch-20261128T075000.123Z, codex-aaaaaaaaaaaa");
    expect(first.out).toContain("kept_profiles: 2");
    expect(first.out).toContain("doesn't revoke the login at OpenAI");
    const again = await run(["--profile", "codex-aaaaaaaaaaaa"]);
    expect(again.out).toContain("signed_out: nothing (no profile named codex-aaaaaaaaaaaa in this home)");
    expect(again.out).toContain("removed_profiles: none");
    expect(`${first.out}${again.out}`).not.toContain(SENTINEL);
  });

  it("--json gives a program the same result: names and counts, never a token", async () => {
    const r = await run(["--profile", "codex-aaaaaaaaaaaa", "--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, target: "profile", removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], keptProfiles: 2, notRemoved: [] });
    expect(JSON.parse((await run(["--profile", "codex-aaaaaaaaaaaa", "--json"])).out)).toMatchObject({ ok: true, target: "absent", removedProfiles: [] });
    expect(JSON.parse((await run(["--profile", "../x", "--json"])).out)).toEqual({ ok: false, reason: "invalid_profile" });
    expect(r.out).not.toContain(SENTINEL);
  });

  it.skipIf(process.getuid?.() === 0)("exits 1 when a copy couldn't be removed", async () => {
    fs.chmodSync(paths.profileDir, 0o500);
    const r = await run(["--profile", "codex-aaaaaaaaaaaa"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("not_removed: auth-profiles/before-switch-20261128T075000.123Z.json, auth-profiles/codex-aaaaaaaaaaaa.json");
  });
});


describe("sign-out reports files it cannot check without removing them", () => {
  it.each(["active", "profile"] as const)("keeps a malformed selected %s file and its identical copy", async selected => {
    const file=selected==="active"?paths.activeAuth:profile(paths,"torn");
    const raw="{not complete JSON";
    write(file,raw);write(profile(paths,"same-torn"),raw);
    const r=await run([...(selected==="profile"?["--profile","torn"]:[]),"--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({target:"unchecked",removedActive:false,removedProfiles:[],unchecked:[selected==="active"?"auth.json":"auth-profiles/torn.json"]});
    expect(fs.readFileSync(file,"utf8")).toBe(raw);expect(fs.readFileSync(profile(paths,"same-torn"),"utf8")).toBe(raw);
  });
  it.each(["null", "{}", '{"tokens":{}}'])("does not interpret non-login JSON %s as an API-key login", raw=>{
    write(paths.activeAuth,raw);write(profile(paths,"not-login"),raw);
    expect(authSignOut(paths)).toMatchObject({target:"unchecked",removedActive:false,removedProfiles:[],unchecked:["auth.json"]});
    expect(fs.existsSync(paths.activeAuth)).toBe(true);expect(fs.existsSync(profile(paths,"not-login"))).toBe(true);
  });
  for (const kind of ["symlink", "hardlink", "unreadable"]) it.skipIf(kind === "unreadable" && process.getuid?.() === 0)(`keeps and names a selected ${kind} without claiming sign-out`,async()=>{
    const outside=path.join(root,"kept.json");write(outside,login("acct-A","r9"));
    const selected=profile(paths,"selected");
    if(kind==="symlink")fs.symlinkSync(outside,selected);
    else if(kind==="hardlink")fs.linkSync(outside,selected);
    else {write(selected,login("acct-A","r9"));fs.chmodSync(selected,0);}
    const r=await run(["--profile","selected","--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({target:"unchecked",removedProfiles:[],unchecked:["auth-profiles/selected.json"]});
    expect(fs.lstatSync(selected)).toBeTruthy();expect(fs.existsSync(outside)).toBe(true);
    const text=await run(["--profile","selected"]);expect(text.out).toContain("could not be checked");
    expect(text.out).not.toContain("signed_out: the login saved");
  });
  it.skipIf(process.getuid?.() === 0)("reports an unreadable profile directory while removing the checked active login",()=>{
    write(paths.activeAuth,login("acct-A","r9"));fs.chmodSync(paths.profileDir,0);
    const r=authSignOut(paths);
    expect(r).toMatchObject({ok:true,removedActive:true,removedProfiles:[],unchecked:["auth-profiles/"]});
  });
  it("keeps a non-regular profile without waiting for a writer",()=>{
    write(paths.activeAuth,login("acct-A","r9"));
    expect(spawnSync("mkfifo",[profile(paths,"pipe")]).status).toBe(0);
    const script='import {authSignOut,resolveCodexHome} from "@openrig/daemon/codex-auth";console.log(JSON.stringify(authSignOut(resolveCodexHome({CODEX_HOME:process.argv[1]}))));';
    const child=spawnSync(process.execPath,["--input-type=module","-e",script,paths.codexHome],{encoding:"utf8",timeout:3000});
    expect(child.error?.message).toBeUndefined();expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({unchecked:["auth-profiles/pipe.json"]});
    expect(fs.lstatSync(profile(paths,"pipe")).isFIFO()).toBe(true);
  });
  it("names a selected file replaced after its initial read and exits 1",async()=>{
    const selected=profile(paths,"codex-aaaaaaaaaaaa");
    const replacement=profile(paths,"replacement");write(replacement,login("acct-B","r8"));
    const read=fs.readFileSync;let swapped=false;
    vi.spyOn(fs,"readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0],...args: unknown[])=>{
      const out=(read as Function)(file,...args);
      if(!swapped&&typeof file==="number") {swapped=true;fs.renameSync(replacement,selected);}
      return out;
    }) as typeof fs.readFileSync);
    const r=await run(["--profile","codex-aaaaaaaaaaaa","--json"]);
    expect(r.exitCode).toBe(1);expect(JSON.parse(r.out).notRemoved).toContain("auth-profiles/codex-aaaaaaaaaaaa.json");
    expect(fs.readFileSync(selected,"utf8")).toContain("acct-B");
  });
  it("names a candidate replaced between its read and removal and exits 1",async()=>{
    const selected=profile(paths,"before-switch-20261128T075000.123Z");
    const replacement=profile(paths,"replacement");write(replacement,login("acct-B","r8"));
    const stat=fs.lstatSync, read=fs.readFileSync, inode=stat(selected).ino;let swapped=false, candidateRead=false;
    vi.spyOn(fs,"readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0],...args:unknown[])=>{
      const out=(read as Function)(file,...args);
      if(typeof file==="number"&&fs.fstatSync(file).ino===inode) candidateRead=true;
      return out;
    }) as typeof fs.readFileSync);
    vi.spyOn(fs,"lstatSync").mockImplementation(((file:fs.PathLike,...args:unknown[])=>{
      if(candidateRead&&!swapped&&String(file)===selected){swapped=true;fs.renameSync(replacement,selected);}
      return (stat as Function)(file,...args);
    }) as typeof fs.lstatSync);
    const r=await run(["--profile","codex-aaaaaaaaaaaa","--json"]);
    expect(r.exitCode).toBe(1);expect(JSON.parse(r.out).notRemoved).toContain("auth-profiles/before-switch-20261128T075000.123Z.json");
    expect(fs.readFileSync(selected,"utf8")).toContain("acct-B");
  });
  it("the JSON note names the checked locations and does not imply a scan elsewhere",async()=>{
    const r=await run(["--profile","codex-aaaaaaaaaaaa","--json"]);
    const note=JSON.parse(r.out).note;
    expect(note).toContain("auth.json");expect(note).toContain("auth-profiles/*.json");expect(note).toContain("Other locations are not scanned");
  });
});
