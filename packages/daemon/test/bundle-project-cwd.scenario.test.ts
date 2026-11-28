// Model-free installed-path scenario. The generic YAML scenario runner passes a
// global --cwd, so it cannot exercise per-member bundle cwd resolution.
// Use its hermetic daemon/tmux helpers and the actual bundle-install CLI instead.
import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { pack } from "../src/domain/bundle-archive.js";
import { computeIntegrity } from "../src/domain/bundle-integrity.js";

it("a real bundle install starts both terminal seats in their carried project folders on the first launch", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" } });
  let daemon: ScenarioDaemon | undefined;
  try {
    const staging = path.join(scaffold.root, "bundle");
    const projects = path.join(scaffold.root, "$HOME projects"), catalog = path.join(scaffold.root, "catalog.yaml");
    const target = path.join(scaffold.root, "selected install");
    scaffold.env.OPENRIG_WORKSPACE_ROOT = path.join(scaffold.root, "workspace");
    scaffold.env.OPENRIG_WORKSPACE_PROJECTS_ROOT = projects;
    scaffold.env.OPENRIG_WORKSPACE_CATALOG_PATH = catalog;
    for (const name of ["api", "ui"]) {
      fs.mkdirSync(path.join(staging, "project", name), { recursive: true });
      fs.writeFileSync(path.join(staging, "project", name, "marker"), name);
    }
    fs.writeFileSync(path.join(staging, "project", "project.yaml"), "schema: openrig.project/v0alpha1\nid: demo\n");
    fs.writeFileSync(path.join(staging, "rig.yaml"), `version: "0.2"\nname: bundle-cwd-scenario\npods:\n  - id: dev\n    label: Dev\n    members:\n      - {id: api, agent_ref: "builtin:terminal", profile: none, runtime: terminal, cwd: "\${project:demo}/api"}\n      - {id: ui, agent_ref: "builtin:terminal", profile: none, runtime: terminal, cwd: "\${project:demo}/ui"}\n    edges: []\nedges: []\n`);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)).map(p => e.name + "/" + p) : [e.name]);
    const integrity = computeIntegrity(staging, { readFile: p => fs.readFileSync(p, "utf8"), readFileBuffer: fs.readFileSync, exists: fs.existsSync, walkFiles: walk } as Parameters<typeof computeIntegrity>[1]);
    fs.writeFileSync(path.join(staging, "bundle.yaml"), `schema_version: 2\nname: bundle-cwd-scenario\nversion: "0.1.0"\ncreated_at: "2026-11-25T00:00:00Z"\nrig_spec: rig.yaml\nagents: []\nproject: {id: demo, path: project}\nintegrity:\n  algorithm: ${integrity.algorithm}\n  files:\n${Object.entries(integrity.files).map(([f, h]) => "    " + f + ": " + h).join("\n")}\n`);
    const bundle = path.join(scaffold.root, "demo.rigbundle"); await pack(staging, bundle);
    const hash = () => createHash("sha256").update(fs.readFileSync(bundle)).digest("hex"); const before = hash();
    const rigBin = path.resolve(import.meta.dirname, "../../cli/dist/bin-wrapper.js");
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    const installed = await runRig(["bundle", "install", bundle, "--target", target, "--yes", "--json"], daemon.readEnv, rigBin, 120_000);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const paneIds = execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "list-panes", "-a", "-F", "#{pane_id}"], { env: daemon.readEnv, encoding: "utf8" }).trim().split("\n");
    // Read the shell's real cwd: tmux 3.4 escapes '$' in pane_current_path's format output.
    const panes = (await Promise.all(paneIds.map(async (pane, index) => {
      const receipt = path.join(scaffold.root, `pane-cwd-${index}.txt`);
      execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "send-keys", "-t", pane, "-l", `pwd -P > ${shellQuote(receipt)}`], { env: daemon.readEnv });
      execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "send-keys", "-t", pane, "Enter"], { env: daemon.readEnv });
      await vi.waitFor(() => expect(fs.readFileSync(receipt, "utf8").trimEnd()).not.toBe(""), { timeout: 20_000 });
      return fs.readFileSync(receipt, "utf8").trimEnd();
    }))).sort();
    expect(panes).toEqual(["api", "ui"].map(name => fs.realpathSync(path.join(projects, "demo", name))).sort());
    expect(fs.readFileSync(path.join(panes[0]!, "marker"), "utf8")).toBe("api");
    expect(fs.readFileSync(path.join(panes[1]!, "marker"), "utf8")).toBe("ui");
    expect(fs.existsSync(path.join(target, "${project:demo}"))).toBe(false);
    expect(hash()).toBe(before);
    const down = await runRig(["down", "bundle-cwd-scenario", "--json"], daemon.readEnv, rigBin, 120_000);
    expect(down.code, down.stdout + down.stderr).toBe(0);
  } finally {
    if (daemon) await daemon.stop(); else scaffold.cleanup();
  }
}, 180_000);
