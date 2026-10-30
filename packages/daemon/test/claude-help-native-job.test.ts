import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";

it.runIf(process.platform === "win32").each(["timeout", "success"])("contains the owned native Claude help query on %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-help-job-"));
  const db = new Database(":memory:");
  const pidFile = path.join(root, "owned-descendant.pid");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const pkg = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(root, "node.exe"));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }));
    fs.writeFileSync(path.join(root, "claude.cmd"), '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    const descendant = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.exit(0),9000);`;
    const help = '--permission-mode <mode> (choices: "auto", "default")';
    fs.writeFileSync(path.join(pkg, "cli.js"), mode === "success" ? `console.log(${JSON.stringify(help)});`
      : `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true,detached:true});child.unref();setTimeout(()=>process.exit(0),9000);`);
    db.exec("CREATE TABLE nodes(id TEXT,runtime TEXT,cwd TEXT);CREATE TABLE bindings(id TEXT,node_id TEXT,tmux_session TEXT,tmux_pane TEXT);CREATE TABLE occupant_tenures(node_id TEXT,generation_uuid TEXT,generation_ordinal INTEGER)");
    db.prepare("INSERT INTO nodes VALUES ('owned','claude-code',?)").run(root);
    const managed = new ClaudeManagedLaunch(db, { PATH: root, HOME: root, PATHEXT: ".CMD;.EXE" }, {}, undefined, undefined, "win32");
    if (mode === "success") {
      const prepared = await managed.prepare({ nodeId: "owned" }, "auto");
      expect(prepared.selectedScript).toBe(fs.realpathSync.native(path.join(pkg, "cli.js")));
    } else {
      await expect(managed.prepare({ nodeId: "owned" }, "auto")).rejects.toThrow("Claude managed capability query failed; no fallback was selected.");
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      expect(alive(pid)).toBe(false);
    }
  } finally {
    // Every owned fixture has a finite self-exit. Wait for that exit on an old
    // implementation; never signal a numeric PID after observing it from disk.
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      const until = Date.now() + 11000;
      while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
      if (alive(pid)) throw new Error("owned help descendant has not self-exited; fixture retained");
    }
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 25000);
