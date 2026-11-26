import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { contextCollectorPath } from "../src/domain/telemetry-state-paths.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { parseManagedClaudeNodeCommand } from "../src/domain/claude-activity-hooks.js";
import { RestoreCheckService, type NodeInventoryEntry } from "../src/domain/restore-check-service.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const relay = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const collector = path.resolve(import.meta.dirname, "../assets/claude-statusline-context.cjs");
const relayParser = createRequire(import.meta.url)(relay) as { settingsRelayPath(command: string): { executable: string; relay: string } | null };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-node-")); roots.push(root);
  const cwd = path.join(root, "O'Brien project"), state = path.join(root, "instance's state");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  const settings = path.join(cwd, ".claude/settings.local.json");
  const relayDest = path.join(state, "state/claude-activity-hooks/activity-relay.cjs");
  const collectorDest = contextCollectorPath(state);
  const adapter = (nodeExecutable = process.execPath) => new ClaudeCodeAdapter({
    tmux: {} as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"], stateDir: state, nodeExecutable,
    activityRelayPath: relay, collectorAssetPath: collector,
    claudeHooksManifestPath: path.resolve(path.dirname(relay), "../claude.json"),
    fsOps: {
      readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p, value) => fs.writeFileSync(p, value),
      exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); }, copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    },
  });
  const project = async (a: ClaudeCodeAdapter) => {
    await a.project({ runtime: "claude-code", cwd, entries: [{ category: "runtime_resource", resourceType: "claude_activity_hooks",
      effectiveId: "activity", classification: "safe_projection", sourceSpec: "shared", sourcePath: relay,
      resourcePath: "activity", absolutePath: relay }], startup: { files: [], actions: [] },
      conflicts: [], noOps: [], diagnostics: [] } as ProjectionPlan, { cwd } as NodeBinding);
    a.ensureContextCollector({ cwd });
    return JSON.parse(fs.readFileSync(settings, "utf8"));
  };
  return { root, cwd, state, settings, relayDest, collectorDest, adapter, project };
}

const kinds = ["legacy", "pinned", "unquoted", "absolute-unquoted", "plugin-unquoted"];
// Settings written before #3416 hold the command without `exec`, and later ones with it: a launch owns and refreshes both.
it.each(kinds.flatMap(kind => [[kind, ""], [kind, "exec "]]))("refreshes %s commands (prefix %j) through the actual writers and preserves unrelated settings", async (kind, prefix) => {
  const f = fixture();
  const unquoted = kind.includes("unquoted");
  const old = prefix + (kind === "legacy" || kind === "unquoted" || kind === "plugin-unquoted" ? "node"
    : unquoted ? "/old/runtime/node" : shellQuote("/old Node's version/node"));
  const oldRelay = kind === "plugin-unquoted" ? path.join(f.root, "plugins/openrig-core/hooks/scripts/activity-relay.cjs")
    : unquoted ? path.join(f.root, "state/claude-activity-hooks/activity-relay.cjs") : f.relayDest;
  const oldCollector = unquoted ? path.join(f.root, ".openrig/context-collector.cjs") : f.collectorDest;
  const arg = (value: string) => unquoted ? value : shellQuote(value);
  const custom = { type: "command", command: `custom-wrapper ${shellQuote(f.relayDest)}` };
  const permissions = { allow: ["Bash(ls:*)"] };
  fs.writeFileSync(f.settings, JSON.stringify({ permissions,
    statusLine: { type: "command", command: `${old} ${arg(oldCollector)} ${arg("/old/context")} ${arg("/old/provider")}`, padding: 3 },
    hooks: { Stop: [{ hooks: [custom, { type: "command", command: `${old} ${arg(oldRelay)}` }] }] },
  }));
  const a = f.adapter();
  const result = await f.project(a);
  const wanted = `exec ${shellQuote(process.execPath)} ${shellQuote(f.relayDest)}`;
  expect(result.hooks.Stop.flatMap((g: any) => g.hooks)).toEqual([custom, { type: "command", command: wanted, timeout: 5 }]);
  expect(result.permissions).toEqual(permissions);
  expect(result.statusLine).toEqual({ type: "command", padding: 3,
    command: `exec ${shellQuote(process.execPath)} ${shellQuote(f.collectorDest)} ${shellQuote(path.join(f.state, "state/context-usage"))} ${shellQuote(path.join(f.state, "state/provider-usage"))}` });
  const bytes = fs.readFileSync(f.settings, "utf8");
  await f.project(a);
  expect(fs.readFileSync(f.settings, "utf8")).toBe(bytes);
});

