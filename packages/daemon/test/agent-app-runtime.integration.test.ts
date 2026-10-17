import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// One community agent app end to end, through the real CLI, daemon, SQLite and a private tmux server: a synthetic
// Node app installed as a preset, then discovery, start, delivery through `rig send`, activity, resume, a missing
// preset and a built-in name collision. Nothing here runs a real agent app or touches a real home.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const appScript = resolve(here, "fixtures/agent-app/synth-app.mjs");
const agents = resolve(here, "../../test-system/scenarios/agents");
const session = "work-worker@agent-app-rig";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("a community agent app from a data preset", () => {
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
    const nodes = await json(["ps", "--nodes", "--rig", "agent-app-rig", "--full", "--json"]);
    return nodes[0];
  }
  const capture = () => execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "capture-pane", "-p", "-t", `=${session}:`], { env: scaffold.env as NodeJS.ProcessEnv }).toString();
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    let value = await read();
    while (!ok(value) && Date.now() < end) { await sleep(500); value = await read(); }
    return value;
  }
  const presetDir = () => join(scaffold.env.OPENRIG_HOME!, "agent-apps");
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
    writePreset("synth-app.yaml", [
      "format: 1", "name: synth-app", `command: node ${appScript}`, "maintainer: Example Maintainer",
      "limits:", "  - resume unsupported", "  - fork unsupported", "  - no approval-prompt detection", "",
    ].join("\n"));
    writePreset("codex.yaml", ["format: 1", "name: codex", "command: node -e 0", "maintainer: someone", ""].join("\n"));
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  }, 120_000);

  afterAll(async () => {
    try { if (daemon) await rig(["down", "agent-app-rig", "--json", "--force"]); }
    finally { await daemon?.stop(); }
  }, 60_000);

  it("is discoverable with its maintainer and limits, and a preset can't take a built-in name", async () => {
    const listed = await json(["agent-app", "list", "--json"]);
    const byName = Object.fromEntries(listed.apps.map((app: { name: string }) => [app.name, app]));
    expect(byName["synth-app"]).toMatchObject({ usable: true, community: true, testedByOpenRig: false, maintainer: "Example Maintainer",
      limits: ["resume unsupported", "fork unsupported", "no approval-prompt detection"] });
    expect(byName["codex"]).toMatchObject({ usable: false, problem: '"codex" is a built-in runtime; an agent app preset can\'t use that name' });
  });

  it("starts from the preset, labelled as a community app with identity not confirmed", async () => {
    const up = await rig(["up", specFor("agent-app-rig", "synth-app"), "--cwd", rigRoot, "--json", "--yes"], 120_000);
    expect(up.code, JSON.stringify(up)).toBe(0);
    rigId = JSON.parse(up.stdout).rigId;
    expect(await until(async () => capture(), text => text.includes("synth-app 1.0 started"))).toContain("app> ");
    const seat = await node();
    expect(seat).toMatchObject({ runtime: "synth-app", sessionStatus: "running",
      agentApp: { app: "synth-app", maintainer: "Example Maintainer", identity: "not confirmed", needsInput: "not detected: no prompt pattern" } });
    const human = await rig(["ps", "--nodes", "--rig", "agent-app-rig"]);
    expect(human.stdout).toContain(`Community app (${session}): synth-app, maintained by Example Maintainer, not tested by OpenRig. Identity not confirmed`);
    const verdict = await until(() => json(["ps", "--nodes", "--rig", "agent-app-rig", "--full", "--json"]).then(n => n[0]?.identityVerdict),
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
  }, 60_000);

  it("reports resume as unsupported and starts nothing", async () => {
    const snapshot = await rig(["snapshot", rigId]);
    expect(snapshot.code, JSON.stringify(snapshot)).toBe(0);
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
    const launched = await rig(["launch", rigId, "work.worker", "--json"], 60_000);
    expect(launched.code).not.toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({ status: "awaiting-decision",
      error: `Resume is unsupported for agent app "synth-app": its preset is launch-only. No session was started, and the earlier conversation is left as it is. Re-run with --fresh work.worker only if you want a new conversation.` });
    expect(() => capture()).toThrow();
    // A new conversation stays the person's deliberate choice.
    const fresh = await rig(["up", "agent-app-rig", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(JSON.parse(fresh.stdout).nodes, fresh.stdout).toEqual([expect.objectContaining({ logicalId: "work.worker", status: "fresh-primed" })]);
    expect(await until(async () => capture(), text => text.includes("synth-app 1.0 started"))).toContain("app> ");
    await rig(["send", session, "quit", "--json"]);
    await until(async () => capture(), text => text.includes("bye"));
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
  }, 240_000);

  it("says plainly when a rig names an app that isn't installed, and starts nothing", async () => {
    const up = await rig(["up", specFor("missing-app-rig", "no-such-app"), "--cwd", rigRoot, "--json", "--yes"], 60_000);
    expect(up.code).not.toBe(0);
    expect(JSON.parse(up.stdout)).toMatchObject({ code: "preflight_failed" });
    expect(JSON.parse(up.stdout).errors.join("\n")).toContain(`work.worker: unsupported runtime "no-such-app": it isn't built in, and no agent app preset named "no-such-app" is installed`);
    const all = await json(["ps", "--nodes", "--all-rigs", "--json"]);
    expect(all.map((n: { rigName: string }) => n.rigName)).not.toContain("missing-app-rig");
  }, 90_000);

  it("keeps an existing rig, launching nothing else, when its preset is removed", async () => {
    rmSync(join(presetDir(), "synth-app.yaml"));
    const launched = await rig(["launch", rigId, "work.worker", "--json"], 60_000);
    expect(launched.code).not.toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({ status: "awaiting-decision" });
    expect(() => capture()).toThrow();
    // Even a deliberate fresh start launches nothing in the app's place: no adapter, no harness.
    const fresh = await rig(["up", "agent-app-rig", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(fresh.stdout + fresh.stderr).toContain("Harness not started: no synth-app runtime adapter for work.worker.");
    expect(capture()).not.toContain("synth-app 1.0 started");
    const seat = await node();
    expect(seat.runtime).toBe("synth-app");
    expect(seat.agentApp.presetError).toContain(`no agent app preset named "synth-app" is installed`);
    expect(readFileSync(join(rigRoot, "agent-app-rig.yaml"), "utf-8")).toContain("runtime: synth-app");
  }, 180_000);
});
