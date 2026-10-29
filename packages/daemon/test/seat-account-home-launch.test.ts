import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(shell = "sh", persisted = false, configured?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "seat-account-home-")); roots.push(root);
  const bin = path.join(root, "bin"); mkdirSync(bin);
  const home = path.join(root, "selected-account"); mkdirSync(home);
  const cli = path.join(bin, "rig"); writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  for (const runtime of ["codex", "claude"]) writeFileSync(path.join(bin, runtime), `#!/bin/sh
printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' "\${CODEX_HOME-}" "\${CLAUDE_CONFIG_DIR-}" "\${CLAUDE_CODE_OAUTH_TOKEN+set}" "\${ANTHROPIC_API_KEY+set}" "\${OPENAI_API_KEY+set}" "\${CODEX_ACCESS_TOKEN+set}" "\${OPENAI_FEDERATION_RULE_ID+set}" "\${OPENAI_IDENTITY_TOKEN_FILE+set}" "\${OPENAI_PROJECT_ID+set}" "\${AWS_BEARER_TOKEN_BEDROCK+set}" "\${ANTHROPIC_PROFILE+set}" "\${ANTHROPIC_FEDERATION_RULE_ID+set}" "\${ANTHROPIC_ORGANIZATION_ID+set}"
`, { mode: 0o700 });
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig" };
  const tmux = { getPaneCommand: async () => shell, getSessionEnv: async (_session: string, key: string) => identity[key] } as unknown as TmuxAdapter;
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, OPENRIG_HOME: path.join(root, "instance") };
  const launch = new SeatLaunchEnvironment(tmux, env, root, cli, undefined, persisted ? (_node, _runtime, ignoreAccountHome) => ignoreAccountHome ? configured : home : undefined);
  return { root, home, launch, env };
}

describe.skipIf(process.platform === "win32")("an isolated account-home launch", () => {
  it.each(["codex", "claude-code"])("%s selects its home and removes inherited provider credentials only in its child", async runtime => {
    const f = fixture();
    const command = await f.launch.command("seat@rig", runtime === "codex" ? "codex --version" : "claude --version", {
      nodeId: "node", runtime, accountHome: f.home, ...(runtime === "codex" ? { codexCwd: f.root } : {}),
    });
    const env = { ...f.env, CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old-token", ANTHROPIC_API_KEY: "synthetic-old-key", OPENAI_API_KEY: "synthetic-old-openai",
      CODEX_ACCESS_TOKEN: "synthetic-old-access", OPENAI_FEDERATION_RULE_ID: "synthetic-old-rule", OPENAI_IDENTITY_TOKEN_FILE: "/synthetic-old-identity-file",
      OPENAI_PROJECT_ID: "synthetic-old-project", AWS_BEARER_TOKEN_BEDROCK: "synthetic-old-bedrock", ANTHROPIC_PROFILE: "synthetic-profile", ANTHROPIC_FEDERATION_RULE_ID: "synthetic-rule", ANTHROPIC_ORGANIZATION_ID: "synthetic-org" };
    expect(command).not.toContain("synthetic-");
    const { stdout } = await exec("/bin/sh", ["-c", command], { env, timeout: 5000 });
    const observed = stdout.split("|");
    expect(observed[runtime === "codex" ? 0 : 1]).toBe(f.home);
    expect(observed.slice(2)).toEqual(["", "", "", "", "", "", "", "", "", "", ""]);
    expect(env.OPENAI_API_KEY).toBe("synthetic-old-openai");
    expect(env.ANTHROPIC_PROFILE).toBe("synthetic-profile");
  });

  it("a later launch reads the committed selection when no staged override is given", async () => {
    const f = fixture("sh", true);
    const command = await f.launch.command("seat@rig", "codex --version", { nodeId: "node", runtime: "codex", codexCwd: f.root });
    const { stdout } = await exec("/bin/sh", ["-c", command], { env: { ...f.env, OPENAI_API_KEY: "synthetic-old-key" }, timeout: 5000 });
    expect(stdout.split("|")[0]).toBe(f.home);
    expect(stdout.split("|")[4]).toBe("");
  });

  it.each(["codex", "claude-code"])("an explicit %s clear launches the configured or native default before the old selection commits away", async runtime => {
    for (const configured of [undefined, "/accounts/configured"]) {
      const f = fixture("sh", true, configured);
      const command = await f.launch.command("seat@rig", runtime === "codex" ? "codex --version" : "claude --version", {
        nodeId: "node", runtime, accountHome: null, ...(runtime === "codex" ? { codexCwd: f.root } : {}),
      });
      const { stdout } = await exec("/bin/sh", ["-c", command], { env: { ...f.env, CODEX_HOME: f.home, CLAUDE_CONFIG_DIR: f.home }, timeout: 5000 });
      expect(stdout.split("|")[runtime === "codex" ? 0 : 1]).toBe(configured ?? "");
    }
  });

  it("refuses a pane shell that cannot enforce isolation instead of starting on another account", async () => {
    const f = fixture("fish");
    const command = await f.launch.command("seat@rig", "claude --version", { nodeId: "node", runtime: "claude-code", accountHome: f.home });
    expect(command).not.toContain("claude --version");
    await expect(exec("/bin/sh", ["-c", command], { env: f.env, timeout: 5000 })).rejects.toMatchObject({ code: 1 });
  });
});
