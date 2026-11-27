// Slice 15: the openrig plugin's MCP server in Claude Code starts through the plugin's launcher, scripts/run-rig.cjs, which
// runs the `rig` the plugin's hooks run (the bridge's sessionRig: OPENRIG_RIG_BIN, `rig` on PATH, the project's own
// node_modules/.bin/rig, then a login shell's PATH) with the server's arguments. An OpenRig installed only inside the project
// then still serves, and with no `rig` at all the launcher prints one stderr line saying why, which Claude Code logs as the
// server's stderr.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const plugin = fileURLToPath(new URL("../assets/plugins/openrig", import.meta.url));
const launcher = join(plugin, "scripts", "run-rig.cjs");
const SERVER_ARGS = ["mcp", "serve", "--front-door"];

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "openrig-plugin-mcp-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const script = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
  return file;
};
/** The launcher as Claude Code starts the server: node, the launcher, rig's arguments, the MCP pipe on stdio. */
const serve = (env: Record<string, string>, input = "") =>
  spawnSync(process.execPath, [launcher, ...SERVER_ARGS], { input, encoding: "utf8", env, timeout: 15_000 });
/** A login shell for $SHELL whose PATH is `path`: it prints it after the bridge's mark, as a profile that prints first would,
 *  and records the flags it was started with. */
const loginShell = (path: string) => {
  const log = join(root, "shell-calls.log");
  return { log, shell: script(join(root, "shell", "zsh"), `echo "$1" >> '${log}'\necho 'a profile line'\nprintf '%s%s' '__OPENRIG_LOGIN_PATH__' '${path}'\n`) };
};

describe("the openrig plugin's MCP server in Claude Code", () => {
  it("is declared through the plugin's launcher, run with node, with rig's own arguments and the seat", () => {
    const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.mcpServers).toEqual({ openrig: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/scripts/run-rig.cjs", ...SERVER_ARGS],
      env: { OPENRIG_SESSION_NAME: "${user_config.seat}" },
    } });
    expect(existsSync(launcher)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("runs a `rig` installed only in the project with the same arguments on the same stdio, and passes its exit status back", () => {
    const project = join(root, "project");
    script(join(project, "node_modules", ".bin", "rig"), 'echo "args: $*"\necho "project: $CLAUDE_PROJECT_DIR"\n/bin/cat\nexit 3\n');
    const run = serve({ PATH: join(root, "no-bin"), CLAUDE_PROJECT_DIR: project }, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`args: mcp serve --front-door\nproject: ${project}\n{"jsonrpc":"2.0","id":1,"method":"initialize"}\n`);
    expect(run.status).toBe(3);
  });

  it.skipIf(process.platform === "win32")("runs OPENRIG_RIG_BIN's rig when it names one", () => {
    const chosen = script(join(root, "custom", "rig-dev"), 'echo "chosen: $*"\n');
    script(join(root, "project", "node_modules", ".bin", "rig"), 'echo "project"\n');
    const run = serve({ PATH: join(root, "no-bin"), CLAUDE_PROJECT_DIR: join(root, "project"), OPENRIG_RIG_BIN: chosen });
    expect(run.stdout).toBe("chosen: mcp serve --front-door\n");
    expect(run.status).toBe(0);
  });

  // Claude Desktop's Code tab, or an app started before `rig` was installed: its PATH, which the server inherits, lacks the
  // folder a login profile puts on PATH. The hooks already looked there (#4032); the server now finds the same `rig`.
  it.skipIf(process.platform === "win32")("runs a `rig` only on a login shell's PATH with that PATH, the same arguments and stdio, and passes its exit status back", () => {
    const loginBin = join(root, "login-bin");
    const loginPath = [loginBin, "/usr/bin", "/bin"].join(":");
    script(join(loginBin, "rig"), 'echo "args: $*"\necho "path: $PATH"\n/bin/cat\nexit 4\n');
    const { shell, log } = loginShell(loginPath);
    const run = serve({ PATH: join(root, "no-bin"), CLAUDE_PROJECT_DIR: join(root, "project"), SHELL: shell },
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`args: mcp serve --front-door\npath: ${loginPath}\n{"jsonrpc":"2.0","id":1,"method":"initialize"}\n`);
    expect(run.status).toBe(4);
    expect(readFileSync(log, "utf8")).toBe("-lc\n");
  });

  it.skipIf(process.platform === "win32")("with no `rig` anywhere, a login shell's PATH included, prints one stderr line naming the cause and how to fix it, and exits 1", () => {
    const { shell, log } = loginShell(["/usr/bin", "/bin"].join(":"));
    const run = serve({ PATH: join(root, "no-bin"), CLAUDE_PROJECT_DIR: join(root, "project"), SHELL: shell });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    const lines = run.stderr.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^openrig plugin: OpenRig's MCP server can't start: no `rig` found/);
    expect(lines[0]).toContain("npm install -g @openrig/cli");
    expect(lines[0]).toContain("login profile (~/.zprofile for zsh, ~/.bash_profile or ~/.profile for bash)");
    expect(lines[0]).toContain("OPENRIG_RIG_BIN");
    expect(readFileSync(log, "utf8")).toBe("-lc\n");
  });

  it("a `rig` it finds but can't start is one line too", () => {
    const { launch } = createRequire(import.meta.url)(launcher) as {
      launch(args: string[], deps: { env: Record<string, string>; spawnSync: () => unknown; stderr: { write(s: string): unknown } }): number;
    };
    const chosen = script(join(root, "rig"), "");
    let err = "";
    const code = launch(SERVER_ARGS, { env: { OPENRIG_RIG_BIN: chosen }, stderr: { write: (s: string) => { err += s; } },
      spawnSync: () => ({ error: Object.assign(new Error(`spawn ${chosen} EACCES`), { code: "EACCES" }), status: null }) });
    expect(code).toBe(1);
    expect(err).toBe(`openrig plugin: OpenRig's MCP server can't start: ${chosen} couldn't be run (EACCES).\n`);
  });
});