it.each(["{ bad json", "[]", JSON.stringify({ statusLine: { command: "custom status" }, extra: 1 })])(
  "keeps malformed and custom status-line settings during collector refresh: %s", async original => {
    const f = fixture(); fs.writeFileSync(f.settings, original);
    f.adapter().ensureContextCollector({ cwd: f.cwd });
    expect(fs.readFileSync(f.settings, "utf8")).toBe(original);
  });

it("keeps non-node-named runtimes on the recognized legacy form through refresh and restore-check", async () => {
  const f = fixture();
  const executable = path.join(f.root, "node-22");
  fs.symlinkSync(process.execPath, executable);
  const a = f.adapter(executable);
  const first = await f.project(a);
  expect(first.hooks.Stop[0].hooks[0].command).toBe(`exec node ${shellQuote(f.relayDest)}`);
  expect(first.statusLine.command).toBe(`exec node ${shellQuote(f.collectorDest)} ${shellQuote(path.join(f.state, "state/context-usage"))} ${shellQuote(path.join(f.state, "state/provider-usage"))}`);
  expect(relayParser.settingsRelayPath(first.hooks.Stop[0].hooks[0].command))
    .toEqual({ executable: "node", relay: f.relayDest });
  const bytes = fs.readFileSync(f.settings, "utf8");
  await f.project(a);
  expect(fs.readFileSync(f.settings, "utf8")).toBe(bytes); // no duplicate relays

  const service = new RestoreCheckService({
    stateDir: f.state, listRigs: () => [{ rigId: "fixture-rig", name: "fixture-rig" }],
    getNodeInventory: () => [{ nodeId: "fixture-node", logicalId: "fixture-worker", nodeKind: "agent",
      canonicalSessionName: "fixture-worker", runtime: "claude-code", cwd: f.cwd,
      sessionStatus: "running", startupStatus: "ready" } as NodeInventoryEntry],
    getStartupContext: () => ({ status: "ok", runtime: "claude-code", resolvedStartupFiles: [],
      projectionEntries: [{ absolutePath: f.relayDest, category: "runtime_resource", resourceType: "claude_activity_hooks" }] }),
    getClaudeActivityHookEvents: () => Object.keys(first.hooks), hasSnapshot: () => false,
    getRestoreInputs: () => ({ unavailable: "fixture does not select restore" }),
    probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running (fixture)" }),
    exists: fs.existsSync, readFile: p => fs.readFileSync(p, "utf8"),
  });
  const hook = service.check({ noQueue: true }).checks.find(c => c.check === "seat.fixture-worker.hooks");
  expect(hook?.status).toBe("green");
  expect(hook?.evidence).toContain("activity hooks are projected");

  // A later recognized interpreter replaces the collector rather than treating it as user-owned.
  const refreshed = await f.project(f.adapter());
  expect(refreshed.statusLine.command).toBe(`exec ${shellQuote(process.execPath)} ${shellQuote(f.collectorDest)} ${shellQuote(path.join(f.state, "state/context-usage"))} ${shellQuote(path.join(f.state, "state/provider-usage"))}`);
  expect(refreshed.hooks.Stop).toHaveLength(1);
});

