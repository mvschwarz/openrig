import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// A format-2 agent app end to end, through the real CLI, daemon, SQLite and a private tmux server: the synthetic
// session app records a conversation, a snapshot captures its id, and `rig launch` brings that conversation back, or
// stops and asks when the app says it's gone. Nothing here runs a real agent app or touches a real home.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const appScript = resolve(here, "fixtures/agent-app/synth-session-app.mjs");
const agents = resolve(here, "../../test-system/scenarios/agents");
const session = "work-worker@session-app-rig";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("an agent app that declares session continuity", () => {
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
  async function node() { return (await json(["ps", "--nodes", "--rig", "session-app-rig", "--full", "--json"]))[0]; }
  const capture = () => execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "capture-pane", "-p", "-S", "-500", "-t", `=${session}:`], { env: scaffold.env as NodeJS.ProcessEnv }).toString();
  const kill = () => execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    let value = await read();
    while (!ok(value) && Date.now() < end) { await sleep(500); value = await read(); }
    return value;
  }
  const appSessions = () => join(scaffold.env.HOME!, ".synth-session-app", "sessions");

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    rigRoot = join(scaffold.root, "rig");
    mkdirSync(rigRoot);
    cpSync(agents, join(rigRoot, "agents"), { recursive: true });
    const presetDir = join(scaffold.env.OPENRIG_HOME!, "agent-apps");
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, "synth-session.yaml"), [
      "format: 2", "name: synth-session", `command: node ${appScript}`, "maintainer: Example Maintainer",
      "limits:", "  - fork unsupported",
      "session:", "  id_pattern: '^ses_[A-Za-z0-9]{8,40}$'",
      `  resume: [node, '${appScript}', --session, '{session_id}']`,
      `  exists: [node, '${appScript}', export, '{session_id}']`,
      `  list: [node, '${appScript}', session, list, --format, json]`, "",
    ].join("\n"));
    writeFileSync(join(rigRoot, "session-app-rig.yaml"), `version: "0.2"\nname: session-app-rig\npods:\n  - id: work\n    label: Work\n    members:\n      - {id: worker, agent_ref: "local:agents/worker", profile: default, runtime: synth-session, cwd: .}\n    edges: []\n`);
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  }, 120_000);

  afterAll(async () => {
    try { if (daemon) await rig(["down", "session-app-rig", "--json", "--force"]); }
    finally { await daemon?.stop(); }
  }, 60_000);

  it("captures the conversation a seat started and resumes it after the seat stops", async () => {
    const up = await rig(["up", join(rigRoot, "session-app-rig.yaml"), "--cwd", rigRoot, "--json", "--yes"], 120_000);
    expect(up.code, JSON.stringify(up)).toBe(0);
    rigId = JSON.parse(up.stdout).rigId;
    expect(await until(async () => capture(), text => text.includes("synth ready: new session"))).toContain("synth ready");
    await rig(["send", session, "remember the word heron", "--json"]);
    await until(async () => capture(), text => text.includes("synth heard"));
    const [file] = readdirSync(appSessions());
    const id = file!.replace(/\.json$/, "");
    expect((await rig(["snapshot", rigId])).code).toBe(0);
    kill();
    await until(node, n => n.sessionStatus !== "running", 20_000);
    const launched = await rig(["launch", rigId, "work.worker", "--json"], 90_000);
    expect(launched.code, JSON.stringify(launched)).toBe(0);
    expect(JSON.parse(launched.stdout), launched.stdout).toMatchObject({ ok: true, launched: [expect.objectContaining({ logicalId: "work.worker", status: "resumed" })] });
    expect(await until(async () => capture(), text => text.includes(`synth ready: resumed ${id}`))).toContain(id);
  }, 300_000);

  it("stops and asks when the app reports the saved conversation is gone, and starts nothing", async () => {
    expect((await rig(["snapshot", rigId])).code).toBe(0);
    kill();
    await until(node, n => n.sessionStatus !== "running", 20_000);
    rmSync(appSessions(), { recursive: true, force: true });
    const launched = await rig(["launch", rigId, "work.worker", "--json"], 90_000);
    expect(launched.code).not.toBe(0);
    expect(JSON.parse(launched.stdout), launched.stdout).toMatchObject({ status: "awaiting-decision",
      error: expect.stringContaining(`reports that the saved conversation no longer exists`) });
    expect(() => capture()).toThrow();
  }, 300_000);
});
