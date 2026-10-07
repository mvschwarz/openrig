import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const asset = fileURLToPath(new URL("../assets/claude-team-permissions.cjs", import.meta.url));
const { decide } = createRequire(import.meta.url)(asset);
const policy = { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK };
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});

describe("Claude team command permissions", () => {
  for (const rule of TEAM_CLAUDE_ASK) {
    const command = rule.slice(5, -3);
    it(`${command}: real action asks, help does not`, () => {
      expect(decide(`${command} example`, policy)).toBe("ask");
      for (const flag of ["--help", "-h"]) {
        expect(decide(`${command} ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} example ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} ${flag} example`, policy)).toBe("allow");
      }
    });
  }
  it.each([
    "rig whoami --json", "rig status # note", "rig queue claim example", "rig queue unclaim example",
    "rig queue handoff example --to worker@team", "rig help down",
    "/opt/tools/rig status", "'/opt/my tools/rig' queue list", '"/opt/my tools/rig" down --help',
    "r\\ig down -h", "env OPENRIG_PORT=7434 /opt/tools/rig status", "A=value rig status",
    "command -- /opt/tools/rig status", "/usr/bin/env -- command rig down --help",
    "exec /opt/tools/rig status", "rig --host remote down --help", "rig --host=remote down -h",
    "npm test", "/opt/tools/npm test", "'/project/node_modules/.bin/vitest' run test/unit.test.ts",
    "/private/tmp/project/node_modules/.bin/jest test/unit.test.ts", "python3 -m pytest",
    "rig send worker 'literal rig down text'", "rig send worker 'multiline\nrig down example'",
  ])("allows existing allowance spelling: %s", command => expect(decide(command, policy)).toBe("allow"));

  it.each([
    "/opt/tools/rig down example", "'/opt/my tools/rig' down example", "command rig down example",
    "env A=x rig up example", "rig --host remote down example", "rig --host=remote down example",
    "rig down -- --help", "rig down --cwd --help", 'rig down "$TEAM"', "rig down $(echo --help)",
    "rig down example && rig down --help", "rig status; /opt/tools/rig down example", "rig down example | cat",
    'echo "$(rig down example)"', "echo `rig up example`", "cat <<EOF\n$(rig down example)\nEOF",
    'git commit -m "multiline\nquoted" <<EOF\n$(rig down example)\nEOF',
    "timeout 30 rig down example", "time rig down example", "nice -n 5 rig down example",
    "nohup rig down example", "stdbuf -oL rig down example", "noglob rig down example",
    "xargs rig down", "if true; then rig down example; fi",
    "for s in example; do rig down $s; done", "{ rig down example; }", "! rig down example",
    "rig -- down example", "rig seat -- stop example@demo --reason maintenance",
    "rig -- down --help", "rig -- down -h", "rig -- down --help example", "rig seat -- stop --help example@demo",
    "ls # <<pwd\nrig down example\npwd", "ls # ' <<pwd\nrig down example\npwd",
    "echo $((1 <<value))\nrig down example\nvalue", "((1 <<value))\nrig down example\nvalue",
    "echo $((\n1 <<value))\nrig down example\nvalue",
    "PATH=/inert rig down example", "NODE_OPTIONS=--no-warnings rig down example", "./rig down example",
    "ls `pwd # x`; rig down example", "ls `pwd # x` && rig down example",
    "ls ${x:-a #b}; rig down example", "echo safe # $(rig down example)",
  ])("retains lifecycle confirmation: %s", command => expect(decide(command, policy)).toBe("ask"));

  it.each([
    "echo 'rig down example'", 'echo "rig down example"', "cat <<'EOF'\nrig down example\nEOF",
    'git commit -m "multi\nline" <<\'EOF\'\n$(rig down example)\nEOF',
    "rig status | python3 -c 'print(1)'", "rig status > result.txt", "rig status && npm test",
    "rig send worker $(cat message.txt)", 'rig send worker "$MESSAGE"',
    "sudo rig status", "env -i rig status", "command -v rig", "node arbitrary.js", "npm install",
    "'/opt/tools/rig down' example", "'A=value' rig status", "not-rig down example", "", "'unterminated",
    "PATH=/inert rig status", "LD_PRELOAD=/inert rig status", "DYLD_INSERT_LIBRARIES=/inert rig status",
    "env NODE_OPTIONS=--no-warnings rig status", "BASH_ENV=/inert rig status", "ENV=/inert rig status", "./rig status",
    "cat <<'EOF' # <<OTHER\nrig down example\nEOF\nOTHER",
  ])("leaves unrelated/data/complex forms to native checks: %s", command => expect(decide(command, policy)).toBeUndefined());

  it("falls back to native lifecycle asks when the launch asset is absent", () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true });
    expect(JSON.parse(args[1])).toEqual({ permissions: { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK } });
    expect(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, permissionMode: "plan" })).toEqual([]);
  });

  it("executes the launch-provided hook via stdin without changing its input or settings", () => {
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true });
    const settings = JSON.parse(args[1]);
    expect(settings.permissions).toEqual({ allow: TEAM_CLAUDE_ALLOW });
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 5 });
    for (const [command, expected] of [["rig down --help", "allow"], ["/opt/tools/rig down example", "ask"]]) {
      const result = spawnSync("/bin/sh", ["-c", hook.command], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, permission_mode: "acceptEdits" }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: expected,
      } });
      expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toBeUndefined();
    }
    for (const input of ["invalid", JSON.stringify({ tool_name: "Read" }), JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install" } })]) {
      const result = spawnSync("/bin/sh", ["-c", hook.command], { input, encoding: "utf8" });
      expect(result.status).toBe(0); expect(result.stdout).toBe("");
    }
  });

  it("is self-contained under an install path with spaces and quotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hook 'path "));
    try {
      const copy = join(dir, "hook.cjs"); copyFileSync(asset, copy);
      const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
      const result = spawnSync("/bin/sh", ["-c", [process.execPath, copy, encoded].map(shellQuote).join(" ")], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rig down --help" } }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(readFileSync(copy)).toEqual(readFileSync(asset));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