it("executes both actual generated commands with no Node on PATH and quoted interpreter/project names", async () => {
  const f = fixture();
  const executable = path.join(f.root, "Node O'Brien", "node");
  fs.mkdirSync(path.dirname(executable)); fs.symlinkSync(process.execPath, executable);
  const result = await f.project(f.adapter(executable));
  const posts: unknown[] = [];
  const server = createServer((req, res) => {
    let input = ""; req.on("data", chunk => { input += chunk; });
    req.on("end", () => { posts.push(JSON.parse(input)); res.end("{}"); });
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  try {
    const port = (server.address() as { port: number }).port;
    const command = result.hooks.Stop[0].hooks[0].command as string;
    expect(command).toBe(`exec ${shellQuote(executable)} ${shellQuote(f.relayDest)}`);
    await new Promise<void>((ok, fail) => {
      const child = spawn("/bin/sh", ["-c", command], { cwd: f.cwd, timeout: 5000,
        env: { PATH: "", HOME: f.root, OPENRIG_HOME: f.state, OPENRIG_URL: `http://127.0.0.1:${port}`,
          OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-only", OPENRIG_RUNTIME: "claude-code", OPENRIG_NODE_ID: "fixture-node",
          OPENRIG_SESSION_NAME: "fixture-worker", OPENRIG_OCCUPANT_GENERATION: "fixture-generation" }, stdio: ["pipe", "ignore", "pipe"] });
      let error = ""; child.stderr.on("data", chunk => { error += chunk; });
      child.on("error", fail); child.on("close", code => code === 0 ? ok() : fail(new Error(error || `exit ${code}`)));
      child.stdin.end('{"hook_event_name":"Stop"}');
    });
    expect(posts).toEqual([expect.objectContaining({ hookEvent: "Stop", nodeId: "fixture-node", generation: "fixture-generation" })]);
    const sample = { session_id: "fixture-id", session_name: "fixture-worker", context_window: { used_percentage: 37 } };
    const r = spawnSync("/bin/sh", ["-c", result.statusLine.command], {
      cwd: f.cwd, env: { PATH: "", HOME: f.root }, input: JSON.stringify(sample), encoding: "utf8", timeout: 5000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.state, "state/context-usage/fixture-worker.json"), "utf8")))
      .toMatchObject({ session_id: "fixture-id", context_window: { used_percentage: 37 } });
    fs.unlinkSync(executable);
    const sidecar = path.join(f.state, "state/context-usage/fixture-worker.json");
    fs.unlinkSync(sidecar);
    const missing = spawnSync("/bin/sh", ["-c", result.statusLine.command], {
      cwd: f.cwd, env: { PATH: process.env.PATH }, input: JSON.stringify(sample), encoding: "utf8", timeout: 5000,
    });
    // No hidden fallback to a different PATH interpreter: the shell can't run the pinned one and nothing else runs.
    // dash and current bash report a missing file to `exec` as 127; the bash 3.2 behind macOS /bin/sh reports 126.
    expect([126, 127], missing.stderr).toContain(missing.status);
    expect(fs.existsSync(sidecar)).toBe(false);
  } finally { await new Promise<void>(ok => server.close(() => ok())); }
});

// #3416: both generated commands start Node in place of the shell that runs them, with the pinned and the legacy interpreter.
it.each(["pinned", "legacy"])("runs the generated relay and status line commands as the Node process itself (%s)", async kind => {
  const f = fixture();
  const executable = kind === "pinned" ? process.execPath : path.join(f.root, "node-22");
  if (kind === "legacy") fs.symlinkSync(process.execPath, executable);
  const result = await f.project(f.adapter(executable));
  // The scripts the commands name are swapped for one that reports its own pid; the commands stay as written.
  const report = 'process.stdout.write(String(process.pid));';
  fs.writeFileSync(f.relayDest, report); fs.writeFileSync(f.collectorDest, report);
  for (const command of [result.hooks.Stop[0].hooks[0].command as string, result.statusLine.command as string]) {
    expect(command.startsWith("exec ")).toBe(true);
    const r = spawnSync("/bin/sh", ["-c", command], { cwd: f.cwd, encoding: "utf8", timeout: 5000, input: "{}",
      env: { PATH: path.dirname(process.execPath), HOME: f.root } });
    expect(r.status, r.stderr).toBe(0);
    expect(Number(r.stdout)).toBe(r.pid);
  }
});

