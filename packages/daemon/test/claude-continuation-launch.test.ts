import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { continuationArguments, captureClaudeContinuation, resumedClaudeArguments, continuationPermission } from "../src/domain/claude-continuation-launch.js";
import { readNativeProcessLaunch } from "../src/domain/native-process-arguments.js";

const help = `  --settings <file-or-json>  Settings
  --model <model>  Model
  --effort <level>  Effort
  -r, --resume [id]  Resume
  --session-id <id>  Identity
  --fork-session  Fork
  --permission-mode <mode>  Mode
  --add-dir <dirs...>  Directories
  --chrome  Chrome
  --name <name>  Name`;

it("retains quoted settings/model/options and replaces native identity without replaying the prompt", () => {
  const original = ["/native/claude", "--settings", "/my rules/settings.json", "--model=opus", "--permission-mode", "auto", "--add-dir", "/a b", "/Ω", "--chrome", "--session-id", "original", "do the startup work"];
  const launch = continuationArguments(original, help);
  expect(launch.args).toEqual(original.slice(1, -3));
  expect(launch.warnings).toEqual(["A positional startup input was not replayed."]);
  expect(resumedClaudeArguments(launch, [], "original", "high")).toEqual([...original.slice(1, -3), "--effort", "high", "--resume", "original"]);
  expect(continuationPermission(launch)).toBe("--permission-mode auto");
});

it("keeps inline JSON bytes, updates existing effort, removes fork/old resume, and names unknowns without their values", () => {
  const launch = continuationArguments(["claude", "--settings={\"permissions\":{\"allow\":[\"Read(/a b)\"]}}", "--effort=low", "--fork-session", "--resume", "old", "--future-option=private-value"], help);
  expect(resumedClaudeArguments(launch, [], "same", "max")).toEqual(["--settings={\"permissions\":{\"allow\":[\"Read(/a b)\"]}}", "--effort", "max", "--resume", "same"]);
  expect(launch.warnings).toEqual(["Running option --future-option could not be mapped; not carried."]);
  expect(continuationPermission(launch)).toBe("");
});

it("an unavailable capture uses generated arguments without a new hold", () => {
  expect(resumedClaudeArguments({ warnings: ["unavailable"] }, ["--settings", "generated", "--resume", "same"], "same")).toEqual(["--settings", "generated", "--resume", "same"]);
});

describe.skipIf(!["linux", "darwin"].includes(process.platform))("native launch capture, owned scratch process only", () => {
  it("reads exact argv/config/environment and excludes old auth from the continuation", async () => {
    const child = spawn(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)', "a b", "Ω"], {
      env: { PATH: process.env.PATH!, HOME: "/tmp", CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "a=b\nΩ", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old-token" }, stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await once(child.stdout!, "data");
      const actual = await readNativeProcessLaunch(child.pid!);
      expect(actual?.argv.slice(-2)).toEqual(["a b", "Ω"]);
      expect(actual?.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "a=b\nΩ" });
      const kept = await captureClaudeContinuation(child.pid!, "/definitely-unavailable-claude");
      expect(kept.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "a=b\nΩ" });
      expect(kept.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(kept.warnings.join(" ")).toContain("ordinary arguments");
      expect(kept.args).toBeUndefined();
    } finally { child.kill("SIGTERM"); await once(child, "close"); }
  }, 15_000);
});
