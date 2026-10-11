import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { listNativeProcesses, observeClaudeDelivery } from "../src/domain/native-process-lineage.js";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig } from "./helpers/scenario-daemon.js";

// Real daemon, CLI, SQLite and private tmux server. The scripted process exits
// normally on /exit; this checks pane preservation, not provider authentication.
// process.title / foreground-process evidence here is bound to Linux.
it.runIf(process.platform === "linux")("launch does not call an exited agent already running in its preserved shell", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");
  let daemon: Awaited<ReturnType<typeof spawnScenarioDaemon>> | undefined;
  let db: Database.Database | undefined;
  let shellPid: number | undefined;
  const tmux = (...args: string[]) => execFileSync("tmux", args, { env: scaffold.env, encoding: "utf8" }).trim();
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("fixture did not settle");
  }
  try {
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    db = new Database(join(scaffold.stateDir, "scenario.db"));
    db.pragma("busy_timeout = 5000");
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const rig = rigs.createRig("launch-exit");
    const node = rigs.addNode(rig.id, "dev.build", { role: "build", runtime: "claude-code" });
    const name = "dev-build@launch-exit";
    tmux("new-session", "-d", "-s", name, "exec /bin/bash --noprofile --norc");
    const pane = tmux("display-message", "-p", "-t", name, "#{pane_id}");
    shellPid = Number(tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
    const ready = join(scaffold.root, "agent.pid");
    const script = join(scaffold.root, "agent.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
process.title='claude'; writeFileSync(${JSON.stringify(ready)},String(process.pid));
createInterface({input:process.stdin}).on('line',line=>{if(line==='/exit')process.exit(0);});\n`);
    tmux("send-keys", "-t", pane, `node '${script}'`, "Enter");
    await until(() => existsSync(ready) && tmux("display-message", "-p", "-t", pane, "#{pane_current_command}") === "claude");
    const agentPid = Number(readFileSync(ready, "utf8"));
    const session = sessions.registerSession(node.id, name);
    sessions.updateStatus(session.id, "running");
    sessions.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane });
    const snapshot = new SnapshotRepository(db).createSnapshot(rig.id, "manual", {
      rig: { id: rig.id, name: rig.name }, nodes: rigs.getRig(rig.id)!.nodes,
      sessions: sessions.getSessionsForRig(rig.id), edges: [], checkpoints: {},
    } as any);
    const args = ["launch", rig.id, "--seats", node.logicalId, "--snapshot-id", snapshot.id, "--json"];
    const live = await runRig(args, daemon.readEnv, rigBin);
    expect(live.code, JSON.stringify(live)).toBe(0);
    expect(JSON.parse(live.stdout).alreadyRunning).toEqual([{ nodeId: node.id, logicalId: node.logicalId }]);

    tmux("send-keys", "-t", pane, "/exit", "Enter");
    await until(() => {
      try { process.kill(agentPid, 0); return false; } catch { return true; }
    });
    expect(tmux("display-message", "-p", "-t", pane, "#{pane_current_command}")).toBe("bash");
    const observed = await observeClaudeDelivery({ target: pane, tmux: { getPanePid: async (target) => Number(tmux("display-message", "-p", "-t", target, "#{pane_pid}")) } });
    const rows = await listNativeProcesses();
    const root = rows.find(row => row.pid === shellPid);
    expect(observed.state, JSON.stringify({ observed, root, children: rows.filter(row => row.ppid === shellPid || row.pgid === root?.tpgid), binding: sessions.getBindingForNode(node.id), node: rigs.getRig(rig.id)!.nodes[0] })).toBe("idle_shell");
    const exited = await runRig(args, daemon.readEnv, rigBin);
    console.log("EXITED_AGENT_RECEIPT", JSON.stringify({ live, exited, pane, agentPid }));
    expect(exited.code, JSON.stringify(exited)).not.toBe(0);
    const result = JSON.parse(exited.stdout);
    expect(result.ok).toBe(false);
    expect(result.alreadyRunning ?? []).toEqual([]);
    expect(JSON.stringify(result)).toMatch(/session alive, agent not running/i);
    const human = await runRig(args.filter(a => a !== "--json"), daemon.readEnv, rigBin);
    expect(human.code).not.toBe(0);
    expect(human.stderr).toMatch(/session alive, agent not running/i);
    expect(human.stderr).toContain("restart the agent");
    expect(human.stdout).not.toMatch(/Already running|Launched:/);
    expect(tmux("display-message", "-p", "-t", pane, "#{pane_current_command}")).toBe("bash");
  } finally {
    db?.close();
    try {
      if (shellPid) {
        // Let the preserved fixture shell finish its exit/history writes before
        // the helper removes HOME. No production pane is touched by this test.
        tmux("kill-session", "-t", "=dev-build@launch-exit");
        await until(() => {
          try { process.kill(shellPid!, 0); return false; } catch { return true; }
        });
      }
    } finally {
      if (daemon) await daemon.stop(); else scaffold.cleanup();
    }
  }
}, 60_000);
