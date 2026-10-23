import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// One community harness end to end, through the real CLI, daemon, SQLite and a private tmux server: a synthetic
// Node app installed as a preset, then discovery, start, delivery through `rig send`, activity, resume, a missing
// preset and a built-in name collision. Nothing here runs a real community harness or touches a real home.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const appScript = resolve(here, "fixtures/community-harness/synth-harness.mjs");
const agents = resolve(here, "../../test-system/scenarios/agents");
const session = "work-worker@community-harness-rig";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("a community harness from a data preset", () => {
  let scaffold: HermeticScaffold;
  let daemon: ScenarioDaemon;
  let rigRoot: string;
  let rigId: string;

  const rig = (args: string[], timeout?: number) => runRig(args, daemon.readEnv, rigBin, timeout);
  async function json(args: string[]) {
    const result = await rig(args);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout);
  }
  async function node() {
    const nodes = await json(["ps", "--nodes", "--rig", "community-harness-rig", "--full", "--json"]);
    return nodes[0];
  }
  const capture = () => execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "capture-pane", "-p", "-t", `=${session}:`], { env: scaffold.env as NodeJS.ProcessEnv }).toString();
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    let value = await read();
    while (!ok(value) && Date.now() < end) { await sleep(500); value = await read(); }
    return value;
  }
  const presetDir = () => join(scaffold.env.OPENRIG_HOME!, "community-harnesses");
  const writePreset = (file: string, body: string) => { mkdirSync(presetDir(), { recursive: true }); writeFileSync(join(presetDir(), file), body); };
  const specFor = (name: string, runtime: string) => {
    const path = join(rigRoot, `${name}.yaml`);
    writeFileSync(path, `version: "0.2"\nname: ${name}\npods:\n  - id: work\n    label: Work\n    members:\n      - {id: worker, agent_ref: "local:agents/worker", profile: default, runtime: ${runtime}, cwd: .}\n    edges: []\n`);
    return path;
  };

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    rigRoot = join(scaffold.root, "rig");
    mkdirSync(rigRoot);
    cpSync(agents, join(rigRoot, "agents"), { recursive: true });
    writePreset("synth-harness.yaml", [
      "format: 1", "name: synth-harness", `command: node ${appScript}`, "maintainer: Example Maintainer",
      "limits:", "  - resume unsupported", "  - fork unsupported", "  - no approval-prompt detection", "",
    ].join("\n"));
    const previousDir = join(scaffold.env.OPENRIG_HOME!, ["agent", "apps"].join("-"));
    mkdirSync(previousDir);
    writeFileSync(join(previousDir, "legacy-only.yaml"), "format: 1\nname: legacy-only\ncommand: node -e 0\nmaintainer: Example Maintainer\n");
    writePreset("codex.yaml", ["format: 1", "name: codex", "command: node -e 0", "maintainer: someone", ""].join("\n"));
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  }, 120_000);

  afterAll(async () => {
    try { if (daemon) for (const r of ["community-harness-rig", "free-rig"]) await rig(["down", r, "--json", "--force"]); }
    finally { await daemon?.stop(); }
  }, 60_000);

  it("serves the renamed route and JSON keys without exposing the removed public route", async () => {
    const response = await fetch(`${daemon.baseUrl}/api/community-harnesses`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.dir).toBe(presetDir());
    expect(data.harnesses.map((preset: { name: string }) => preset.name)).toContain("synth-harness");
    expect(data).not.toHaveProperty("apps");
    const oldRoute = ["agent", "apps"].join("-");
    expect((await fetch(`${daemon.baseUrl}/api/${oldRoute}`)).status).toBe(404);
    const help = await rig(["community-harness", "list", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("community harness presets");
  });

  it("is discoverable with its maintainer and limits, and a preset can't take a built-in name", async () => {
    const listed = await json(["community-harness", "list", "--json"]);
    const byName = Object.fromEntries(listed.harnesses.map((app: { name: string }) => [app.name, app]));
    expect(byName).not.toHaveProperty("legacy-only");
    const previousPreset = join(scaffold.env.OPENRIG_HOME!, ["agent", "apps"].join("-"), "legacy-only.yaml");
    expect(readFileSync(previousPreset, "utf-8")).toContain("name: legacy-only");
    expect(byName["synth-harness"]).toMatchObject({ usable: true, community: true, testedByOpenRig: false, maintainer: "Example Maintainer",
      limits: ["resume unsupported", "fork unsupported", "no approval-prompt detection"] });
    expect(byName["codex"]).toMatchObject({ usable: false, problem: '"codex" is a built-in runtime; a community harness preset can\'t use that name' });
  });

  it("starts from the preset, labelled as a community app with identity not confirmed", async () => {
    const up = await rig(["up", specFor("community-harness-rig", "synth-harness"), "--cwd", rigRoot, "--json", "--yes"], 120_000);
    expect(up.code, JSON.stringify(up)).toBe(0);
    rigId = JSON.parse(up.stdout).rigId;
    expect(await until(async () => capture(), text => text.includes("synth-harness 1.0 started"))).toContain("app> ");
    const seat = await node();
    expect(seat).toMatchObject({ runtime: "synth-harness", sessionStatus: "running",
      communityHarness: { harness: "synth-harness", maintainer: "Example Maintainer", identity: "not confirmed", needsInput: "from the screen only: no harness prompt pattern" } });
    const human = await rig(["ps", "--nodes", "--rig", "community-harness-rig"]);
    expect(human.stdout).toContain(`Community harness (${session}): synth-harness, maintained by Example Maintainer, not tested by OpenRig. Identity not confirmed`);
    const verdict = await until(() => json(["ps", "--nodes", "--rig", "community-harness-rig", "--full", "--json"]).then(n => n[0]?.identityVerdict),
      v => v?.verdict === "unconfirmed", 20_000);
    expect(verdict).toMatchObject({ verdict: "unconfirmed", reason: "process_identity_unconfirmed" });
  }, 150_000);

  it("delivers a message through rig send while identity isn't confirmed", async () => {
    const sent = await rig(["send", session, "hello-from-rig", "--json"]);
    expect(sent.code, JSON.stringify(sent)).toBe(0);
    expect(await until(async () => capture(), text => text.includes("got: hello-from-rig"))).toContain("got: hello-from-rig");
  }, 60_000);

  it("reads a quiet screen as unknown, a changing one as working from window sampling", async () => {
    await sleep(8_000);
    const quiet = await node();
    expect(quiet.activityState).toMatchObject({ activity: "unknown", decidedBy: null });
    expect(quiet.activityState.display).not.toBe("idle");
    await rig(["send", session, "busy", "--json"]);
    const busy = await until(node, n => n.activityState?.activity === "working", 15_000);
    expect(busy.activityState).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
    const after = await until(node, n => n.activityState?.activity !== "working", 30_000);
    expect(after.activityState.activity).toBe("unknown");
  }, 90_000);

  it("refuses to type into a visible approval prompt", async () => {
    const asked = await rig(["send", session, "ask", "--json"]);
    expect(asked.code, JSON.stringify(asked)).toBe(0);
    await until(async () => capture(), text => text.includes("Do you want to proceed?"));
    const refused = await rig(["send", session, "should-not-arrive", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("target_needs_input");
    expect(capture()).not.toContain("should-not-arrive");
    // rig ps keeps the prompt the screen shows: the app's default-zero needs-input isn't a clearance.
    // The ACTIVITY cell is clipped to its width, as for a built-in's "needs-input x1".
    const row = (out: string) => out.split("\n").find(line => line.includes(session)) ?? "";
    const shown = await until(() => rig(["ps", "--nodes", "--rig", "community-harness-rig"]).then(r => row(r.stdout)), line => line.includes("needs-input"), 20_000);
    expect(shown).toContain("needs-input");
    // The person answers it at the pane.
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "send-keys", "-t", `=${session}:`, "y", "Enter"], { env: scaffold.env as NodeJS.ProcessEnv });
    expect(await until(async () => capture(), text => text.includes("answered: y"))).not.toContain("Do you want to proceed?");
  }, 60_000);

  it("refuses to send once the app has exited to a shell", async () => {
    // The answered prompt is still in the pane's scrollback, which the send guard reads; start this case clean.
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "clear-history", "-t", `=${session}:`], { env: scaffold.env as NodeJS.ProcessEnv });
    const quit = await rig(["send", session, "quit", "--json"]);
    expect(quit.code, JSON.stringify(quit)).toBe(0);
    await until(async () => capture(), text => text.includes("bye"));
    await sleep(1_000);
    const refused = await rig(["send", session, "after-exit", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("target_runtime_unverified");
    // A subset launch calls the app not running, names the recovery, keeps the pane and starts nothing.
    await rig(["snapshot", rigId]);
    const launched = await rig(["launch", rigId, "work.worker", "--json"], 60_000);
    const seat = JSON.parse(launched.stdout).launched?.find((n: { logicalId: string }) => n.logicalId === "work.worker");
    expect(seat, launched.stdout).toMatchObject({ status: "attention_required" });
    expect(seat.error).toContain(`Session alive, agent not running for 'work.worker'`);
    expect(seat.error).toContain(`rig seat launch ${session} --fresh --stop`);
    expect(capture()).toContain("bye");
    const foreground = execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "display-message", "-p", "-t", `=${session}:`, "#{pane_current_command}"], { env: scaffold.env as NodeJS.ProcessEnv }).toString().trim();
    expect(["bash", "sh", "zsh", "dash"]).toContain(foreground);
  }, 60_000);

  it("reports resume as unsupported and starts nothing", async () => {
    const snapshot = await rig(["snapshot", rigId]);
    expect(snapshot.code, JSON.stringify(snapshot)).toBe(0);
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
    const launched = await rig(["launch", rigId, "work.worker", "--json"], 60_000);
    expect(launched.code).not.toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({ status: "awaiting-decision",
      error: `Resume is unsupported for community harness "synth-harness": its preset is launch-only. No session was started, and the earlier conversation is left as it is. Only if you want a new conversation, run: rig seat launch 'work.worker@community-harness-rig' --fresh --reason "<why>".` });
    expect(() => capture()).toThrow();
    // A new conversation stays the person's deliberate choice.
    const fresh = await rig(["up", "community-harness-rig", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(JSON.parse(fresh.stdout).nodes, fresh.stdout).toEqual([expect.objectContaining({ logicalId: "work.worker", status: "fresh-primed" })]);
    expect(await until(async () => capture(), text => text.includes("synth-harness 1.0 started"))).toContain("app> ");
    await rig(["send", session, "quit", "--json"]);
    await until(async () => capture(), text => text.includes("bye"));
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
  }, 240_000);

  it("says plainly when a rig names an app that isn't installed, and starts nothing", async () => {
    const up = await rig(["up", specFor("missing-app-rig", "no-such-app"), "--cwd", rigRoot, "--json", "--yes"], 60_000);
    expect(up.code).not.toBe(0);
    expect(JSON.parse(up.stdout)).toMatchObject({ code: "preflight_failed" });
    expect(JSON.parse(up.stdout).errors.join("\n")).toContain(`work.worker: unsupported runtime "no-such-app": it isn't built in, and no community harness preset named "no-such-app" is installed`);
    const all = await json(["ps", "--nodes", "--all-rigs", "--json"]);
    expect(all.map((n: { rigName: string }) => n.rigName)).not.toContain("missing-app-rig");
  }, 90_000);

  it("keeps an app's seat a community harness after its preset is removed, across a daemon restart and a snapshot", async () => {
    // A fresh start while the preset is installed: this occupant was launched for the app.
    const fresh = await rig(["up", "community-harness-rig", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(JSON.parse(fresh.stdout).nodes, fresh.stdout).toEqual([expect.objectContaining({ logicalId: "work.worker", status: "fresh-primed" })]);
    await until(async () => capture(), text => text.includes("synth-harness 1.0 started"));
    rmSync(join(presetDir(), "synth-harness.yaml"));
    await daemon.restart();
    const seat = await until(node, n => n.identityVerdict?.verdict === "unconfirmed", 30_000);
    expect(seat).toMatchObject({ runtime: "synth-harness", identityVerdict: { verdict: "unconfirmed", reason: "process_identity_unconfirmed" } });
    expect(seat.communityHarness.presetError).toContain(`no community harness preset named "synth-harness" is installed`);
    await sleep(8_000);
    expect((await node()).activityState).toMatchObject({ activity: "unknown", decidedBy: null });
    // Stopped, then a snapshot: still launch-only, so nothing resumes and nothing starts in its place.
    await rig(["send", session, "quit", "--json"]);
    await until(async () => capture(), text => text.includes("bye"));
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
    expect((await rig(["snapshot", rigId])).code).toBe(0);
    const launched = await rig(["launch", rigId, "work.worker", "--json"], 60_000);
    expect(launched.code).not.toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({ status: "awaiting-decision",
      error: expect.stringContaining(`Resume is unsupported for community harness "synth-harness"`) });
    expect(() => capture()).toThrow();
    const again = await rig(["up", "community-harness-rig", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(again.stdout + again.stderr).toContain("Harness not started: no synth-harness runtime adapter for work.worker.");
    expect(capture()).not.toContain("synth-harness 1.0 started");
    expect((await node()).communityHarness.presetError).toContain(`no community harness preset named "synth-harness" is installed`);
    expect(readFileSync(join(rigRoot, "community-harness-rig.yaml"), "utf-8")).toContain("runtime: synth-harness");
  }, 300_000);

  /** Self-attach from a new pane on the private tmux server, the way a person runs `rig attach --self`. */
  async function attachSelf(tmuxSession: string, args: string[]) {
    const script = join(scaffold.root, `${tmuxSession}.sh`);
    const out = join(scaffold.root, `${tmuxSession}.json`);
    const exports = Object.entries(daemon.readEnv).filter(([, v]) => v !== undefined)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n");
    writeFileSync(script, `${exports}\nnode ${JSON.stringify(rigBin)} attach --self ${args.map(a => JSON.stringify(a)).join(" ")} --json > ${JSON.stringify(out)} 2>&1\nexec sh\n`);
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "new-session", "-d", "-s", tmuxSession, "sh", script], { env: scaffold.env as NodeJS.ProcessEnv });
    const text = await until(async () => { try { return readFileSync(out, "utf-8"); } catch { return ""; } }, t => t.trim().endsWith("}"), 30_000);
    return JSON.parse(text);
  }

  it("leaves a free-text self-attached seat as it was, before and after a same-named preset appears", async () => {
    const up = await rig(["up", specFor("free-rig", "stub"), "--cwd", rigRoot, "--json", "--yes"], 120_000);
    expect(up.code, JSON.stringify(up)).toBe(0);
    const freeRigId = JSON.parse(up.stdout).rigId;
    const attached = await attachSelf("free-seat", ["--rig", freeRigId, "--pod", "work", "--member", "free", "--runtime", "free-harness", "--cwd", rigRoot]);
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
    const freeSeat = async () => (await json(["ps", "--nodes", "--rig", "free-rig", "--full", "--json"])).find((n: { logicalId: string }) => n.logicalId === "work.free");
    const check = async () => {
      const seat = await until(freeSeat, n => n?.identityVerdict?.verdict === "verified" && n?.activityState?.activity === "idle-at-prompt", 30_000);
      expect(seat).toMatchObject({ runtime: "free-harness", identityVerdict: { verdict: "verified", reason: null },
        activityState: { activity: "idle-at-prompt", decidedBy: "window-sampling" } });
      expect(seat).not.toHaveProperty("communityHarness");
    };
    await check();
    writePreset("free-harness.yaml", ["format: 1", "name: free-harness", `command: node ${appScript}`, "maintainer: Example Maintainer", ""].join("\n"));
    await sleep(4_000);
    await check();
    // A relaunch doesn't start the same-named app in its place.
    expect((await rig(["down", "free-rig", "--json", "--force"])).code).toBe(0);
    // A deliberate fresh launch of the seat gets main's refusal (a self-attached seat has no startup context, checked
    // before any adapter lookup) and starts nothing.
    const seatLaunch = await rig(["seat", "launch", "work.free@free-rig", "--fresh", "--reason", "relaunch a free-text seat", "--json"], 60_000);
    expect(seatLaunch.code, JSON.stringify(seatLaunch)).not.toBe(0);
    expect(JSON.parse(seatLaunch.stdout)).toMatchObject({ ok: false, code: "startup_context_missing" });
    const relaunch = await rig(["up", "free-rig", "--existing", "--fresh", "work.free", "--json"], 120_000);
    const freeResult = (JSON.parse(relaunch.stdout).nodes ?? []).find((n: { logicalId: string }) => n.logicalId === "work.free");
    // Restore doesn't relaunch a self-attached seat, as on main; with the preset installed it still starts nothing.
    expect(freeResult, relaunch.stdout).toBeUndefined();
    const panes = execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "list-panes", "-a", "-F", "#{session_name} #{pane_current_command}"], { env: scaffold.env as NodeJS.ProcessEnv }).toString();
    expect(panes).not.toMatch(/free\S* node/);
    await rig(["down", "free-rig", "--json", "--force"]);
  }, 300_000);

  it("doesn't pass the community-harness classification to a different occupant of the same seat", async () => {
    expect((await rig(["down", "community-harness-rig", "--json", "--force"])).code).toBe(0);
    const attached = await attachSelf("other-occupant", ["--rig", rigId, "--node", "work.worker"]);
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
    const seat = await until(node, n => n.identityVerdict?.verdict === "verified", 30_000);
    expect(seat.identityVerdict).toMatchObject({ verdict: "verified", reason: null });
    expect(seat).not.toHaveProperty("communityHarness");
  }, 120_000);
});
