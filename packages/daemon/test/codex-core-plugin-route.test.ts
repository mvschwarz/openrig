import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SEAT_NODE_ENV, SEAT_PROJECT_DIR_ENV } from "../src/domain/claude-core-plugin-env.js";
import { CodexRuntimeAdapter, computeCodexHookTrust, type CodexCliRunner } from "../src/adapters/codex-runtime-adapter.js";
import { codexCorePluginEnablement, type CodexConfigLayerRead } from "../src/domain/codex-core-plugin-install.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Codex seats get the openrig-core plugin through Codex's own install. Its hooks act only in a seat that selected the plugin,
// a person's explicit or default disable is never overridden, and the plugin's relay stays quiet only when Codex would run the
// daemon's managed relay for the same event. Hermetic: temp HOME and CODEX_HOME, a fake `codex` CLI, no real Codex or login.

const require = createRequire(import.meta.url);
const PLUGIN = resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const RELAY = join(PLUGIN, "hooks", "scripts", "activity-relay.cjs");
const relay = require(RELAY) as { pluginRunIsRedundant(p: Record<string, unknown>, argv: string[], env: NodeJS.ProcessEnv): boolean };
const managed = require(join(PLUGIN, "hooks", "scripts", "codex-hook-trust.cjs")) as {
  computeCodexHookTrust(event: string, input: { keySource: string; command: string; timeoutSec: number }): { key: string; hash: string };
};
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