it.each(["node", shellQuote("/Node O'Brien/node")].flatMap(e => [[e, ""], [e, "exec "], [e, "exec \t"]]))("keeps the adapter and standalone relay command grammar in parity: %s (prefix %j)", (executable, prefix) => {
  const script = "/instance O'Brien/state/claude-activity-hooks/activity-relay.cjs";
  const command = `${prefix}${executable} ${shellQuote(script)}`;
  expect(parseManagedClaudeNodeCommand(command)).toEqual({ executable: executable === "node" ? "node" : "/Node O'Brien/node", args: [script] });
  expect(relayParser.settingsRelayPath(command)).toEqual({ executable: executable === "node" ? "node" : "/Node O'Brien/node", relay: script });
  const bare = `${executable} ${shellQuote(script)}`;
  for (const invalid of [command + " extra", command + " 'extra'", `${prefix}${shellQuote("/custom/wrapper")} ${shellQuote(script)}`, command + "\necho extra"]) {
    expect(relayParser.settingsRelayPath(invalid)).toBeNull();
  }
  // Only one plain leading `exec` is OpenRig's: not doubled, not with options, not quoted, not without a space, not alone,
  // and no other wrapper.
  for (const invalid of [`exec exec ${bare}`, `exec -a name ${bare}`, `'exec' ${bare}`, `exec${bare}`, `exec ${shellQuote(script)}`, "exec", `nice ${bare}`]) {
    expect(relayParser.settingsRelayPath(invalid)).toBeNull();
    expect(parseManagedClaudeNodeCommand(invalid)).toBeNull();
  }
});

it.each(["explicit", "legacy"])("runs every Claude plugin hook command with the %s interpreter selection", kind => {
  const f = fixture();
  const plugin = path.join(f.root, "plugin's hooks");
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(relay), "../claude.json"), "utf8"));
  const commands = Object.values(manifest.hooks).flatMap((groups: any) => groups.flatMap((g: any) => g.hooks.map((h: any) => h.command))) as string[];
  for (const command of commands) {
    const relative = /\$\{CLAUDE_PLUGIN_ROOT\}([^"\s]+)/.exec(command)![1]!;
    const script = path.join(plugin, relative);
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ node: process.execPath, pid: process.pid, args: process.argv.slice(2) }));');
    const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 5000,
      env: { PATH: kind === "explicit" ? "" : path.dirname(process.execPath), CLAUDE_PLUGIN_ROOT: plugin,
        ...(kind === "explicit" ? { OPENRIG_NODE: process.execPath } : {}) } });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).node).toBe(fs.realpathSync(process.execPath));
    // #3416: `exec` makes the shell become Node, so a hook costs one process, not a waiting `sh` plus Node (dash keeps it).
    expect(command.startsWith("exec ")).toBe(true);
    expect(JSON.parse(r.stdout).pid).toBe(r.pid);
  }
});

it.each(["node", "/old/runtime/node", "'/old/runtime/node'"].flatMap(e => [[e, ""], [e, "exec "]]))("recognizes unquoted relay paths in both readers: %s (prefix %j)", (executable, prefix) => {
  const script = "/instance/state/claude-activity-hooks/activity-relay.cjs";
  const command = `${prefix}${executable} ${script}`;
  const wanted = executable === "node" ? "node" : "/old/runtime/node";
  expect(parseManagedClaudeNodeCommand(command)).toEqual({ executable: wanted, args: [script] });
  expect(relayParser.settingsRelayPath(command)).toEqual({ executable: wanted, relay: script });
  for (const suffix of ["; echo extra", " && echo extra", " | cat", " $(echo extra)", "*", "\nnode extra"]) {
    expect(parseManagedClaudeNodeCommand(command + suffix)).toBeNull();
    expect(relayParser.settingsRelayPath(command + suffix)).toBeNull();
  }
});
