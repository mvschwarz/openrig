import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { RigWithRelations } from "../src/domain/types.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// #1193: reuse the scenario harness with real CLI/daemon/SQLite/tmux. The YAML
// runner has no bound edge/remove/add verbs. Stub -> terminal replacement models
// the destructive cross-runtime workaround without contacting a model provider.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const agentDir = resolve(here, "../../test-system/scenarios/agents/worker");

describe("edge repair CLI journey", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  let rigId: string | undefined;
  let replacementPath: string;
  const repair = [
    { from: "orch.lead", to: "review.reviewer", kind: "delegates_to" },
    { from: "review.reviewer", to: "orch.lead", kind: "escalates_to" },
  ];

  async function cli(args: string[], json = true) {
    const result = await runRig(args, daemon!.readEnv, rigBin, 120_000);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return json ? JSON.parse(result.stdout) : result.stdout;
  }
  async function graph(): Promise<RigWithRelations> {
    const response = await fetch(`${daemon!.baseUrl}/api/rigs/${rigId}`);
    expect(response.status).toBe(200);
    return response.json();
  }
  function panes() {
    return execFileSync("tmux", ["-S", scaffold!.tmuxSocketPath, "list-panes", "-a", "-F",
      "#{session_name} #{pane_id} #{pane_pid} #{pane_dead}"], { env: scaffold!.env, encoding: "utf8" })
      .trim().split("\n").sort();
  }
  function identities(rig: RigWithRelations) {
    return rig.nodes.map((node) => ({
      id: node.id, logicalId: node.logicalId, runtime: node.runtime,
      bindingId: node.binding?.id, session: node.binding?.tmuxSession, pane: node.binding?.tmuxPane,
    })).sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  }

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    cpSync(agentDir, join(scaffold.root, "worker-agent"), { recursive: true });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    const member = (id: string) => {
      const cwd = join(scaffold!.root, id);
      mkdirSync(cwd);
      return { id, agent_ref: "local:worker-agent", profile: "default", runtime: "stub", cwd };
    };
    const specPath = join(scaffold.root, "edge-repair.yaml");
    writeFileSync(specPath, stringify({
      version: "0.2", name: "edge-repair",
      pods: [
        { id: "orch", label: "Orchestration", members: [member("lead"), member("observer")],
          edges: [{ from: "lead", to: "observer", kind: "can_observe" }] },
        { id: "review", label: "Review", members: [member("reviewer")], edges: [] },
      ],
      edges: repair,
    }));
    replacementPath = join(scaffold.root, "reviewer.yaml");
    writeFileSync(replacementPath, stringify({ member: {
      id: "reviewer", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal",
      cwd: join(scaffold.root, "reviewer"),
    } }));
    const up = await cli(["up", specPath, "--yes", "--json"]);
    rigId = up.rigId;
    expect(rigId).toBeTypeOf("string");
  }, 120_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); return; }
    try {
      if (rigId) await cli(["down", rigId, "--force", "--json"]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  it("repairs a replaced seat, retries without duplicates, and preserves live siblings and snapshots", async () => {
    const original = await graph();
    expect(original.edges).toHaveLength(3);
    const originalReviewer = original.nodes.find((n) => n.logicalId === "review.reviewer")!;
    const siblingIds = identities(original).filter((n) => n.logicalId !== "review.reviewer");
    const siblingPanes = panes().filter((line) => line.startsWith("orch-"));
    expect(siblingPanes).toHaveLength(2);
    expect(siblingPanes.every((line) => line.endsWith(" 0"))).toBe(true);

    await cli(["remove", rigId!, "review.reviewer", "--json"]);
    const added = await cli(["add", rigId!, "review", replacementPath, "--json"]);
    expect(added.result.node.status).toBe("launched");
    const replaced = await graph();
    expect(replaced.edges).toHaveLength(1);
    const reviewer = replaced.nodes.find((n) => n.logicalId === "review.reviewer")!;
    expect(reviewer.id).not.toBe(originalReviewer.id);
    expect(reviewer.runtime).toBe("terminal");
    expect(identities(replaced).filter((n) => n.logicalId !== "review.reviewer")).toEqual(siblingIds);
    expect(panes().filter((line) => line.startsWith("orch-"))).toEqual(siblingPanes);

    const edgeFile = join(scaffold!.root, "edges.yaml");
    writeFileSync(edgeFile, stringify({ edges: [...repair, repair[0]] }));
    const command = ["edge", "add", "edge-repair", "--file", edgeFile, "--json"];
    const beforePanes = panes();
    const planned = await cli([...command, "--plan"]);
    expect(planned.results.map((r: { outcome: string }) => r.outcome)).toEqual(["would_add", "would_add"]);
    expect((await graph()).edges).toEqual(replaced.edges);

    const fixed = await cli(command);
    expect(fixed.results.map((r: { outcome: string }) => r.outcome)).toEqual(["added", "added"]);
    const after = await graph();
    expect(after.edges).toHaveLength(3);
    expect(after.edges).toEqual(expect.arrayContaining(replaced.edges));
    const retry = await cli(command);
    expect(retry.results.map((r: { outcome: string }) => r.outcome)).toEqual(["present", "present"]);
    expect(retry.results.map((r: { edge: { id: string } }) => r.edge.id))
      .toEqual(fixed.results.map((r: { edge: { id: string } }) => r.edge.id));
    expect((await graph()).edges).toEqual(after.edges);
    expect(identities(await graph())).toEqual(identities(replaced));
    expect(panes()).toEqual(beforePanes);

    // A valid first entry followed by an invalid endpoint cannot partially apply.
    writeFileSync(edgeFile, stringify({ edges: [
      { from: "orch.observer", to: "review.reviewer", kind: "can_observe" },
      { from: "other.lead", to: "review.reviewer", kind: "delegates_to" },
    ] }));
    const refused = await runRig(command, daemon!.readEnv, rigBin);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: "node_not_found" });
    expect((await graph()).edges).toEqual(after.edges);

    const exportPath = join(scaffold!.root, "export.yaml");
    await cli(["export", rigId!, "-o", exportPath], false);
    expect(parse(readFileSync(exportPath, "utf8")).edges).toEqual(repair);
    await cli(["snapshot", rigId!], false);
    const snapshots = await (await fetch(`${daemon!.baseUrl}/api/rigs/${rigId}/snapshots`)).json();
    const snapshot = await (await fetch(`${daemon!.baseUrl}/api/rigs/${rigId}/snapshots/${snapshots[0].id}`)).json();
    expect(snapshot.data.edges).toEqual(after.edges);

    const rollbackId = fixed.results[0].edge.id;
    expect(await cli(["edge", "remove", rigId!, rollbackId, "--plan", "--json"]))
      .toMatchObject({ ok: true, outcome: "would_remove" });
    expect((await graph()).edges).toEqual(after.edges);
    expect(await cli(["edge", "remove", rigId!, rollbackId, "--json"]))
      .toMatchObject({ ok: true, outcome: "removed" });
    expect((await graph()).edges).toEqual(after.edges.filter((e) => e.id !== rollbackId));
    expect(identities(await graph())).toEqual(identities(replaced));
    expect(panes()).toEqual(beforePanes);
    // A saved snapshot is immutable; edge-only writes do not rewrite history.
    const saved = await (await fetch(`${daemon!.baseUrl}/api/rigs/${rigId}/snapshots/${snapshots[0].id}`)).json();
    expect(saved.data.edges).toEqual(after.edges);
  }, 120_000);
});