describe("read before install: the person's choice is never overridden", () => {
  const layer = (name: string, content: string | null): CodexConfigLayerRead => content === null
    ? { name, path: `/${name}`, state: "absent" } : { name, path: `/${name}`, state: "read", content };
  const KEY = '[plugins."openrig-core@openrig"]';

  it("decides from the readable layers: explicit values, the _default policy, and unreadable or unparsable layers", () => {
    const decide = (system: string | null, user: string | null, managedCfg: string | null = null) =>
      codexCorePluginEnablement([layer("system config", system), layer("user config", user), layer("legacy managed config", managedCfg)]).decision;
    expect(decide(null, null)).toBe("allow"); // absent
    expect(decide(null, `${KEY}\nenabled = true\n`)).toBe("allow"); // explicit true
    expect(decide(null, `${KEY}\nenabled = false\n`)).toBe("disabled"); // explicit false
    expect(decide(null, "[plugins._default]\nenabled = false\n")).toBe("disabled"); // default off, no entry
    expect(decide(null, `[plugins._default]\nenabled = false\n\n${KEY}\n`)).toBe("disabled"); // default off, entry without enabled
    expect(decide(null, `[plugins._default]\nenabled = false\n\n${KEY}\nenabled = true\n`)).toBe("allow"); // the person's explicit choice
    expect(decide(null, "[plugins._default]\nenabled = true\n")).toBe("allow"); // default on
    expect(decide("[plugins._default]\nenabled = false\n", null)).toBe("disabled"); // a layer above the user file
    expect(decide(null, `${KEY}\nenabled = true\n`, `${KEY}\nenabled = false\n`)).toBe("disabled"); // the higher layer's explicit value wins
    // _default follows Codex's merge: a higher-precedence layer's value wins (system 10 < user 20 < legacy managed 40).
    expect(decide("[plugins._default]\nenabled = false\n", "[plugins._default]\nenabled = true\n")).toBe("allow");
    expect(decide("[plugins._default]\nenabled = true\n", "[plugins._default]\nenabled = false\n")).toBe("disabled");
    expect(decide(null, "[plugins._default]\nenabled = true\n", "[plugins._default]\nenabled = false\n")).toBe("disabled");
    expect(decide(null, "[plugins._default]\nenabled = false\n", "[plugins._default]\nenabled = true\n")).toBe("allow");
    expect(decide(null, "this is = = not toml")).toBe("unknown");
    expect(decide(null, `${KEY}\nenabled = "yes"\n`)).toBe("unknown");
    expect(codexCorePluginEnablement([{ name: "user config", path: "/u", state: "unreadable", reason: "EACCES" }]).decision).toBe("unknown");
  });

  /** A vendored plugin at `version`, a CODEX_HOME with `userConfig`, an /etc/codex stand-in, and a recording fake CLI. */
  function setup(version: string, userConfig: string | null, opts: { installed?: string; systemConfig?: string } = {}) {
    const pluginsDir = join(root, "plugins"); const dir = join(pluginsDir, "openrig-core");
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "openrig-core", version }));
    const codexHome = join(root, "codex-home"); mkdirSync(codexHome, { recursive: true });
    if (userConfig !== null) writeFileSync(join(codexHome, "config.toml"), userConfig);
    if (opts.installed) mkdirSync(join(codexHome, "plugins", "cache", "openrig", "openrig-core", opts.installed), { recursive: true });
    const etc = join(root, "etc-codex"); mkdirSync(etc, { recursive: true });
    if (opts.systemConfig) writeFileSync(join(etc, "config.toml"), opts.systemConfig);
    const calls: string[][] = [];
    const runCodexCli: CodexCliRunner = async (args, env) => { calls.push([...args, `CODEX_HOME=${env.CODEX_HOME}`]); return { status: 0, stdout: "", stderr: "" }; };
    const adapter = new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps: realFs, codexHome, resolveCorePluginDir: () => dir, runCodexCli, codexSystemConfigDir: etc });
    return { adapter, calls, pluginsDir, codexHome };
  }
  const recorded = (pluginsDir: string) => `[marketplaces.openrig]\nsource_type = "local"\nsource = "${pluginsDir}"\n`;

  it("first install: absent runs Codex's own marketplace add and plugin add, with the daemon's CODEX_HOME", async () => {
    const { adapter, calls, pluginsDir, codexHome } = setup("0.1.14", null);
    expect((await adapter.ensureCodexCorePlugin()).outcome).toBe("installed");
    expect(calls).toEqual([["plugin", "marketplace", "add", pluginsDir, `CODEX_HOME=${codexHome}`], ["plugin", "add", "openrig-core@openrig", `CODEX_HOME=${codexHome}`]]);
    expect(JSON.parse(readFileSync(join(pluginsDir, ".agents", "plugins", "marketplace.json"), "utf8"))).toEqual({
      name: "openrig", interface: { displayName: "OpenRig" }, plugins: [{ name: "openrig-core", source: "./openrig-core" }] });
    expect(existsSync(join(codexHome, "config.toml"))).toBe(false); // OpenRig writes nothing into the config itself
  });

  it("first install: explicit false, default-off and unreadable never call Codex", async () => {
    for (const config of ['[plugins."openrig-core@openrig"]\nenabled = false\n', "[plugins._default]\nenabled = false\n", "not = = toml"]) {
      const { adapter, calls, codexHome } = setup("0.1.14", config);
      expect((await adapter.ensureCodexCorePlugin()).outcome).toBe("skipped");
      expect(calls).toEqual([]);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
      rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    }
    const { adapter, calls } = setup("0.1.14", null, { systemConfig: "[plugins._default]\nenabled = false\n" });
    expect((await adapter.ensureCodexCorePlugin()).outcome).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("version change: enabled reinstalls with plugin add only; explicit false or default-off keeps the old version untouched", async () => {
    let s = setup("0.1.14", null, { installed: "0.1.13" });
    writeFileSync(join(s.codexHome, "config.toml"), `${recorded(s.pluginsDir)}\n[plugins."openrig-core@openrig"]\nenabled = true\n`);
    expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("installed");
    expect(s.calls.map((c) => c.slice(0, -1))).toEqual([["plugin", "add", "openrig-core@openrig"]]);
    for (const off of ['[plugins."openrig-core@openrig"]\nenabled = false\n', '[plugins._default]\nenabled = false\n\n[plugins."openrig-core@openrig"]\n']) {
      rmSync(root, { recursive: true, force: true }); mkdirSync(root);
      s = setup("0.1.14", null, { installed: "0.1.13" });
      writeFileSync(join(s.codexHome, "config.toml"), `${recorded(s.pluginsDir)}\n${off}`);
      expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("skipped");
      expect(s.calls).toEqual([]);
    }
  });

  it("a cache left behind isn't current: Codex loads only a configured plugin, so a lost registration is restored", async () => {
    // The plugin entry is gone, the marketplace remains: plugin add only.
    let s = setup("0.1.15", null, { installed: "0.1.15" });
    writeFileSync(join(s.codexHome, "config.toml"), recorded(s.pluginsDir));
    expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("installed");
    expect(s.calls.map((c) => c.slice(0, -1))).toEqual([["plugin", "add", "openrig-core@openrig"]]);
    // The marketplace is gone, the entry remains: marketplace add, then plugin add.
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    s = setup("0.1.15", '[plugins."openrig-core@openrig"]\nenabled = true\n', { installed: "0.1.15" });
    expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("installed");
    expect(s.calls.map((c) => c.slice(0, 3))).toEqual([["plugin", "marketplace", "add"], ["plugin", "add", "openrig-core@openrig"]]);
    // A person's disable still wins over a cache left behind.
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    s = setup("0.1.15", "[plugins._default]\nenabled = false\n", { installed: "0.1.15" });
    expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("skipped");
    expect(s.calls).toEqual([]);
  });

  it("a marketplace recorded through a symlink to the plugins folder is the same source", async () => {
    const s = setup("0.1.15", null, { installed: "0.1.14" });
    const alias = join(root, "plugins-alias"); fs.symlinkSync(s.pluginsDir, alias);
    writeFileSync(join(s.codexHome, "config.toml"), `${recorded(alias)}\n[plugins."openrig-core@openrig"]\nenabled = true\n`);
    expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("installed");
    expect(s.calls.map((c) => c.slice(0, -1))).toEqual([["plugin", "add", "openrig-core@openrig"]]);
  });

  it("a codex that can't be started is reported with the reason, not as an exit status", async () => {
    const pluginsDir = join(root, "plugins"); const dir = join(pluginsDir, "openrig-core");
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "openrig-core", version: "0.1.15" }));
    const codexHome = join(root, "codex-home"); mkdirSync(codexHome, { recursive: true });
    const noCodex = join(root, "no-codex-bin"); mkdirSync(noCodex, { recursive: true });
    const adapter = new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps: realFs, codexHome, launchPath: noCodex,
      resolveCorePluginDir: () => dir, codexSystemConfigDir: join(root, "etc") });
    const result = await adapter.ensureCodexCorePlugin();
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/codex plugin marketplace add failed: .*ENOENT/);
  });

  it("the current version is left alone, and another marketplace named openrig is never replaced", async () => {
    let s = setup("0.1.14", null, { installed: "0.1.14" });
    writeFileSync(join(s.codexHome, "config.toml"), `${recorded(s.pluginsDir)}\n[plugins."openrig-core@openrig"]\nenabled = true\n`);
    expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("current");
    expect(s.calls).toEqual([]);
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    s = setup("0.1.14", '[marketplaces.openrig]\nsource_type = "git"\nsource = "https://example.invalid/other.git"\n');
    expect((await s.adapter.ensureCodexCorePlugin()).outcome).toBe("skipped");
    expect(s.calls).toEqual([]);
  });
});

