import { describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { claudeAuthReaderEnv, claudeAuthStatusReader, resolveClaudeExecutable, runClaudeCommand } from "../src/domain/provider/claude-auth-status-reader.js";

describe.skipIf(process.platform !== "win32")("Windows Claude background commands", () => {
  it("keeps an explicit empty config directory instead of an inherited case-variant selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-empty-config-"));
    try {
      const env = claudeAuthReaderEnv({ home: root, claudeConfigDir: "" }, { claude_config_dir: "inherited-wrong", SystemRoot: process.env.SystemRoot });
      expect(env.CLAUDE_CONFIG_DIR).toBe("");
      expect(env.claude_config_dir).toBeUndefined();
      const result = await runClaudeCommand(process.execPath, env, root, 2000, 100,
        ["-e", "console.log(JSON.stringify({config:process.env.CLAUDE_CONFIG_DIR,cwd:process.cwd()}))"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ config: "", cwd: root });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("selects .exe and removes case-variant seat identity and home overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-claude-reader-"));
    try {
      await copyFile(process.execPath, path.join(root, "claude.exe"));
      expect(resolveClaudeExecutable({ Path: root })).toBe(path.join(root, "claude.exe"));
      const env = claudeAuthReaderEnv({ home: root, launchPath: root, claudeConfigDir: root }, {
        Path: "old", UserProfile: "old", Home: "old", claude_config_dir: "old", disable_autoupdater: "0",
        tmux: "seat", OpenRig_Node_Id: "seat", rigged_host: "seat", Claude_Code_Seat: "seat", claudecode: "seat", KEEP: "value",
      });
      expect(env).toEqual({ PATH: root, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root, DISABLE_AUTOUPDATER: "1", KEEP: "value" });
      const result = await runClaudeCommand(path.join(root, "claude.exe"), env, root, 2000, 100, ["-e", "console.log(JSON.stringify({home:require('os').homedir(),cwd:process.cwd()}))"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ home: root, cwd: root });
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
  it("reads fake npm auth JSON without a batch shell or real login", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-claude-npm-"));
    try {
      const pkg = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
      await mkdir(pkg, { recursive: true });
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }));
      await writeFile(path.join(pkg, "cli.js"), "console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'fixture@example.test'}))");
      await writeFile(path.join(root, "claude.cmd"), '@echo off\r\n"node" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
      await writeFile(path.join(root, "claude.com"), "selection decoy, never executed");
      const env = claudeAuthReaderEnv({ launchPath: [root, path.dirname(process.execPath)].join(path.delimiter), home: root, claudeConfigDir: root }, { PathExt: ".CMD;.EXE;.COM", SystemRoot: process.env.SystemRoot });
      const selected = resolveClaudeExecutable(env);
      expect(selected).toBe(path.join(root, "claude.cmd"));
      const run = await runClaudeCommand(selected!, env, root, 2000, 100);
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ loggedIn: true, email: "fixture@example.test" });
      await rm(path.join(root, "claude.com"));
      const answer = await claudeAuthStatusReader({ launchPath: [root, path.dirname(process.execPath)].join(path.delimiter), home: root, claudeConfigDir: root, timeoutMs: 2000, graceMs: 100 })();
      expect(answer).toMatchObject({ ok: true, auth: { email: "fixture@example.test" } });
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
  it("ends a timed-out owned native process and its live child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-claude-tree-"));
    const receipt = path.join(root, "child.json");
    try {
      const script = `const fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify({pid:c.pid}));setInterval(()=>{},1000)`;
      const result = await runClaudeCommand(process.execPath, process.env, root, 1000, 200, ["-e", script, receipt]);
      expect(result.timedOut).toBe(true);
      const { pid } = JSON.parse(await readFile(receipt, "utf8"));
      await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 2000 }).toBe(false);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
