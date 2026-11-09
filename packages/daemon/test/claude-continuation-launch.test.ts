import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { continuationArguments, captureClaudeContinuation, resumedClaudeArguments, continuationPermission, continuationChoiceNotes } from "../src/domain/claude-continuation-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
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
      env: { PATH: process.env.PATH!, HOME: "/tmp", CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "a=b\nΩ", NPM_TOKEN: "synthetic-unrelated-secret-2853", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old-token" }, stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await once(child.stdout!, "data");
      const actual = await readNativeProcessLaunch(child.pid!);
      expect(actual?.argv.slice(-2)).toEqual(["a b", "Ω"]);
      expect(actual?.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "a=b\nΩ" });
      const kept = await captureClaudeContinuation(child.pid!, "/definitely-unavailable-claude", async env => Object.keys(env).filter(k => k === "NPM_TOKEN"));
      expect(JSON.stringify(kept)).not.toMatch(/synthetic-unrelated-secret-2853|synthetic-old-token|a=b/);
      expect(kept.configDir).toBe("/custom config");
      expect(kept).not.toHaveProperty("env");
      expect(Object.keys(actual!.env).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CUSTOM_SETTING", "HOME", "NPM_TOKEN", "PATH"]);
      expect(kept.warnings.join(" ")).toContain("NPM_TOKEN");
      expect(kept.warnings.join(" ")).toContain("ordinary arguments");
      expect(kept.args).toBeUndefined();
      const send = vi.fn(async () => ({ ok: true as const }));
      const tmux = { sendShellCommand: send, getPaneCommand: async () => "claude", capturePaneContent: async () => "", getPanePid: async () => null, listPanes: async () => [] } as never;
      const adapter = new ClaudeCodeAdapter({ tmux, sleep: async () => {}, seatLaunchEnvironment: { command: async (_session: string, command: string) => command } as never });
      const result = await adapter.launchHarness({ id: "b", nodeId: "n", tmuxSession: "owned-fixture", updatedAt: "", cwd: "/tmp", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
        claudeExecutable: "/native/claude", claudeLaunch: kept }, { name: "owned-fixture", resumeToken: "same" });
      const dispatched = vi.mocked(send).mock.calls[0];
      expect(JSON.stringify(dispatched)).not.toMatch(/synthetic-unrelated-secret-2853|synthetic-old-token|a=b/);
      expect(JSON.stringify(result)).not.toMatch(/synthetic-unrelated-secret-2853|synthetic-old-token|a=b/);
      expect(JSON.stringify(dispatched)).toContain("CLAUDE_CONFIG_DIR");

    } finally { child.kill("SIGTERM"); await once(child, "close"); }
  }, 15_000);
});

it("carries a required option value beginning with a dash", () => {
  expect(continuationArguments(["claude", "--settings", "-rules.json", "--model", "opus"], help).args).toEqual(["--settings", "-rules.json", "--model", "opus"]);
});

it("selected posture replaces a running bypass while the running model is retained", () => {
  const launch = { args: ["--dangerously-skip-permissions", "--model", "opus", "--permission-mode=auto"], warnings: [] };
  expect(resumedClaudeArguments(launch, [], "same", "high", "--permission-mode acceptEdits")).toEqual(["--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--resume", "same"]);
});

it("names saved posture and model differences without changing the model", () => {
  const launch = { args: ["--dangerously-skip-permissions", "--model", "opus"], warnings: [] };
  expect(continuationChoiceNotes(launch, "--permission-mode acceptEdits", "sonnet")).toEqual([
    "The saved permission posture --permission-mode acceptEdits replaces the running --dangerously-skip-permissions.",
    "The running model opus is kept instead of the saved model sonnet.",
  ]);
  expect(continuationChoiceNotes({ args: [], warnings: [] }, "--permission-mode acceptEdits", "sonnet")).toContain("The running model (no --model flag) is kept instead of the saved model sonnet.");
});
