// #1178 pre-code qualification. The clean command is a prototype, not product behavior.
// Real private tmux and bash; synthetic names only, no provider or owner server.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
const exec = promisify(execFile);
const waitFile = async (file: string) => {
  for (let i=0; i<100 && !existsSync(file); i++) await new Promise(r=>setTimeout(r,25));
  return readFileSync(file,"utf8").trim().split("|");
};
describe.skipIf(process.platform !== "linux")("#1178 initial-shell environment premise (prototype)", () => {
  for (const clean of [false,true]) for (const successor of [false,true]) {
    it(`${clean ? "prototype daemon baseline" : "stock inherited"}, ${successor ? "successor" : "fresh"}: shell startup and classic function remain usable`, async () => {
      const home=mkdtempSync(path.join(tmpdir(),"tmux-premise-")), socket=path.join(home,"owned.sock");
      const env={...process.env, HOME:home}; delete env.TMUX; delete env.TMUX_TMPDIR;
      const tmux=async(args:string[]) => (await exec("tmux",["-S",socket,...args],{env})).stdout.trim();
      const adapter=new TmuxAdapter(async()=>{throw new Error("argv fixture only");}, undefined, args=>tmux(args.slice(1)));
      const initial=path.join(home,"shell-before"), final=path.join(home,"classic-after");
      const cli=path.join(home,"rig-fixture"), rc=path.join(home,"private.bashrc");
      writeFileSync(cli,"#!/bin/sh\nexit 0\n",{mode:0o755});
      // This deliberately custom default-command must still run; its function and override are intended setup.
      writeFileSync(rc, `printf '%s|%s|%s|%s' "\${Q1178_SERVER-absent}" "\${Q1178_DAEMON-absent}" "\${Q1178_AUTH-absent}" "\${TMUX_PANE-absent}" > ${shellQuote(initial)}\nexport Q1178_STARTUP=startup Q1178_AUTH=startup\nclaude() { printf '%s|%s|%s|%s' "\${Q1178_SERVER-absent}" "\${Q1178_DAEMON-absent}" "$Q1178_AUTH" "$Q1178_STARTUP" > ${shellQuote(final)}; }\n`);
      const custom=`exec /bin/bash --noprofile --rcfile ${shellQuote(rc)} -i`;
      const selected={HOME:home,PATH:process.env.PATH!,OPENRIG_HOME:home,OPENRIG_NODE_ID:"node",OPENRIG_SESSION_NAME:"seat",Q1178_AUTH:"daemon"};
      const baseline={...selected,Q1178_DAEMON:"daemon"};
      // Multiple argv bypass the user's default shell until this fixed non-interactive sh has reset env.
      // Generated pane metadata comes from tmux, not the daemon's possibly stale TMUX value.
      const reset=["/bin/sh","-c",`exec /usr/bin/env -i ${Object.entries(baseline).map(([k,v])=>shellQuote(k+"="+v)).join(" ")} TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" TERM="$TERM" SHELL="$SHELL" "$@"`,"sh","/bin/bash","-c",custom];
      try {
        await tmux(["-f","/dev/null","new-session","-d","-s","anchor","sleep 60"]);
        await tmux(["set-environment","-g","Q1178_SERVER","tmux"]);
        await tmux(["set-environment","-g","Q1178_AUTH","tmux"]);
        await tmux(["set-option","-g","default-shell","/bin/bash"]);
        await tmux(["set-option","-g","default-command",custom]);
        if (successor) {
          await tmux(["new-session","-d","-s","seat","sleep 60"]);
          if (clean) await tmux(["respawn-pane","-k","-t","=seat:",...reset]);
          else { await tmux(["respawn-pane","-k","-t","=seat:",...Object.entries(selected).flatMap(([k,v])=>["-e",k+"="+v]),"/bin/bash","-c",custom]); }
        } else if (clean) await tmux(["new-session","-d","-s","seat",...reset]);
        else expect((await adapter.createSession("seat",home,selected)).ok).toBe(true);
        const before=await waitFile(initial);
        expect(before.slice(0,3)).toEqual([clean?"absent":"tmux",clean?"daemon":"absent","daemon"]);
        expect(before[3]).toMatch(/^%\d+$/);
        const command=await new SeatLaunchEnvironment(adapter,selected,home,cli).command("seat","claude",{runtime:"claude-code"});
        // Baseline prototype did not write the session environment. Product integration must bind metadata there too.
        if (clean) for(const [key,value] of Object.entries(selected)) await tmux(["set-environment","-t","=seat",key,value]);
        await tmux(["send-keys","-t","=seat:","-l",command]); await tmux(["send-keys","-t","=seat:","Enter"]);
        expect(await waitFile(final)).toEqual([clean?"absent":"tmux",clean?"daemon":"absent","startup","startup"]);
        expect(await tmux(["show-environment","-g","Q1178_SERVER"])).toBe("Q1178_SERVER=tmux");
        // The pre-existing neighbor stays alive; no global reset or restart.
        expect(await tmux(["display-message","-p","-t","=anchor:","#{pane_dead}"])).toBe("0");
      } finally { await tmux(["kill-server"]).catch(()=>{}); rmSync(home,{recursive:true,force:true}); }
    },15000);
  }
});