describe("the plugin relay on Codex always reports: whether the managed relay runs can't be established", () => {
  /** A CODEX_HOME whose config the daemon itself provisioned: the managed relay block and its trust. */
  function provisioned(): string {
    const codexHome = join(root, "codex-home"); mkdirSync(codexHome, { recursive: true });
    new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps: realFs, codexHome, activityRelayPath: RELAY }).ensureCodexActivityHooks();
    return codexHome;
  }
  const env = (codexHome: string, path = NODE_DIR): NodeJS.ProcessEnv => ({ OPENRIG_RUNTIME: "codex", CODEX_HOME: codexHome, PATH: path });
  const quiet = (event: string, e: NodeJS.ProcessEnv) => relay.pluginRunIsRedundant({ hook_event_name: event }, ["node", RELAY, "--from-plugin"], e);
  const config = (codexHome: string) => join(codexHome, "config.toml");
  const trustKey = (codexHome: string, event: string) => managed.computeCodexHookTrust(event, {
    keySource: fs.realpathSync.native(config(codexHome)), command: `node "${RELAY}"`, timeoutSec: 5 }).key;
  const edit = (codexHome: string, fn: (s: string) => string) => writeFileSync(config(codexHome), fn(readFileSync(config(codexHome), "utf8")));

  it("reports each managed event even with the managed relay trusted in the user file (the stated duplicate)", () => {
    // Codex merges hook state from every user layer (a selected profile included) and session flags, which the relay can't
    // see, so it never assumes the managed handler ran. With both routes active each event is reported twice, never zero.
    const home = provisioned();
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"]) expect(quiet(event, env(home))).toBe(false);
    // The daemon's trust writer and the plugin share one hash recipe.
    expect(computeCodexHookTrust("Stop", { keySource: "/k/config.toml", command: `node "${RELAY}"`, timeoutSec: 5 }))
      .toEqual(managed.computeCodexHookTrust("Stop", { keySource: "/k/config.toml", command: `node "${RELAY}"`, timeoutSec: 5 }));
  });

  it("an edited managed stanza or a disable in another user layer leaves the plugin reporting (never zero)", () => {
    // The stanza edited after it was trusted, the original hash kept: Codex sees Modified and skips it.
    for (const extra of ['statusMessage = "activity"\n', "async = true\n"]) {
      rmSync(root, { recursive: true, force: true }); mkdirSync(root);
      const home = provisioned();
      edit(home, (s) => s.replace(/(\[\[hooks\.Stop\.hooks\]\]\ntype = "command"\ncommand = '[^']+'\ntimeout = 5\n)/, `$1${extra}`));
      expect(quiet("Stop", env(home))).toBe(false);
    }
    // A selected profile layer disables the managed key while the user file still trusts it.
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    const home = provisioned();
    edit(home, (s) => `profile = "work"\n\n${s}`);
    writeFileSync(join(home, "work.config.toml"), `[hooks.state.${JSON.stringify(trustKey(home, "Stop"))}]\nenabled = false\n`);
    expect(quiet("Stop", env(home))).toBe(false);
  });

  it("a home with no managed block (the plugin alone) reports", () => {
    const home = provisioned();
    writeFileSync(config(home), "[features]\nhooks = true\n");
    expect(quiet("Stop", env(home))).toBe(false);
  });

  it("the Claude path is unchanged: without OPENRIG_RUNTIME=codex the Codex config is never consulted", () => {
    const home = provisioned();
    expect(relay.pluginRunIsRedundant({ hook_event_name: "Stop", cwd: root }, ["node", RELAY, "--from-plugin"], { CODEX_HOME: home, PATH: NODE_DIR })).toBe(false);
    // Root reads a mode-000 file anyway, so the unreadable case can't be made there.
    if (process.getuid?.() !== 0) {
      chmodSync(config(home), 0o000);
      try { expect(quiet("Stop", env(home))).toBe(false); } // unreadable: reports
      finally { chmodSync(config(home), 0o600); }
    }
  });
});

