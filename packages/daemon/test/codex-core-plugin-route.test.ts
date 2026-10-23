import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SEAT_NODE_ENV, SEAT_PROJECT_DIR_ENV } from "../src/domain/claude-core-plugin-env.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { parse as parseToml } from "smol-toml";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Retained plugin guards/relay behavior and private-HOME launch checks. No real Codex or login.

const require = createRequire(import.meta.url);
const PLUGIN = resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const RELAY = join(PLUGIN, "hooks", "scripts", "activity-relay.cjs");
const relay = require(RELAY) as { pluginRunIsRedundant(p: Record<string, unknown>, argv: string[], env: NodeJS.ProcessEnv): boolean };
const NODE_DIR = dirname(process.execPath);

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "codex-core-route-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const realFs = {
  readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf8"),
  exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
};

function codexCommands(): Array<{ event: string; command: string }> {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", "codex.json"), "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, command: h.command }))));
}

describe("the plugin's Codex hook commands: a shell guard before any interpreter", () => {
  /** A plugin root whose scripts only say they ran, with which interpreter and arguments. */
  function stubPluginRoot(): string {
    const scripts = join(root, "plugin", "hooks", "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["activity-relay.cjs", "refocus.cjs"]) {
      writeFileSync(join(scripts, name), `process.stdout.write("RAN ${name} " + process.argv.slice(2).join(" ") + " NODE=" + process.execPath);\n`);
    }
    return join(root, "plugin");
  }
  /** Run one command the way Codex does: `${PLUGIN_ROOT}` substituted, then `<shell> -lc`. */
  function runAs(shell: string, command: string, env: Record<string, string>) {
    const noNode = join(root, "empty-bin"); mkdirSync(noNode, { recursive: true });
    const r = spawnSync(shell, ["-lc", command.split("${PLUGIN_ROOT}").join(stubPluginRoot())],
      { env: { HOME: join(root, "home"), PATH: noNode, ...env }, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const shells = ["/bin/sh", "/bin/bash"].filter((s) => existsSync(s));

  it("every one of the six entries starts with the guard and runs the explicit interpreter, never a bare node", () => {
    const commands = codexCommands();
    expect(commands).toHaveLength(6);
    for (const { command } of commands) {
      expect(command.startsWith('test -n "$OPENRIG_SEAT_PROJECT_DIR" && test -f "$OPENRIG_NODE" && test -x "$OPENRIG_NODE" || exit 0; exec "$OPENRIG_NODE" ')).toBe(true);
      expect(command).not.toMatch(/(^|[\s;])node\s/);
      expect(command).not.toContain(":-"); // no ${VAR:-…}, which fish can't parse
    }
  });

  it.each(shells)("%s: a personal session and an unselected seat are successful no-ops with no node on PATH", (shell) => {
    for (const { command } of codexCommands()) {
      for (const env of [{}, { OPENRIG_SESSION_NAME: "unselected@rig", OPENRIG_RUNTIME: "codex" }]) {
        const r = runAs(shell, command, env);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toBe("");
      }
    }
  });

  it.each(shells)("%s: a selected seat runs the script with its explicit interpreter even with no node on PATH", (shell) => {
    for (const { command } of codexCommands()) {
      const r = runAs(shell, command, { OPENRIG_SEAT_PROJECT_DIR: "/work/seat", OPENRIG_NODE: process.execPath, OPENRIG_SESSION_NAME: "s@rig" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^RAN (activity-relay|refocus)\\.cjs (--from-plugin|--runtime codex) NODE=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    }
  });

  it.each(shells)("%s: an inherited project signal without a usable interpreter is a no-op, not a failed hook", (shell) => {
    for (const { command } of codexCommands()) {
      for (const node of [undefined, join(root, "missing-node"), root]) {
        const r = runAs(shell, command, { OPENRIG_SEAT_PROJECT_DIR: "/work/seat", ...(node ? { OPENRIG_NODE: node } : {}) });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toBe("");
      }
    }
  });
});

describe("the launch signal: selected, unselected and personal", () => {
  function vendored(): { pluginsDir: string; dir: string } {
    const pluginsDir = join(root, "plugins"); const dir = join(pluginsDir, "openrig-core");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true }); writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
    return { pluginsDir, dir };
  }
  function fakeTmux(created: Array<{ env: Record<string, string> | undefined }>): TmuxAdapter {
    return {
      createSession: async (_n: string, _c?: string, env?: Record<string, string>) => { created.push({ env }); return { ok: true as const }; },
      setSessionEnv: async () => {}, unsetSessionEnv: async () => {}, killSession: async () => ({ ok: true as const }),
      listPanes: async () => [], listSessions: async () => [], listWindows: async () => [], hasSession: async () => false,
      sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
    } as unknown as TmuxAdapter;
  }

  it("only a Codex seat that selected the plugin gets the project signal and the explicit interpreter; never Claude's plugin list", async () => {
    const { pluginsDir, dir } = vendored();
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const rig = rigRepo.createRig("codex-core");
      for (const [id, runtime] of [["codex-selected", "codex"], ["codex-unselected", "codex"], ["claude-selected", "claude-code"]] as const) {
        rigRepo.addNode(rig.id, id, { runtime, cwd: `/work/${id}` });
      }
      const created: Array<{ env: Record<string, string> | undefined }> = [];
      const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: fakeTmux(created), pluginsDir });
      expect((await launcher.launchNode(rig.id, "codex-selected", { pluginPaths: [dir] })).ok).toBe(true);
      expect((await launcher.launchNode(rig.id, "codex-unselected", { pluginPaths: [] })).ok).toBe(true);
      expect((await launcher.launchNode(rig.id, "claude-selected", { pluginPaths: [dir] })).ok).toBe(true);
      expect(created[0]!.env).toMatchObject({ [SEAT_PROJECT_DIR_ENV]: "/work/codex-selected", [SEAT_NODE_ENV]: process.execPath });
      expect(created[0]!.env).not.toHaveProperty("CLAUDE_CODE_PLUGIN_DIRS");
      expect(created[1]!.env).not.toHaveProperty(SEAT_PROJECT_DIR_ENV);
      expect(created[1]!.env).not.toHaveProperty(SEAT_NODE_ENV);
      expect(created[2]!.env).toMatchObject({ [SEAT_PROJECT_DIR_ENV]: "/work/claude-selected", CLAUDE_CODE_PLUGIN_DIRS: dir });
      expect(created[2]!.env).toHaveProperty(SEAT_NODE_ENV, process.execPath);
    } finally { db.close(); }
  });
});

