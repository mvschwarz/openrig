import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveWindowsPiCommand } from "../src/adapters/windows-pi-command.js";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";

describe("Windows Pi executable resolution", () => {
  it.runIf(process.platform === "win32")("pins the actual OMP child home and forwards only its selected native provider", () => {
    const home = path.join(os.tmpdir(), "synthetic-omp-seat"), agentDir = path.join(home, "agent");
    const env = buildPiChildEnv({ HOME: "C:\\synthetic-operator", USERPROFILE: "C:\\synthetic-operator", path: path.dirname(process.execPath), systemroot: process.env.SystemRoot, anthropic_api_key: "synthetic-selected", openai_api_key: "synthetic-denied", openrig_activity_hook_token: "synthetic-denied" }, {
      runtime: "omp", agentDir, sessionsDir: path.join(home, "sessions"), platform: "win32", model: "anthropic/fixture",
    });
    const observed = JSON.parse(execFileSync(process.execPath, ["-e", "console.log(JSON.stringify({home:require('os').homedir(),configured:process.env.HOME,selected:process.env.ANTHROPIC_API_KEY==='synthetic-selected',other:process.env.OPENAI_API_KEY!==undefined,hook:process.env.OPENRIG_ACTIVITY_HOOK_TOKEN!==undefined}))"], { env, encoding: "utf8", windowsHide: true, timeout: 5000 }));
    expect(observed).toEqual({ home, configured: home, selected: true, other: false, hook: false });
  });

  it("resolves a standard npm shim without evaluating cmd.exe", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-resolve-"));
    const pkg = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    try {
      mkdirSync(path.join(pkg, "dist"), { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }));
      writeFileSync(path.join(pkg, "dist", "cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      writeFileSync(path.join(dir, "pi.cmd"), '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*');
      expect(resolveWindowsPiCommand(dir, process.execPath)).toEqual({ command: process.execPath, prefix: [path.join(pkg, "dist", "cli.js")] });
      expect(resolveWindowsPiCommand(`"${dir}"`, process.execPath)).toEqual({ command: process.execPath, prefix: [path.join(pkg, "dist", "cli.js")] });
      const resolved = resolveWindowsPiCommand(`"${dir}"`, process.execPath);
      expect(() => resolveWindowsPiCommand(dir, process.execPath, dir, "")).toThrow("Pi was not found");
      const args = ["中文 space", "a'b", 'double"quote', "", "%PATH%", "amp&word", "tail\\"];
      expect(JSON.parse(execFileSync(resolved.command, [...resolved.prefix, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000 }))).toEqual(args);
      writeFileSync(path.join(dir, "pi.cmd"), "unknown custom launcher");
      expect(() => resolveWindowsPiCommand(dir, process.execPath)).toThrow("Unrecognized");
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../outside.js" } }));
      expect(() => resolveWindowsPiCommand(dir, process.execPath)).toThrow("escapes");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("forwards Windows runtime locations while retaining provider denial", () => {
    const source = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\probe", APPDATA: "C:\\Users\\probe\\AppData\\Roaming", TEMP: "C:\\Temp", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files", GH_TOKEN: "private", GITHUB_TOKEN: "private", ANTHROPIC_API_KEY: "private", UNRELATED_SECRET: "private" };
    const env = buildPiChildEnv(source, { agentDir: "seat-agent", sessionsDir: "sessions", platform: "win32", model: "openai-codex/gpt-6-luna" });
    expect(env.SystemRoot).toBe(source.SystemRoot);
    expect(env.USERPROFILE).toBe(source.USERPROFILE);
    expect(env.APPDATA).toBe(source.APPDATA);
    expect(env.ProgramFiles).toBe(source.ProgramFiles);
    expect(env["ProgramFiles(x86)"]).toBe(source["ProgramFiles(x86)"]);
    expect(env.ProgramW6432).toBe(source.ProgramW6432);
    expect(env.PI_CODING_AGENT_DIR).toBe("seat-agent");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("UNRELATED_SECRET");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(buildPiChildEnv(source, { agentDir: "a", sessionsDir: "s", platform: "linux" })).not.toHaveProperty("SystemRoot");
  });
});
