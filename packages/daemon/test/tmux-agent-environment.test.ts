// #1178 actual adapter regression: synthetic custom startup, no native providers.
// Real private tmux and bash; synthetic names only, no provider or owner server.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
const exec = promisify(execFile);
const waitFile = async (file: string) => {
  // Redirection creates the file before printf writes it; the final newline marks completion.
  for (let i = 0; i < 100; i++) {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.endsWith("\n")) return text.trim().split("|");
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for complete environment result: ${file}`);
};
describe("environment result completion", () => {
  it("waits through an empty and partially written file", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "tmux-result-"));
    const file = path.join(home, "result");
    vi.useFakeTimers();
    try {
      writeFileSync(file, "");
      let settled = false;
      const result = waitFile(file).then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toBe(false);
      writeFileSync(file, "first|");
      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toBe(false);
      writeFileSync(file, "first|second\n");
      await vi.advanceTimersByTimeAsync(25);
      expect(await result).toEqual(["first", "second"]);
    } finally { vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); }
  });
});
describe.skipIf(process.platform === "win32")("#1178 initial-shell environment policy (actual adapter)", () => {
  for (const clean of [false,true]) for (const successor of [false,true]) {
    it(`${clean ? "daemon baseline" : "stock inherited"}, ${successor ? "successor" : "fresh"}: shell startup and classic function remain usable`, async () => {
      const home=mkdtempSync(path.join(tmpdir(),"tmux-premise-")), socket=path.join(home,"owned.sock");
      const env={...process.env, HOME:home}; delete env.TMUX; delete env.TMUX_TMPDIR;
      const tmux=async(args:string[]) => (await exec("tmux",["-S",socket,...args],{env})).stdout.trim();
      const adapter=new TmuxAdapter(async()=>{throw new Error("argv fixture only");}, undefined, args=>tmux(args.slice(1)));
      const initial=path.join(home,"shell-before"), final=path.join(home,"classic-after");
      const cli=path.join(home,"rig-fixture"), rc=path.join(home,"private.bashrc");
      writeFileSync(cli,"#!/bin/sh\nexit 0\n",{mode:0o755});
      // This deliberately custom default-command must still run; its function and override are intended setup.
      writeFileSync(rc, `unset HISTFILE\nprintf '%s|%s|%s|%s\\n' "\${Q1178_SERVER-absent}" "\${Q1178_DAEMON-absent}" "\${Q1178_AUTH-absent}" "\${TMUX_PANE-absent}" > ${shellQuote(initial)}\nexport Q1178_STARTUP=startup Q1178_AUTH=startup\nclaude() { printf '%s|%s|%s|%s\\n' "\${Q1178_SERVER-absent}" "\${Q1178_DAEMON-absent}" "$Q1178_AUTH" "$Q1178_STARTUP" > ${shellQuote(final)}; }\n`);
      const custom=`exec /bin/bash --noprofile --rcfile ${shellQuote(rc)} -i`;
      const selected={HOME:home,PATH:process.env.PATH!,OPENRIG_HOME:home,OPENRIG_NODE_ID:"node",OPENRIG_SESSION_NAME:"seat",Q1178_AUTH:"daemon"};
      const baseline={...selected,Q1178_DAEMON:"daemon"};
      Object.assign(adapter, { launchEnvironment: () => ({ inheritTmuxEnvironment: !clean, env: baseline }) });
      try {
        await tmux(["-f","/dev/null","new-session","-d","-s","anchor","sleep 60"]);
        await tmux(["set-environment","-g","Q1178_SERVER","tmux"]);
        await tmux(["set-environment","-g","Q1178_AUTH","tmux"]);
        await tmux(["set-option","-g","default-shell","/bin/bash"]);
        await tmux(["set-option","-g","default-command",custom]);
        if (successor) {
          await tmux(["new-session","-d","-s","seat","sleep 60"]);
          await tmux(["set-window-option","-t","=seat:","remain-on-exit","on"]);
          await tmux(["respawn-pane","-k","-t","=seat:","/bin/sh","-c","exit"]);
          for(let i=0;i<100 && await tmux(["display-message","-p","-t","=seat:","#{pane_dead}"])!=="1";i++) await new Promise(r=>setTimeout(r,25));
          expect((await adapter.respawnPane(await tmux(["display-message","-p","-t","=seat:","#{pane_id}"]),custom,{cwd:home,env:selected})).ok).toBe(true);
        } else expect((await adapter.createSession("seat",home,selected)).ok).toBe(true);
        const before=await waitFile(initial);
        expect(before.slice(0,3)).toEqual([clean?"absent":"tmux",clean?"daemon":"absent","daemon"]);
        expect(before[3]).toMatch(/^%\d+$/);
        if (successor) for(const [key,value] of Object.entries(selected)) await tmux(["set-environment","-t","=seat",key,value]);
        const command=await new SeatLaunchEnvironment(adapter,selected,home,cli).command("seat","claude",{runtime:"claude-code"});
        await tmux(["send-keys","-t","=seat:","-l",command]); await tmux(["send-keys","-t","=seat:","Enter"]);
        expect(await waitFile(final)).toEqual([clean?"absent":"tmux",clean?"daemon":"absent","startup","startup"]);
        expect(await tmux(["show-environment","-g","Q1178_SERVER"])).toBe("Q1178_SERVER=tmux");
        // The pre-existing neighbor stays alive; no global reset or restart.
        expect(await tmux(["display-message","-p","-t","=anchor:","#{pane_dead}"])).toBe("0");
      } finally { await tmux(["kill-server"]).catch(()=>{}); rmSync(home,{recursive:true,force:true}); }
    },15000);
  }
  it("ordinary empty default-command keeps a login shell with generated pane metadata and scoped environment", async () => {
    const home=mkdtempSync(path.join(tmpdir(),"tmux-login-")), socket=path.join(home,"owned.sock");
    // The owned login shell must not create history files while teardown removes its home.
    writeFileSync(path.join(home,".bash_profile"),"unset HISTFILE\n");
    const env={...process.env,HOME:home}; delete env.TMUX; delete env.TMUX_TMPDIR;
    const tmux=async(args:string[]) => (await exec("tmux",["-S",socket,...args],{env})).stdout.trim();
    const adapter=new TmuxAdapter(async()=>{throw new Error("argv fixture only");},undefined,args=>tmux(args.slice(1)));
    adapter.launchEnvironment=()=>({inheritTmuxEnvironment:false,env:{HOME:home,PATH:process.env.PATH!,Q1178_DAEMON:"daemon"}});
    try {
      await tmux(["-f","/dev/null","new-session","-d","-s","anchor","sleep 60"]);
      await tmux(["set-environment","-g","Q1178_SERVER","tmux"]);
      await tmux(["set-option","-g","default-shell","/bin/bash"]);
      await tmux(["set-option","-g","default-command",""]);
      expect((await adapter.createSession("seat",home,{OPENRIG_NODE_ID:"node",OPENRIG_SESSION_NAME:"seat"})).ok).toBe(true);
      const pane=await tmux(["display-message","-p","-t","=seat:","#{pane_id}"]);
      const inspected=path.join(home,"shell-environment");
      await tmux(["send-keys","-t","=seat:","-l",`printf '%s|%s|%s\\n' "$Q1178_DAEMON" "\${Q1178_SERVER-absent}" "$TMUX_PANE" > ${shellQuote(inspected)}`]);
      await tmux(["send-keys","-t","=seat:","Enter"]);
      expect(await waitFile(inspected)).toEqual(["daemon","absent",pane]);
      const mode=path.join(home,"login-mode");
      await tmux(["send-keys","-t","=seat:","-l",`if shopt -q login_shell; then printf 'login\\n' > ${shellQuote(mode)}; else printf 'nonlogin\\n' > ${shellQuote(mode)}; fi`]);
      await tmux(["send-keys","-t","=seat:","Enter"]);
      expect(await waitFile(mode)).toEqual(["login"]);
    } finally { await tmux(["kill-server"]).catch(()=>{}); rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:20}); }
  });

  it("does not reinterpret a restart that owns its existing command and provides no new seat environment", async () => {
    const calls:string[][]=[];
    const adapter=new TmuxAdapter(async()=>"",undefined,async args=>{calls.push(args);return "";});
    const read=vi.fn(()=>({inheritTmuxEnvironment:false,env:{PATH:"/unused"}}));
    adapter.launchEnvironment=read;
    expect((await adapter.respawnPane("%1","previous exact command",{cwd:"/private"})).ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual(["tmux","respawn-pane","-t","%1","-c","/private","previous exact command"]);
  });

  it("keeps the daemon's configured update-environment values, not stale server values", async () => {
    const home=mkdtempSync(path.join(tmpdir(),"tmux-update-env-")),socket=path.join(home,"owned.sock"),observed=path.join(home,"observed");
    vi.stubEnv("SSH_AUTH_SOCK","/synthetic/daemon-agent.sock");vi.stubEnv("SSH_ASKPASS",undefined);vi.stubEnv("Q1178_CUSTOM_UPDATED","daemon-custom");
    const env={...process.env,HOME:home};delete env.TMUX;delete env.TMUX_TMPDIR;
    const tmux=async(args:string[])=>(await exec("tmux",["-S",socket,...args],{env})).stdout.trim();
    const adapter=new TmuxAdapter(async()=>"",undefined,args=>tmux(args.slice(1)));
    adapter.launchEnvironment=()=>({inheritTmuxEnvironment:false,env:{HOME:home,PATH:process.env.PATH!}});
    try {
      await tmux(["-f","/dev/null","new-session","-d","-s","anchor","sleep 60"]);
      await tmux(["set-environment","-g","SSH_AUTH_SOCK","/stale/server-agent.sock"]);
      await tmux(["set-environment","-g","SSH_ASKPASS","stale-server"]);
      await tmux(["set-option","-g","update-environment","SSH_AUTH_SOCK SSH_ASKPASS Q1178_CUSTOM_UPDATED"]);
      await tmux(["set-option","-g","default-shell","/bin/bash"]);
      const script=path.join(home,"observe.sh");
      writeFileSync(script,`export HISTFILE=/dev/null\nprintf '%s|%s|%s\\n' "$SSH_AUTH_SOCK" "\${SSH_ASKPASS-absent}" "$Q1178_CUSTOM_UPDATED" > ${shellQuote(observed)}\nexec /bin/bash --noprofile --norc\n`);
      await tmux(["set-option","-g","default-command",`exec /bin/bash ${shellQuote(script)}`]);
      expect((await adapter.createSession("seat",home,{OPENRIG_NODE_ID:"owned-node"})).ok).toBe(true);
      expect(await waitFile(observed)).toEqual(["/synthetic/daemon-agent.sock","absent","daemon-custom"]);
      expect(await tmux(["show-environment","-g","SSH_AUTH_SOCK"])).toBe("SSH_AUTH_SOCK=/stale/server-agent.sock");
    } finally {await tmux(["kill-server"]).catch(()=>{});vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
  });
  it.each([false, true])("a seat keeps its database and tmux directory when inspection fails=%s", async inspectionFails => {
    const home = mkdtempSync(path.join(tmpdir(), "tmux-instance-")), socket = path.join(home, "owned.sock");
    const observed = path.join(home, "observed");
    const env = { ...process.env, HOME: home }; delete env.TMUX; delete env.TMUX_TMPDIR;
    const tmux = async (args: string[]) => (await exec("tmux", ["-S", socket, ...args], { env })).stdout.trim();
    const adapter = new TmuxAdapter(async () => "", undefined, args => {
      if (inspectionFails && args.includes("default-shell")) throw Error("synthetic inspection failure");
      return tmux(args.slice(1));
    });
    const selected = { HOME: home, PATH: process.env.PATH!, OPENRIG_NODE_ID: "owned", OPENRIG_DB: path.join(home, "selected db.sqlite"), TMUX_TMPDIR: path.join(home, "tmux directory") };
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: selected });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 60"]);
      await tmux(["set-environment", "-g", "OPENRIG_DB", "/stale.sqlite"]);
      await tmux(["set-environment", "-g", "TMUX_TMPDIR", "/stale-tmux"]);
      await tmux(["set-option", "-g", "default-shell", "/bin/bash"]);
      await tmux(["set-option", "-g", "default-command", `printf '%s|%s\\n' "$OPENRIG_DB" "$TMUX_TMPDIR" > ${shellQuote(observed)}; exec /bin/bash --noprofile --norc`]);
      const result = await adapter.createSession("seat", home, selected);
      expect(result.ok).toBe(true);
      expect(result.warnings?.some(w => w.includes("Scoped tmux environment unavailable")) ?? false).toBe(inspectionFails);
      expect(await waitFile(observed)).toEqual([selected.OPENRIG_DB, selected.TMUX_TMPDIR]);
      expect(await tmux(["show-environment", "-g", "OPENRIG_DB"])).toBe("OPENRIG_DB=/stale.sqlite");
    } finally { warn.mockRestore(); await tmux(["kill-server"]).catch(() => {}); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
  });

  it.each(["create","respawn"])("returns the scoped-environment fallback warning to %s callers",async mode=>{
    const adapter=new TmuxAdapter(async()=>"",undefined,async args=>{
      if(args.includes("default-shell"))throw Error("unavailable inspection");
      return args.includes("new-session")?"%1":"";
    });
    adapter.launchEnvironment=()=>({inheritTmuxEnvironment:false,env:{}});
    vi.spyOn(console,"warn").mockImplementation(()=>{});
    try {
      const result=mode==="create"?await adapter.createSession("owned",undefined,{OPENRIG_NODE_ID:"node"}):await adapter.respawnPane("%1","sleep 60",{env:{OPENRIG_NODE_ID:"node"}});
      expect(result).toMatchObject({ok:true,warnings:[expect.stringContaining("Scoped tmux environment unavailable")]});
    } finally {vi.restoreAllMocks();}
  });

});
