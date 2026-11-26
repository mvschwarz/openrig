// #3385: an openrig-core upgrade waits while a Codex seat runs in that Codex home. Codex 0.169.0 checks a plugin hook
// against the approvals its session started with, and a running session points its hooks at a newly installed version,
// so `codex plugin add` under it turns its refocus and compaction hooks off until it restarts.
// Model-free. Codex's own commands are a recorder that installs as Codex 0.171.0 was seen to (the new version's folder
// in, the older one out); tmux and the process table are fixtures. The daemon test boots a daemon with a stand-in
// `codex` on PATH and a real process standing in for a running seat.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parse } from "smol-toml";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { listNativeProcessesOrThrow, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const SHIPPED = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const RELAY = path.join(SHIPPED, "hooks/scripts/activity-relay.cjs");
const VERSION = (JSON.parse(fs.readFileSync(path.join(SHIPPED, ".codex-plugin/plugin.json"), "utf8")) as { version: string }).version;
const OLDER = "0.0.1";

const roots: string[] = [];
const processes: ChildProcess[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const cacheRoot = (home: string) => path.join(home, "plugins/cache/openrig/openrig-core");
const cached = (home: string) => (fs.existsSync(cacheRoot(home)) ? fs.readdirSync(cacheRoot(home)).sort() : []);

/** A Codex home where an earlier daemon installed and registered openrig-core `version`. */
function installed(home: string, pluginsDir: string, version = OLDER): void {
  fs.mkdirSync(path.join(cacheRoot(home), version), { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"),
    `[marketplaces.openrig]\nsource = ${JSON.stringify(pluginsDir)}\n\n[plugins."openrig-core@openrig"]\nenabled = true\n`);
}

/** A seat OpenRig records: unbound (session null), or bound to a tmux session whose pane runs Codex or is back at its
 *  shell. `home: "own"` gives it its own CODEX_HOME. */
interface Seat { nodeId: string; session: string | null; pane?: "codex" | "shell"; home?: "own"; selected?: boolean }

interface WorldOptions {
  seats?: Seat[];
  /** false: openrig-core was never installed in the daemon's Codex home. */
  installed?: boolean;
  probe?: (session: string) => Awaited<ReturnType<TmuxAdapter["probeSession"]>> | "throws" | undefined;
  panePid?: (session: string) => number | null;
  processTable?: "throws";
  seatRecords?: "throws";
}

function world(options: WorldOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-wait-")); roots.push(root);
  const pluginsDir = path.join(root, "plugins"), plugin = path.join(pluginsDir, "openrig-core");
  const daemonHome = path.join(root, "codex"), ownHome = path.join(root, "own-codex"), project = path.join(root, "project");
  fs.cpSync(SHIPPED, plugin, { recursive: true });
  for (const dir of [daemonHome, ownHome, project]) fs.mkdirSync(dir, { recursive: true });
  if (options.installed === false) fs.writeFileSync(path.join(daemonHome, "config.toml"), "");
  else installed(daemonHome, pluginsDir);
  installed(ownHome, pluginsDir);
  const seats = options.seats ?? [];
  // Each bound seat's pane is a shell (pid 1000, 1010, …); a running seat's has a Codex below it.
  const rows: NativeProcessRow[] = [];
  const panePids = new Map<string, number>();
  seats.forEach((seat, index) => {
    if (!seat.session) return;
    const pid = 1000 + 10 * index;
    panePids.set(seat.session, pid);
    rows.push({ pid, ppid: 1, command: "-bash", executableName: "bash" });
    if (seat.pane === "codex") rows.push({ pid: pid + 1, ppid: pid, command: `/usr/local/bin/codex resume conv-${index}`, executableName: "codex" });
  });
  const calls: Array<{ args: string[]; home: string | undefined }> = [];
  const tmux = {
    probeSession: async (session: string) => {
      const probed = options.probe?.(session);
      if (probed === "throws") throw new Error("tmux: permission denied");
      return probed ?? { state: "present" as const };
    },
    getPanePid: async (session: string) => (options.panePid ? options.panePid(session) : panePids.get(session) ?? null),
    getPaneCommand: async () => "bash",
    getSessionEnv: async () => undefined,
    sendShellCommand: vi.fn(async () => ({ ok: true })),
  };
  const fsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
    exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); }, homedir: root,
  };
  const adapter = new CodexRuntimeAdapter({
    tmux: tmux as unknown as TmuxAdapter, fsOps, codexHome: daemonHome, launchPath: process.env.PATH, activityRelayPath: RELAY,
    seatHome: (nodeId: string) => (seats.find((seat) => seat.nodeId === nodeId)?.home === "own" ? ownHome : undefined),
    resolveGitAddDirs: async () => [], codexSystemConfigDir: path.join(root, "etc"),
    resolveManagedConfigSettings: async () => ({ enabled: true, codexVersion: "0.169.0" }), resolveHooksEnabled: async () => true,
    resolveCorePluginDir: () => plugin,
    resolveCorePluginSelected: (nodeId: string) => seats.find((seat) => seat.nodeId === nodeId)?.selected ?? false,
    listCodexSeats: () => {
      if (options.seatRecords === "throws") throw new Error("database is closed");
      return seats.map((seat) => ({ nodeId: seat.nodeId, tmuxSession: seat.session }));
    },
    listProcesses: () => { if (options.processTable === "throws") throw new Error("ps: cannot read the process table"); return rows; },
    // Codex's install as seen on 0.171.0: the new version's folder replaces the older one, and the entry is registered.
    runCodexCli: async (args, env) => {
      calls.push({ args, home: env.CODEX_HOME });
      const home = env.CODEX_HOME!;
      const config = path.join(home, "config.toml");
      if (args[1] === "marketplace") fs.appendFileSync(config, `\n[marketplaces.openrig]\nsource = ${JSON.stringify(pluginsDir)}\n`);
      if (args[1] === "add") {
        fs.rmSync(cacheRoot(home), { recursive: true, force: true });
        fs.cpSync(plugin, path.join(cacheRoot(home), VERSION), { recursive: true });
        if (!(parse(fs.readFileSync(config, "utf8")) as { plugins?: Record<string, unknown> }).plugins?.["openrig-core@openrig"]) {
          fs.appendFileSync(config, '\n[plugins."openrig-core@openrig"]\nenabled = true\n');
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  const internals = adapter as unknown as Record<string, unknown>;
  internals.dismissSkippableCodexUpdatePrompt = async () => undefined;
  internals.captureFreshThreadId = async () => "fresh-thread";
  internals.verifyResumeLaunch = async () => ({ ok: true });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const waits = () => log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[openrig] codex core plugin deferred: "));
  return {
    adapter, calls, daemonHome, ownHome, pluginsDir, project, waits,
    adds: () => calls.filter((call) => call.args[0] === "plugin" && call.args[1] === "add"),
    launch: (nodeId: string, resumeToken?: string) => adapter.launchHarness(
      { nodeId, tmuxSession: `${nodeId}@r`, cwd: project } as never, { name: `${nodeId}@r`, ...(resumeToken ? { resumeToken } : {}) }),
  };
}

describe("#3385: no codex plugin add for a Codex home while a seat runs the installed openrig-core there", () => {
  it("boot: leaves the installed version in place and names the running seat in the runtime setup warning", async () => {
    const w = world({ seats: [{ nodeId: "a", session: "dev-a@r", pane: "codex", selected: true }] });
    await w.adapter.ensureCodexCorePluginAtBoot(true);
    expect(w.adds()).toEqual([]);
    expect(cached(w.daemonHome)).toEqual([OLDER]);
    expect(w.waits()).toHaveLength(1);
    expect(w.waits()[0]).toContain("Codex seats running there: dev-a@r.");
  });

  it("a fresh launch meanwhile starts on the installed version, and its result names the seat holding the upgrade", async () => {
    const w = world({ seats: [{ nodeId: "a", session: "dev-a@r", pane: "codex" }, { nodeId: "fresh", session: "fresh@r", pane: "shell", selected: true }] });
    // The approval the installed version's hooks run under, as its install recorded it.
    const key = "openrig-core@openrig:hooks/codex.json:post_compact:0:0";
    fs.appendFileSync(path.join(w.daemonHome, "config.toml"), `\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:older"\ntrusted_content_hash = "sha256:older-bundle"\n`);
    const result = await w.launch("fresh");
    expect(result.ok).toBe(true);
    expect(w.adds()).toEqual([]);
    expect(cached(w.daemonHome)).toEqual([OLDER]);
    const config = parse(fs.readFileSync(path.join(w.daemonHome, "config.toml"), "utf8")) as { hooks: { state: Record<string, unknown> } };
    expect(config.hooks.state[key]).toEqual({ trusted_hash: "sha256:older", trusted_content_hash: "sha256:older-bundle" });
    // Codex loads the installed plugin into every session in the home, so a seat that didn't select it holds it too.
    expect((result as { warnings?: string[] }).warnings).toEqual([w.waits()[0]!.replace("[openrig] codex core plugin deferred: ", "")]);
    expect((result as { warnings: string[] }).warnings[0]).toContain("Codex seats running there: dev-a@r.");
  });

  it("the warning says which home, both versions, that new seats start on the installed one, and what installs it", async () => {
    const w = world({ seats: [{ nodeId: "a", session: "dev-a@r", pane: "codex" }, { nodeId: "b", session: "dev-b@r", pane: "codex" }] });
    await w.adapter.ensureCodexCorePluginAtBoot(true);
    expect(w.waits()).toEqual([`[openrig] codex core plugin deferred: openrig-core ${VERSION} waits to install in ${w.daemonHome}: `
      + `replacing openrig-core ${OLDER} under a running Codex turns off its hooks (refocus and compaction context) until that Codex restarts. `
      + "Codex seats running there: dev-a@r, dev-b@r. "
      + `Until it installs, Codex seats there, new ones included, start with openrig-core ${OLDER}. It installs once none of them is running: `
      + "rig seat restart <seat> --keep-conversation --reason \"<why>\" on the last one installs it before that seat's Codex starts again, "
      + "and rig down <rig> then rig up <rig> --existing restarts several together."]);
  });

  it("installs once no seat runs there: a pane back at its shell, an unbound seat, a session tmux says is gone, no tmux server", async () => {
    const w = world({
      seats: [{ nodeId: "a", session: "dev-a@r", pane: "shell" }, { nodeId: "b", session: null }, { nodeId: "c", session: "gone@r" }, { nodeId: "d", session: "lost@r" }],
      probe: (session) => session === "gone@r" ? { state: "absent" }
        : session === "lost@r" ? { state: "transport_unavailable", cause: "no server running on /tmp/tmux-1000/default" } : undefined,
    });
    await w.adapter.ensureCodexCorePluginAtBoot(true);
    expect(w.adds()).toHaveLength(1);
    expect(cached(w.daemonHome)).toEqual([VERSION]);
    expect(w.waits()).toEqual([]);
  });

  it("a first install isn't held: nothing installed there can be replaced under a running seat", async () => {
    const w = world({ installed: false, seats: [{ nodeId: "a", session: "dev-a@r", pane: "codex" }, { nodeId: "fresh", session: null, selected: true }] });
    expect((await w.launch("fresh")).ok).toBe(true);
    expect(w.adds()).toHaveLength(1);
    expect(cached(w.daemonHome)).toEqual([VERSION]);
  });

  it("a seat with its own CODEX_HOME holds only that home", async () => {
    const w = world({ seats: [
      { nodeId: "own-a", session: "own-a@r", pane: "codex", home: "own" },
      { nodeId: "daemon-b", session: null, selected: true },
      { nodeId: "own-c", session: null, home: "own", selected: true },
    ] });
    expect((await w.launch("daemon-b")).ok).toBe(true);
    expect(w.adds().map((call) => call.home)).toEqual([w.daemonHome]);
    const own = await w.launch("own-c");
    expect(own.ok).toBe(true);
    expect(w.adds().map((call) => call.home)).toEqual([w.daemonHome]);
    expect(cached(w.ownHome)).toEqual([OLDER]);
    expect((own as { warnings: string[] }).warnings[0]).toContain(`waits to install in ${w.ownHome}`);
    expect((own as { warnings: string[] }).warnings[0]).toContain("Codex seats running there: own-a@r.");
  });

  it.each<[string, WorldOptions]>([
    ["the process table can't be read", { processTable: "throws" }],
    ["tmux can't be reached for the session", { probe: () => ({ state: "transport_unavailable", cause: "error connecting to /tmp/tmux-1000/default (Permission denied)" }) }],
    ["tmux fails on the session", { probe: () => "throws" }],
    ["the pane's process can't be read", { panePid: () => null }],
    ["the pane's process isn't in the process table", { panePid: () => 4242 }],
  ])("a seat whose state can't be read counts as running, never as gone: %s", async (_label, options) => {
    const w = world({ ...options, seats: [{ nodeId: "a", session: "dev-a@r", pane: "shell" }] });
    await w.adapter.ensureCodexCorePluginAtBoot(true);
    expect(w.adds()).toEqual([]);
    expect(cached(w.daemonHome)).toEqual([OLDER]);
    expect(w.waits()[0]).toContain("Couldn't tell whether dev-a@r is running there, so it counts as running.");
  });

  it("OpenRig's seat records that can't be read hold the upgrade too", async () => {
    const w = world({ seatRecords: "throws" });
    await w.adapter.ensureCodexCorePluginAtBoot(true);
    expect(w.adds()).toEqual([]);
    expect(w.waits()[0]).toContain("OpenRig's records of its Codex seats couldn't be read, so a seat may be running there.");
  });
});

describe("#3385: what installs a waiting upgrade", () => {
  it("the last running seat's restart: its own Codex isn't counted, so the upgrade installs before its new Codex starts", async () => {
    const w = world({ seats: [{ nodeId: "a", session: "dev-a@r", pane: "codex" }] });
    expect(await w.adapter.upgradeCorePluginForResume("a", w.daemonHome)).toBeUndefined();
    expect(w.adds().map((call) => call.home)).toEqual([w.daemonHome]);
    expect(cached(w.daemonHome)).toEqual([VERSION]);
  });

  it("a restart while another seat still runs there keeps the installed version and says which seat holds it", async () => {
    const w = world({ seats: [{ nodeId: "a", session: "dev-a@r", pane: "shell" }, { nodeId: "b", session: "dev-b@r", pane: "codex" }] });
    const waiting = await w.adapter.upgradeCorePluginForResume("a", w.daemonHome);
    expect(waiting).toContain("Codex seats running there: dev-b@r.");
    expect(w.adds()).toEqual([]);
    expect(cached(w.daemonHome)).toEqual([OLDER]);
  });

  it("a resume launch completes a waiting upgrade once no other seat runs there; the seats stopped together all come back on it", async () => {
    const w = world({ seats: [{ nodeId: "a", session: "a@r", pane: "shell" }, { nodeId: "b", session: "b@r", pane: "shell" }] });
    expect((await w.launch("a", "conv-a")).ok).toBe(true);
    expect((await w.launch("b", "conv-b")).ok).toBe(true);
    expect(w.adds()).toHaveLength(1);
    expect(cached(w.daemonHome)).toEqual([VERSION]);
  });

  it("a resume, a restart and an unselected seat's fresh launch never make a first install", async () => {
    const w = world({ installed: false, seats: [{ nodeId: "a", session: "a@r", pane: "shell" }] });
    expect((await w.launch("a", "conv-a")).ok).toBe(true);
    expect(await w.adapter.upgradeCorePluginForResume("a", w.daemonHome)).toBeUndefined();
    expect((await w.launch("a")).ok).toBe(true);
    expect(w.calls).toEqual([]);
    expect(cached(w.daemonHome)).toEqual([]);
  });

  it("an unselected seat's fresh launch completes a waiting upgrade, since it runs the installed plugin too", async () => {
    const w = world({ seats: [{ nodeId: "a", session: "a@r", pane: "shell" }] });
    expect((await w.launch("a")).ok).toBe(true);
    expect(w.adds()).toHaveLength(1);
  });

  it("the restore's resume completes it after the managed config and before Codex starts, in the seat's own home", async () => {
    const order: string[] = [];
    const tmux = { sendShellCommand: vi.fn(async () => { order.push("codex resume sent"); return { ok: true }; }) };
    const adapter = new CodexResumeAdapter(tmux as unknown as TmuxAdapter, {
      ensureManagedConfig: async (home?: string) => { order.push(`managed config ${home ?? "daemon home"}`); },
      upgradeCorePlugin: async (session: string, home?: string) => { order.push(`upgrade ${session} ${home ?? "daemon home"}`); },
    });
    vi.spyOn(adapter as any, "verifyResume").mockResolvedValue({ ok: true });
    // The seat's own CODEX_HOME is resume's twelfth argument.
    expect((await adapter.resume("dev-a@r", "codex_id", "conv-a", "/work", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, "/seat/codex")).ok).toBe(true);
    expect((await adapter.resume("dev-b@r", "codex_id", "conv-b", "/work")).ok).toBe(true);
    expect(order).toEqual(["managed config /seat/codex", "upgrade dev-a@r /seat/codex", "codex resume sent",
      "managed config daemon home", "upgrade dev-b@r daemon home", "codex resume sent"]);
  });
});

// The boot path through a real daemon start: the daemon's own seat records, tmux answers and the OS process table.
describe("#3385: a daemon start", () => {
  function daemonFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-wait-daemon-")); roots.push(root);
    const home = path.join(root, "home"), codexHome = path.join(root, "codex-home"), bin = path.join(root, "bin"), live = path.join(root, "live");
    for (const dir of [home, codexHome, bin, live]) fs.mkdirSync(dir, { recursive: true });
    const calls = path.join(root, "codex-calls.jsonl");
    // The daemon's `codex`: records each call. The running seat's `codex` is another file that only stays up.
    fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nif(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else if(process.argv.includes('--version'))console.log('codex-cli 0.169.0');\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(live, "codex"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const instance = path.join(root, "instance");
    const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: codexHome, OPENRIG_HOME: instance };
    const codexCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
    return { root, home, codexHome, live, env, instance, codexCalls };
  }

  async function startDaemon(f: ReturnType<typeof daemonFixture>, panePid: () => number | null) {
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(f.home);
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value);
    vi.stubEnv("OPENRIG_DB", path.join(f.root, "instance.sqlite")); vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    vi.stubEnv("OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED", "true"); vi.stubEnv("OPENRIG_URL", undefined); vi.stubEnv("OPENRIG_PORT", undefined);
    const { createDaemon } = await import("../src/startup.js");
    // tmux: the seat's session is there, and its pane's process is `panePid`.
    const tmuxExec = async (command: string) => {
      if (command.includes("#{pane_pid}")) { const pid = panePid(); if (pid) return `${pid}\n`; throw new Error("can't find pane"); }
      return "";
    };
    return createDaemon({ dbPath: process.env.OPENRIG_DB!, tmuxExec, cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
  }

  async function waitForChild(parent: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await listNativeProcessesOrThrow()).some((row) => row.ppid === parent)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`process ${parent} started no child`);
  }

  it("under a running Codex seat leaves the installed version in place and names the seat; the next start with none running installs it", async () => {
    const f = daemonFixture();
    const first = await startDaemon(f, () => null);
    first.db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    first.db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-1', 'rig-1', 'dev.impl', 'codex')").run();
    first.db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'codex')")
      .run("node-1", JSON.stringify([{ category: "plugin", absolutePath: path.join(f.instance, "plugins", "openrig-core") }]));
    first.db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('binding-1', 'node-1', 'dev-impl@r')").run();
    first.db.close();
    installed(f.codexHome, path.join(f.instance, "plugins"));

    // The seat's pane: a shell running the seat's Codex.
    const pane = spawn("/bin/sh", ["-c", `"${path.join(f.live, "codex")}" --stay; exit 0`], { stdio: "ignore" });
    processes.push(pane);
    await waitForChild(pane.pid!);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = await startDaemon(f, () => pane.pid!);
    try {
      expect(f.codexCalls().filter((args) => args[0] === "plugin")).toEqual([]);
      expect(cached(f.codexHome)).toEqual([OLDER]);
      const waits = log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[openrig] codex core plugin deferred: "));
      expect(waits).toHaveLength(1);
      expect(waits[0]).toContain("Codex seats running there: dev-impl@r.");
    } finally { second.db.close(); }

    // The seat's Codex has exited and its pane is back at a shell.
    pane.kill("SIGKILL");
    const shell = spawn("/bin/sh", ["-c", "sleep 600"], { stdio: "ignore" });
    processes.push(shell);
    const third = await startDaemon(f, () => shell.pid!);
    try {
      expect(f.codexCalls().filter((args) => args[0] === "plugin").map((args) => args.slice(0, 2))).toEqual([["plugin", "add"]]);
    } finally { third.db.close(); }
  }, 120_000);
});
