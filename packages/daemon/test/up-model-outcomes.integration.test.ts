import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const rigBin = resolve(import.meta.dirname, "../../cli/dist/bin-wrapper.js");

// Real CLI, daemon, runner and tmux; only the provider child is an offline RPC fixture.
describe("rig up reports launch facts, not model catalog membership", () => {
  let scaffold: HermeticScaffold;
  let daemon: ScenarioDaemon | undefined;
  let bin: string;
  const rigs: string[] = [];

  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), "up-model-bin-"));
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: bin + delimiter + process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/bash" } });
    writeFileSync(join(scaffold.home, ".zshrc"), "\n");
    writeFileSync(join(bin, "pi"), String.raw`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
if (args.includes('--version')) { console.log('0.87.1'); process.exit(0); }
const model = at('--model');
fs.appendFileSync(${JSON.stringify(join(scaffold.root, "launches.jsonl"))}, JSON.stringify({model}) + '\n');
if (model === 'no-such-provider-xyz/no-such-model') { console.error('Unknown provider'); process.exit(1); }
const dir = at('--session-dir'); fs.mkdirSync(dir, {recursive:true});
const sessionFile = path.join(dir, 'fixture.jsonl');
fs.writeFileSync(sessionFile, JSON.stringify({type:'session', version:3, id:'fixture', timestamp:new Date().toISOString(), cwd:process.cwd()}) + '\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const c = JSON.parse(line);
  if (c.type !== 'get_state' && c.type !== 'prompt') throw new Error('Unexpected RPC call: ' + c.type);
  console.log(JSON.stringify({type:'response', id:c.id, command:c.type, success:true,
    data:c.type === 'get_state' ? {sessionFile, sessionId:'fixture', isStreaming:false} : {}}));
  if (c.type === 'prompt') console.log(JSON.stringify({type:'agent_end', messages:[]}));
});
`, { mode: 0o755 });
    execFileSync(join(bin, "pi"), ["--version"], { env: scaffold.env, stdio: "pipe" });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  }, 120_000);

  afterAll(async () => {
    try {
      if (daemon) {
        for (const rig of rigs) await runRig(["down", rig, "--force", "--yes"], daemon.readEnv, rigBin);
      }
    } finally {
      if (daemon) await daemon.stop(); else scaffold?.cleanup();
      if (bin) rmSync(bin, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    { name: "unknown-provider", model: "no-such-provider-xyz/no-such-model", fails: true },
    { name: "nonexistent-model", model: "zai/no-such-model-xyz", fails: false },
    { name: "custom-model", model: "custom-provider/custom-model", fails: false },
  ])("$name: preserves native launch semantics and reports the outcome", async ({ name, model, fails }) => {
    if (!daemon) throw new Error("fixture daemon not started");
    // Given a configured model, with no catalog or model fact in the transcript.
    const cwd = join(scaffold.root, name);
    mkdirSync(cwd);
    mkdirSync(join(cwd, "agent"));
    writeFileSync(join(cwd, "agent", "agent.yaml"), 'name: fixture\nversion: "1.0.0"\nresources: {skills: []}\nprofiles: {default: {uses: {skills: []}}}\n');
    const spec = join(cwd, "rig.yaml");
    writeFileSync(spec, `version: "0.2"
name: ${name}
pods:
  - id: main
    label: Main
    members:
      - {id: seat, runtime: pi, agent_ref: "local:agent", profile: default, cwd: ., model: "${model}"}
    edges: []
edges: []
`);
    rigs.push(name);
    const plan = await runRig(["up", spec, "--plan", "--json"], daemon.readEnv, rigBin, 120_000);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout).status).toBe("planned");
    expect(plan.stdout).toContain("unverified");
    // When both output modes launch through the public CLI.
    for (const json of [false, true]) {
      const result = await runRig(["up", spec, "--yes", ...(json ? ["--json"] : [])], daemon.readEnv, rigBin, 120_000);
      const text = result.stdout + result.stderr;
      expect(text).not.toContain("unverified");
      // Then only the child's observed failure makes the launch unsuccessful.
      expect(result.code, text).toBe(fails ? 1 : 0);
      if (fails) {
        expect(text).toContain("main.seat");
        expect(text).toContain("pi launch failed: the runner exited (code 1)");
        expect(text).not.toContain("Status: completed");
      } else {
        expect(text).not.toMatch(/model-record-unavailable|invalid model|unknown model/i);
        expect(json ? JSON.parse(result.stdout).status : result.stdout).toContain("completed");
      }
      await runRig(["down", name, "--force", "--yes"], daemon.readEnv, rigBin);
    }
    const launched = readFileSync(join(scaffold.root, "launches.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
    expect(launched.filter(entry => entry.model === model)).toHaveLength(2);
  }, 120_000);
});
