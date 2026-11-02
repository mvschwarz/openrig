import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { pathToFileURL } from "node:url";
import { verifyPaneIdleShell, verifyCodexPaneProcess } from "../src/domain/native-process-lineage.js";
import { verifyWindowsPaneReceiver } from "../src/domain/windows-pane-receiver.js";
import { nextNativeRuntimeExchangeStep } from "../src/domain/native-runtime-switch-exchange.js";
import { ownedWindowsTerminalInvoker as ownedInvoker } from "./helpers/windows-terminal-owned.js";

const enabled = process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX;

describe.skipIf(!enabled)("native psmux PowerShell staging", () => {
  it.each([0,1,2])("exchanges owned session names without moving or killing either ConPTY (attached clients=%i)",async clientCount=>{
    const dir=mkdtempSync(path.join(os.tmpdir(),"openrig-native-name-exchange-"));
    const suffix=randomUUID(),canonical=`owned-canonical-${suffix}`,staging=`owned-staging-${suffix}`,parked=`owned-parked-${suffix}`,nodeId=`owned-node-${suffix}`;
    const invoke=ownedInvoker(dir);
    const adapter=new TmuxAdapter(async()=>{throw Error("No POSIX transport");},undefined,invoke,"psmux");
    const clientPids:number[]=[];
    try{
      const identity={canonical,staging,parking:parked,predecessorGeneration:randomUUID(),successorGeneration:randomUUID()};
      for(const [name,generation] of [[canonical,identity.predecessorGeneration],[staging,identity.successorGeneration]]){
        const created=await adapter.createSession(name!,dir,{OPENRIG_NODE_ID:nodeId,OPENRIG_OCCUPANT_GENERATION:generation!});expect(created.ok,created.message).toBe(true);
      }
      const before=async(name:string)=>{
        const panes=await adapter.listPanes(name);expect(panes).toHaveLength(1);
        return {pane:panes[0]!.id,pid:await adapter.getPanePid(panes[0]!.id)};
      };
      const predecessor=await before(canonical),successor=await before(staging);
      expect(predecessor.pid).toBeGreaterThan(0);expect(successor.pid).toBeGreaterThan(0);expect(predecessor.pid).not.toBe(successor.pid);
      if(clientCount){
        const windows=process.env.SystemRoot??"C:\\Windows";
        const compiler=["Framework64","Framework"].map(folder=>path.join(windows,"Microsoft.NET",folder,"v4.0.30319","csc.exe")).find(existsSync);
        expect(compiler).toBeDefined();
        const source=path.join(dir,"hidden-client.cs"),launcher=path.join(dir,"hidden-client.exe");
        // ShellExecute allocates the child's own console instead of inheriting
        // the test runner's pipes. Its window stays hidden throughout.
        writeFileSync(source,'using System; using System.Diagnostics; using System.Text.RegularExpressions; class Owned { static void Main(string[] a) { if(a.Length!=3 || !Regex.IsMatch(a[1],"^[A-Za-z0-9_-]+$") || !Regex.IsMatch(a[2],"^[A-Za-z0-9_-]+$")) throw new Exception("Invalid owned client arguments"); var s=new ProcessStartInfo(a[0],"-L "+a[1]+" attach-session -t ="+a[2]); s.UseShellExecute=true; s.WindowStyle=ProcessWindowStyle.Hidden; using(var p=Process.Start(s)) Console.WriteLine(p.Id); } }');
        execFileSync(compiler!,["/nologo","/target:exe","/out:"+launcher,source],{windowsHide:true,stdio:"pipe"});
        for(let index=0;index<clientCount;index++){
          const clientPid=Number(execFileSync(launcher,[process.env.OPENRIG_TEST_PSMUX!,invoke.namespace,canonical],{env:invoke.environment,cwd:dir,windowsHide:true,encoding:"utf8"}).trim());
          expect(Number.isSafeInteger(clientPid)&&clientPid>1).toBe(true);clientPids.push(clientPid);
        }
        await expect.poll(async()=>(await adapter.listClients()).filter(client=>client.session===canonical).length,{timeout:5000}).toBe(clientCount);
      }
      const backend=adapter.nativeRuntimeExchangeTerminal(nodeId,identity);
      const exchange=async(direction:"forward"|"rollback")=>{
        for(let attempt=0;attempt<4;attempt++){
          const slots=await backend.observe();
          const step=nextNativeRuntimeExchangeStep(identity,slots,direction);
          if(step.state==="complete")return;
          if(step.state!=="rename")throw Error(step.reason);
          const source=step.from===canonical?slots.canonical:step.from===staging?slots.staging:slots.parking;
          if(source.state!=="present")throw Error("Owned source identity changed");
          await backend.rename(step.from,step.to,source.generation);
        }
        throw Error("Owned exchange did not reach its observed terminal state");
      };
      await expect(backend.rename(canonical,staging,identity.predecessorGeneration)).rejects.toThrow("destination is not proven absent");
      const foreign=adapter.nativeRuntimeExchangeTerminal(`foreign-${suffix}`,identity);
      expect((await foreign.observe()).canonical.state).toBe("unknown");
      await expect(foreign.rename(canonical,parked,identity.predecessorGeneration)).rejects.toThrow("source occupant changed");
      await expect(backend.rename(canonical,parked,identity.successorGeneration)).rejects.toThrow("source occupant changed");
      expect(await before(canonical)).toEqual(predecessor);
      await exchange("forward");
      const active=await before(canonical),retired=await before(staging);
      expect(active.pid).toBe(successor.pid);expect(retired.pid).toBe(predecessor.pid);
      expect(Buffer.from(active.pane.split(":")[1]!,"base64url").toString("utf8")).toBe(canonical);
      // The scope name changes with a rename. Recovery must use generations/PIDs,
      // not mistake a same local %N under the canonical name for the predecessor.
      expect(active.pane).not.toBe(successor.pane);
      expect((await adapter.listSessions()).map(s=>s.name).sort()).toEqual([canonical,staging].sort());
      expect(await adapter.followNativeRuntimeExchangeClients(nodeId,identity)).toEqual({ok:true});
      if(clientCount){
        await expect.poll(async()=>(await adapter.listClients()).filter(client=>client.session===canonical).length,{timeout:5000}).toBe(clientCount);
        for(const clientPid of clientPids)expect(await invoke(["tmux","list-clients","-t",`=${canonical}`,"-F","#{client_pid}|#{client_session}"])).toContain(`${clientPid}|${canonical}`);
        await invoke(["tmux","kill-session","-t",`=${staging}`]);
        expect(await before(canonical)).toEqual(active);
        for(const clientPid of clientPids)expect(await invoke(["tmux","list-clients","-t",`=${canonical}`,"-F","#{client_pid}|#{client_session}"])).toContain(`${clientPid}|${canonical}`);
        return;
      }
      await exchange("rollback");
      expect(await before(canonical)).toEqual(predecessor);expect(await before(staging)).toEqual(successor);
    }finally{
      for(const name of [canonical,staging,parked])await invoke(["tmux","kill-session","-t",`=${name}`]).catch(()=>{});
      await invoke(["tmux","kill-server"]).catch(()=>{});
      for(const clientPid of clientPids)await expect.poll(()=>{try{process.kill(clientPid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return true;throw error;}},{timeout:5000}).toBe(true);
      rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    }
  },45000);
  it("verifies the stock pane label and lineage of an owned native provider stub", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-provider-"));
    const session = `owned-provider-${randomUUID()}`;
    const invoke = ownedInvoker(dir);
    const adapter = new TmuxAdapter(async () => { throw Error("No POSIX transport"); }, undefined, invoke, "psmux");
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    const compiler = ["Framework64", "Framework"].map(folder => path.join(windows, "Microsoft.NET", folder, "v4.0.30319", "csc.exe")).find(existsSync);
    const source = path.join(dir, "owned.cs"), executable = path.join(dir, "codex.exe"), ready = path.join(dir, "ready");
    const token = randomUUID();
    writeFileSync(source, 'using System; using System.IO; using System.Threading; class Owned { static void Main() { File.WriteAllText(Environment.GetEnvironmentVariable("OPENRIG_TEST_READY"), "owned"); Thread.Sleep(60000); } }');
    try {
      expect(compiler).toBeDefined();
      execFileSync(compiler!, ["/nologo", "/target:exe", "/out:" + executable, source], { windowsHide: true, stdio: "pipe" });
      expect(await adapter.createSession(session, dir)).toEqual({ ok: true });
      const pane = (await adapter.listPanes(session))[0]!;
      const q = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      expect(await adapter.sendShellCommand(pane.id, renderWindowsLaunch([executable, "resume", token].map(q).join(" "), { OPENRIG_TEST_READY: ready }))).toEqual({ ok: true });
      await expect.poll(() => existsSync(ready), { timeout: 5000 }).toBe(true);
      // The child can publish readiness before psmux refreshes its foreground label.
      await expect.poll(() => adapter.getPaneCommand(pane.id), { timeout: 8000, interval: 200 }).toBe("codex");
      const observation = await verifyCodexPaneProcess({ target: pane.id, tmux: adapter, expectedToken: token, requireResume: true, requireArgv: true });
      expect(observation?.process.pid).toBeGreaterThan(0);
      expect(observation?.process.executablePath?.replaceAll("\\", "/").toLowerCase()).toBe(executable.replaceAll("\\", "/").toLowerCase());
      expect(await verifyPaneIdleShell({ target: pane.id, tmux: adapter })).toBe(false);
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      await invoke(["tmux", "kill-server"]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30000);
  it("witnesses an idle stock pane and refuses it after an owned receiver starts", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-idle-"));
    const session = `owned-idle-${randomUUID()}`;
    const invoke = ownedInvoker(dir);
    const adapter = new TmuxAdapter(async () => { throw Error("No POSIX transport"); }, undefined, invoke, "psmux");
    const ready = path.join(dir, "ready"), script = path.join(dir, "receiver.cjs");
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(ready)},'owned');setInterval(()=>{},1000);`);
    try {
      expect(await adapter.createSession(session, dir)).toEqual({ ok: true });
      const pane = (await adapter.listPanes(session))[0]!;
      const input = { target: pane.id, tmux: adapter };
      await expect.poll(() => verifyPaneIdleShell(input), { timeout: 8000, interval: 200 }).toBe(true);
      expect(await verifyWindowsPaneReceiver({ target: pane.id, getPanePid: target => adapter.getPanePid(target) })).toBe(false);
      const q = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      expect(await adapter.sendShellCommand(pane.id, renderWindowsLaunch([process.execPath, script].map(q).join(" ")))).toEqual({ ok: true });
      await expect.poll(() => existsSync(ready), { timeout: 5000 }).toBe(true);
      expect(await verifyPaneIdleShell(input)).toBe(false);
      expect(await verifyWindowsPaneReceiver({ target: pane.id, getPanePid: target => adapter.getPanePid(target) })).toBe(true);
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      await invoke(["tmux", "kill-server"]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30000);
  it("delivers a multiline block as one runner submission", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-input-"));
    const session = `openrig-input-${process.pid}-${Date.now()}`;
    const output = path.join(dir, "result.json"), ready = path.join(dir, "ready");
    const script = path.join(dir, "receiver.mjs");
    const runner = pathToFileURL(path.resolve(import.meta.dirname, "../dist/adapters/pi-runner.js")).href;
    writeFileSync(script, `import fs from 'node:fs'; import {createRunnerInput} from ${JSON.stringify(runner)};
      createRunnerInput(process.stdin, process.stdout, block => { fs.writeFileSync(${JSON.stringify(output + ".tmp")}, JSON.stringify(block)); fs.renameSync(${JSON.stringify(output + ".tmp")}, ${JSON.stringify(output)}); process.exit(0); });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
    const invoke = ownedInvoker(dir);
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, dir)).toEqual({ ok: true });
      const q = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
      expect(await adapter.sendShellCommand(session, renderWindowsLaunch([process.execPath, script].map(q).join(" "), {}))).toEqual({ ok: true });
      const waitForFile = async (file: string) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) { try { return readFileSync(file, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
        const screen = await adapter.capturePaneScreen(session);
        throw new Error(`receiver did not produce ${path.basename(file)}; fixture screen: ${screen?.slice(-1200) ?? "unavailable"}`);
      };
      await waitForFile(ready);
      const pane = (await adapter.listPanes(session))[0]!;
      const message = "first line\nsecond line; 中文";
      const phases: string[] = [];
      // Exercise the console-input branch with the same policy callbacks that
      // sendText supplies for a draft-aware delivery.
      const native = adapter as unknown as { sendTextUnchecked(target: string, text: string, beforeWrite: () => void, bracketed: boolean,
        policy: { beforePaste: () => Promise<void>; afterPaste: () => Promise<void> }): Promise<unknown> };
      expect(await native.sendTextUnchecked(pane.id, "blocked", () => { phases.push("write"); }, true, {
        beforePaste: async () => { phases.push("before"); throw new Error("draft changed"); },
        afterPaste: async () => { phases.push("after"); },
      })).toMatchObject({ ok: false });
      expect(phases).toEqual(["before"]);
      phases.length = 0;
      expect(await native.sendTextUnchecked(pane.id, message, () => { phases.push("write"); }, true, {
        beforePaste: async () => { phases.push("before"); },
        afterPaste: async () => { phases.push("after"); },
      })).toEqual({ ok: true });
      expect(phases).toEqual(["before", "write", "after"]);
      expect(await adapter.sendKeys(pane.id, ["Enter"])).toEqual({ ok: true });
      expect(JSON.parse(await waitForFile(output))).toBe(message);
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      await invoke(["tmux", "kill-server"]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
  it("delivers exact native argv and environment through a real pane", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-"));
    const session = `openrig-test-${process.pid}-${Date.now()}`;
    const decoy = `${session}-other`;
    const output = path.join(dir, "result.json");
    const script = path.join(dir, "echo args.js");
    writeFileSync(script, `require('fs').writeFileSync(process.argv[2], JSON.stringify({args: process.argv.slice(3), marker: process.env.OPENRIG_TEST_MARKER}));`);
    const invoke = ownedInvoker(dir);
    const adapter = new TmuxAdapter(async () => { throw new Error("POSIX shell execution is forbidden in this probe"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, dir)).toEqual({ ok: true });
      expect(await adapter.createSession(decoy, dir)).toEqual({ ok: true });
      const q = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
      const args = ["space word", "a'b", "中文;$HOME", "", 'embedded"quote', "space trailing\\", "trailing\\"];
      const command = [process.execPath, script, output, ...args].map(q).join(" ");
      const panes = await adapter.listPanes(session);
      expect(panes).toHaveLength(1);
      expect(panes[0]!.id).toMatch(/^psmux:.*:%\d+$/);
      const other = (await adapter.listPanes(decoy))[0]!;
      expect(other.id).not.toBe(panes[0]!.id);
      expect(await adapter.sendShellCommand(panes[0]!.id, renderWindowsLaunch(command, { OPENRIG_TEST_MARKER: "native-ok" }))).toEqual({ ok: true });
      let result: unknown;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        try { result = JSON.parse(readFileSync(output, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      expect(result).toEqual({ args, marker: "native-ok" });
      expect(await adapter.killSession(session)).toEqual({ ok: true });
      expect((await adapter.probeSession(session)).state).toBe("absent");
      expect((await adapter.probeSession(decoy)).state).toBe("present");
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      await invoke(["tmux", "kill-session", "-t", `=${decoy}`]).catch(() => {});
      await invoke(["tmux", "kill-server"]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
});
