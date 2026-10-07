import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowsPiCommand } from "../src/adapters/windows-pi-command.js";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";

describe("Windows Pi executable resolution", () => {
  it("resolves a standard npm shim without evaluating cmd.exe", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-resolve-"));
    const pkg = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    try {
      mkdirSync(path.join(pkg, "dist"), { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }));
      writeFileSync(path.join(pkg, "dist", "cli.js"), "");
      writeFileSync(path.join(dir, "pi.cmd"), '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*');
      expect(resolveWindowsPiCommand(dir, process.execPath)).toEqual({ command: process.execPath, prefix: [path.join(pkg, "dist", "cli.js")] });
      writeFileSync(path.join(dir, "pi.cmd"), "unknown custom launcher");
      expect(() => resolveWindowsPiCommand(dir, process.execPath)).toThrow("Unrecognized");
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../outside.js" } }));
      expect(() => resolveWindowsPiCommand(dir, process.execPath)).toThrow("escapes");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("forwards Windows runtime locations while retaining provider denial", () => {
    const source = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\probe", TEMP: "C:\\Temp", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files", ANTHROPIC_API_KEY: "private", UNRELATED_SECRET: "private" };
    const env = buildPiChildEnv(source, { agentDir: "seat-agent", sessionsDir: "sessions", platform: "win32", model: "openai-codex/gpt-6-luna" });
    expect(env.SystemRoot).toBe(source.SystemRoot);
    expect(env.USERPROFILE).toBe(source.USERPROFILE);
    expect(env.ProgramFiles).toBe(source.ProgramFiles);
    expect(env["ProgramFiles(x86)"]).toBe(source["ProgramFiles(x86)"]);
    expect(env.ProgramW6432).toBe(source.ProgramW6432);
    expect(env.PI_CODING_AGENT_DIR).toBe("seat-agent");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("UNRELATED_SECRET");
    expect(buildPiChildEnv(source, { agentDir: "a", sessionsDir: "s", platform: "linux" })).not.toHaveProperty("SystemRoot");
  });
});
