import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCodexCli } from "../src/adapters/codex-runtime-adapter.js";

it.runIf(process.platform === "win32")("runs the plugin CLI through its selected offline npm entry with exact arguments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex plugin native-"));
  try {
    const pkg = path.join(root, "node_modules", "@openai", "codex");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "cli.cjs" } }));
    fs.writeFileSync(path.join(pkg, "cli.cjs"), "console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME}));");
    fs.writeFileSync(path.join(root, "codex.cmd"), '@echo off\r\n"node" "%dp0%\\node_modules\\@openai\\codex\\cli.cjs" %*\r\n');
    const args = ["plugin", "marketplace", "add", "synthetic 中文 space ' & %", "", "trailing\\"];
    const home = path.join(root, "owned home");
    const env = { PATH: [root, path.dirname(process.execPath)].join(path.delimiter), PATHEXT: ".CMD;.EXE", CODEX_HOME: home };
    const result = await defaultCodexCli(args, env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args, home });
    const missing = await defaultCodexCli(["plugin", "add", "synthetic"], { PATH: root, PATHEXT: "" });
    expect(missing).toMatchObject({ status: null, stdout: "", stderr: expect.stringContaining("No codex executable") });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