describe("the install runs only for a seat that selected the plugin", () => {
  /** A Codex adapter that can run a real launchHarness against fixtures, with a vendored plugin and a recording CLI. */
  function launchable(selected: (nodeId: string) => boolean) {
    const home = join(root, "home"), codexHome = join(root, "codex-home"), cwd = join(root, "project"), bin = join(root, "bin");
    for (const d of [home, codexHome, cwd, bin]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "codex"), `#!${process.execPath}\nif(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else if(process.argv.includes('--version'))console.log('codex-cli 0.163.0');\n`, { mode: 0o700 });
    const dir = join(root, "plugins", "openrig-core");
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "openrig-core", version: "9.9.9" }));
    const calls: string[][] = [];
    const tmux = { getPaneCommand: async () => "bash", getSessionEnv: async () => undefined, sendShellCommand: async () => ({ ok: true }) };
    const adapter = new CodexRuntimeAdapter({
      tmux: tmux as unknown as TmuxAdapter, fsOps: { ...realFs, homedir: home }, codexHome, launchPath: `${bin}:${NODE_DIR}:/usr/bin:/bin`,
      activityRelayPath: RELAY, resolveGitAddDirs: async () => [], resolveManagedConfigSettings: async () => ({ enabled: true, codexVersion: "0.163.0" }),
      resolveCorePluginDir: () => dir, codexSystemConfigDir: join(root, "etc"),
      runCodexCli: async (args) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; },
      resolveCorePluginSelected: selected,
    } as ConstructorParameters<typeof CodexRuntimeAdapter>[0]);
    const internals = adapter as unknown as Record<string, unknown>;
    internals.dismissSkippableCodexUpdatePrompt = async () => undefined;
    internals.captureFreshThreadId = async () => "fresh";
    internals.verifyResumeLaunch = async () => ({ ok: true });
    return { adapter, calls, cwd };
  }

  it("an unselected Codex seat's launch makes no Codex CLI call; a selected one installs", async () => {
    let s = launchable((id) => id === "selected");
    expect((await s.adapter.launchHarness({ nodeId: "unselected", tmuxSession: "u@rig", cwd: s.cwd } as never, { name: "u" })).ok).toBe(true);
    expect(s.calls).toEqual([]);
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    s = launchable((id) => id === "selected");
    expect((await s.adapter.launchHarness({ nodeId: "selected", tmuxSession: "s@rig", cwd: s.cwd } as never, { name: "s" })).ok).toBe(true);
    expect(s.calls.map((c) => c.slice(0, 2))).toEqual([["plugin", "marketplace"], ["plugin", "add"]]);
  });

  it("concurrent launches run the Codex config setup and the install one after the other", async () => {
    const s = launchable(() => true);
    const events: string[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const internals = s.adapter as unknown as Record<string, unknown>;
    internals.resolveManagedConfigSettings = async () => { events.push("config"); await wait(20); return { enabled: true, codexVersion: "0.163.0" }; };
    internals.runCodexCli = async (args: string[]) => { events.push(`cli:${args[1]}:start`); await wait(30); events.push(`cli:${args[1]}:end`); return { status: 0, stdout: "", stderr: "" }; };
    const launch = (id: string) => s.adapter.launchHarness({ nodeId: id, tmuxSession: `${id}@rig`, cwd: s.cwd } as never, { name: id });
    const results = await Promise.all([launch("a"), launch("b")]);
    expect(results.every((r) => r.ok)).toBe(true);
    const section = ["config", "cli:marketplace:start", "cli:marketplace:end", "cli:add:start", "cli:add:end"];
    expect(events).toEqual([...section, ...section]);
  });

  it("a resume never installs: neither a resume launch nor preparing an in-place resume command", async () => {
    let s = launchable(() => true);
    expect((await s.adapter.launchHarness({ nodeId: "selected", tmuxSession: "s@rig", cwd: s.cwd } as never, { name: "s", resumeToken: "conv-1" })).ok).toBe(true);
    expect(s.calls).toEqual([]);
    rmSync(root, { recursive: true, force: true }); mkdirSync(root);
    s = launchable(() => true);
    expect((await s.adapter.buildResumeCommand({ nodeId: "selected", tmuxSession: "s@rig", cwd: s.cwd } as never, { name: "s", resumeToken: "conv-1" })).ok).toBe(true);
    expect(s.calls).toEqual([]);
  });

  it("ensureManagedConfig alone (boot, resume) never installs", async () => {
    const s = launchable(() => true);
    await s.adapter.ensureManagedConfig();
    expect(s.calls).toEqual([]);
  });
});

describe("the relay copied alone, as a Claude seat's settings relay", () => {
  it("still loads and runs without its Codex sibling, and a Codex session without the sibling reports", () => {
    const dir = join(root, "state", "claude-activity-hooks"); mkdirSync(dir, { recursive: true });
    const copy = join(dir, "activity-relay.cjs");
    writeFileSync(copy, readFileSync(RELAY));
    const r = spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(copy)}); process.stdout.write(String(m.pluginRunIsRedundant({ hook_event_name: "Stop" }, ["node", "x", "--from-plugin"], { OPENRIG_RUNTIME: "codex", CODEX_HOME: ${JSON.stringify(root)} })))`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("false");
  });
});
