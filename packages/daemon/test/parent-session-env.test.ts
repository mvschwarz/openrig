import { describe, it, expect } from "vitest";
import { PARENT_SESSION_ENV_KEYS, removeParentSessionEnv } from "../src/domain/parent-session-env.js";

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
