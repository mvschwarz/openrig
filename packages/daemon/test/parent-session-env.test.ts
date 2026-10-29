import { describe, it, expect } from "vitest";
import { PARENT_SESSION_ENV_KEYS, removeParentSessionEnv } from "../src/domain/parent-session-env.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { spawnSync } from "node:child_process";

const CONFIGURATION = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  CLAUDE_CONFIG_DIR: "/c",
  CODEX_HOME: "/x",
  ANTHROPIC_API_KEY: "a",
  OPENAI_API_KEY: "o",
  OPENRIG_HOME: "/r",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_OAUTH_TOKEN: "t",
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9",
  HERDR_SOCKET_PATH: "/h.sock",
};

describe("removeParentSessionEnv", () => {
  it.runIf(process.platform === "win32")("a native child receives configuration but no lower-case parent identity", () => {
    const env = { claudecode: "1", Claude_Effort: "parent", herdr_pane_id: "parent", rex_block: "parent", claude_code_use_bedrock: "1" };
    removeParentSessionEnv(env);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({parent:['CLAUDECODE','CLAUDE_EFFORT','HERDR_PANE_ID','REX_BLOCK'].some(k=>process.env[k]!==undefined),configuration:process.env.CLAUDE_CODE_USE_BEDROCK==='1'}))"], { env, encoding: "utf8", windowsHide: true, timeout: 5000 });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ parent: false, configuration: true });
  });

  it.runIf(process.platform === "win32")("marks native inherited case variants removed when unsetting canonical parent identity", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("No shell transport"); }, undefined, async argv => {
      if (argv[1] === "show-environment") return "claudecode=1\nClaude_Effort=synthetic-parent\n";
      calls.push(argv);
      return "";
    }, "psmux");
    await adapter.unsetSessionEnv("owned", "CLAUDE_EFFORT");
    expect(calls).toEqual([
      ["tmux", "set-environment", "-t", "=owned", "-r", "CLAUDE_EFFORT"],
      ["tmux", "set-environment", "-t", "=owned", "-r", "Claude_Effort"],
    ]);
  });

  it("removes all native case variants of named parent identity without dropping configuration", () => {
    const env = { claudecode: "1", CLAUDECODE: "1", Claude_Effort: "max", herdr_pane_id: "synthetic", rex_block: "synthetic", claude_code_use_bedrock: "1", claude_code_oauth_token: "synthetic-config" };
    expect(removeParentSessionEnv(env, "win32").sort()).toEqual(["claudecode", "CLAUDECODE", "Claude_Effort", "herdr_pane_id", "rex_block"].sort());
    expect(env).toEqual({ claude_code_use_bedrock: "1", claude_code_oauth_token: "synthetic-config" });
  });

  it("keeps lower-case names on POSIX and keeps native effort without a parent", () => {
    const posix = { claudecode: "1", claude_effort: "high", herdr_pane_id: "synthetic" };
    expect(removeParentSessionEnv(posix, "linux")).toEqual([]);
    const native = { Claude_Effort: "high", herdr_pane_id: "synthetic" };
    expect(removeParentSessionEnv(native, "win32")).toEqual(["herdr_pane_id"]);
    expect(native).toEqual({ Claude_Effort: "high" });
  });

  it("removes the named identity variables and CLAUDE_EFFORT from a Claude Code parent, leaving configuration untouched", () => {
    const env: Record<string, string | undefined> = {
      ...CONFIGURATION,
      ...Object.fromEntries(PARENT_SESSION_ENV_KEYS.map((k) => [k, "1"])),
      CLAUDE_EFFORT: "max",
    };
    const removed = removeParentSessionEnv(env);
    expect(removed.sort()).toEqual([...PARENT_SESSION_ENV_KEYS, "CLAUDE_EFFORT"].sort());
    expect(env).toEqual(CONFIGURATION);
  });

  it("keeps CLAUDE_EFFORT when no parent Claude Code session is present", () => {
    const env: Record<string, string | undefined> = { ...CONFIGURATION, CLAUDE_EFFORT: "high", HERDR_PANE_ID: "p1" };
    expect(removeParentSessionEnv(env)).toEqual(["HERDR_PANE_ID"]);
    expect(env).toEqual({ ...CONFIGURATION, CLAUDE_EFFORT: "high" });
  });

  it("is a no-op on a clean environment", () => {
    const env: Record<string, string | undefined> = { ...CONFIGURATION };
    expect(removeParentSessionEnv(env)).toEqual([]);
    expect(env).toEqual(CONFIGURATION);
  });
});