it("Claude's plugin activity fallback stays available without Codex config or a trust helper", () => {
  expect(relay.pluginRunIsRedundant({ hook_event_name: "Stop", cwd: root }, ["node", RELAY, "--from-plugin"], {})).toBe(false);
});

describe("Codex starts with the person's existing plugin choices", () => {
  function launchable(config = "") {
    const home = join(root, "home"), codexHome = join(root, "codex-home"), cwd = join(root, "project"), bin = join(root, "bin");
    for (const d of [home, codexHome, cwd, bin]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "codex"), `#!${process.execPath}\nif(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else if(process.argv.includes('--version'))console.log('codex-cli 0.163.0');\n`, { mode: 0o700 });
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, config);
    const cacheFile = join(codexHome, "plugins", "cache", "user-plugin");
    mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, "user installed bytes");
    const tmux = { getPaneCommand: async () => "bash", getSessionEnv: async () => undefined, sendShellCommand: async () => ({ ok: true }) };
    const adapter = new CodexRuntimeAdapter({
      tmux: tmux as unknown as TmuxAdapter, fsOps: { ...realFs, homedir: home }, codexHome, launchPath: `${bin}:${NODE_DIR}:/usr/bin:/bin`,
      activityRelayPath: RELAY, resolveGitAddDirs: async () => [], resolveManagedConfigSettings: async () => ({ enabled: true, codexVersion: "0.163.0" }),
    });
    const internals = adapter as unknown as Record<string, unknown>;
    internals.dismissSkippableCodexUpdatePrompt = async () => undefined;
    internals.captureFreshThreadId = async () => "fresh";
    internals.verifyResumeLaunch = async () => ({ ok: true });
    return { adapter, cwd, configPath, cacheFile };
  }

  it.each([
    ["fresh home", ""],
    ["explicit disable", '[plugins."openrig-core@openrig"]\nenabled = false\n'],
    ["default disable", '[plugins._default]\nenabled = false\n'],
    ["installed plugin awaiting native review", '[plugins."openrig-core@openrig"]\nenabled = true\n'],
    ["existing hook choice", '[hooks.state."user-hook"]\nenabled = false\ntrusted_hash = "original"\n'],
  ])("%s: launch preserves plugin configuration, cached files and existing hook trust", async (_label, config) => {
    const s = launchable(config);
    const before = parseToml(config);
    const binding = { nodeId: "selected", tmuxSession: "s@rig", cwd: s.cwd } as never;
    await s.adapter.ensureManagedConfig(); // boot's managed setup
    expect((await s.adapter.launchHarness(binding, { name: "s" })).ok).toBe(true);
    const after = parseToml(readFileSync(s.configPath, "utf8"));
    expect(after.plugins).toEqual(before.plugins);
    expect(after.marketplaces).toEqual(before.marketplaces);
    const states = (after.hooks as { state: Record<string, unknown> }).state;
    expect(states["user-hook"]).toEqual((before.hooks as { state?: Record<string, unknown> } | undefined)?.state?.["user-hook"]);
    // Only the existing four inline hooks gain trust; plugin hooks remain under native review.
    expect(Object.keys(states)).toHaveLength(config.includes("user-hook") ? 5 : 4);
    expect(readFileSync(s.cacheFile, "utf8")).toBe("user installed bytes");
  });
});

describe("the relay copied alone, as a Claude seat's settings relay", () => {
  it("still loads without its Codex sibling and leaves Codex activity to the inline route", () => {
    const dir = join(root, "state", "claude-activity-hooks"); mkdirSync(dir, { recursive: true });
    const copy = join(dir, "activity-relay.cjs");
    writeFileSync(copy, readFileSync(RELAY));
    const r = spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(copy)}); process.stdout.write(String(m.pluginRunIsRedundant({ hook_event_name: "Stop" }, ["node", "x", "--from-plugin"], { OPENRIG_RUNTIME: "codex", CODEX_HOME: ${JSON.stringify(root)} })))`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("true");
  });
});
