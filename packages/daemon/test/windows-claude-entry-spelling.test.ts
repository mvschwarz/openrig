import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recognizedWindowsClaudeScript } from "../src/domain/windows-provider-command.js";

it.runIf(process.platform === "win32")("recognizes the declared npm entry through native filename spelling and refuses another script", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-entry-spelling-"));
  try {
    const pkg = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }));
    const script = path.join(pkg, "cli.js");
    fs.writeFileSync(script, "// owned identity witness; never executed");
    const other = path.join(pkg, "other.js");
    fs.writeFileSync(other, "// distinct script; never executed");
    expect(recognizedWindowsClaudeScript(path.join(pkg, "CLI.js"))).toBe(fs.realpathSync.native(script));
    expect(recognizedWindowsClaudeScript(other)).toBeNull();
    expect(recognizedWindowsClaudeScript(path.join(pkg, "missing.js"))).toBeNull();
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "unrelated", bin: "cli.js" }));
    expect(recognizedWindowsClaudeScript(script)).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
