import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon } from "./helpers/scenario-daemon.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

// The compiled CLI talks to a private daemon and tmux server. Only Claude itself is synthetic;
// snapshots, process witnesses, cutover, credential loading and resume are production code.
it.skipIf(process.platform === "win32")("compiled provider switch resumes plan → API → plan through real daemon and tmux", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");
  let daemon: Awaited<ReturnType<typeof spawnScenarioDaemon>> | undefined;
  let db: Database.Database | undefined;
  const tmux = (...args: string[]) => execFileSync("tmux", args, { env: scaffold.env, encoding: "utf8", stdio: "pipe" }).trim();
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error("synthetic provider did not settle");
  };
  try {
    const binary = join(scaffold.root, "bin", "claude");
    execFileSync("cc", [fileURLToPath(new URL("fixtures/provider-switch-claude.c", import.meta.url)), "-o", binary, `-DFIXTURE_NODE=${JSON.stringify(process.execPath)}`,
      `-DFIXTURE_RELAY=${JSON.stringify(fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url)))}`]);
    const selected = join(scaffold.root, "account"); mkdirSync(selected);
    const planFile = join(scaffold.root, "plan-token"), apiFile = join(scaffold.root, "api-key");
    writeFileSync(planFile, "synthetic-plan", { mode: 0o600 }); writeFileSync(apiFile, "synthetic-api", { mode: 0o600 });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin, timeoutMs: 60_000 });
    db = new Database(join(scaffold.stateDir, "scenario.db")); db.pragma("busy_timeout = 5000");
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const rig = rigs.createRig("provider-switch-fixture");
    const node = rigs.addNode(rig.id, "work.worker", { runtime: "claude-code", cwd: scaffold.root, model: "fixture-model", restorePolicy: "resume_if_possible" });
    rigs.setNodeClaudeTokenRef(node.id, { label: "plan", tokenFile: planFile });
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(selected, node.id);
    new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "acceptEdits" }, "fixture", "fixture launch mode");
    const seat = "r00-provider-switch-fixture-work_worker", conversation = randomUUID();
    tmux("new-session", "-d", "-s", seat, "exec /bin/bash --noprofile --norc");
    const pane = tmux("display-message", "-p", "-t", seat, "#{pane_id}");
    const session = sessions.registerSession(node.id, seat);
    sessions.updateStatus(session.id, "running"); sessions.updateResumeToken(session.id, "claude_id", conversation, "operator");
    sessions.updateStartupStatus(session.id, "ready"); sessions.updateBinding(node.id, { tmuxSession: seat, tmuxPane: pane });
    for (const [key, value] of Object.entries({ OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: seat, OPENRIG_RUNTIME: "claude-code",
      OPENRIG_OCCUPANT_GENERATION: sessions.currentOccupantTenure(node.id)!.generationUuid })) tmux("set-environment", "-t", seat, key, value);
    const initial = `export CLAUDE_CONFIG_DIR=${shellQuote(selected)}; export CLAUDE_CODE_OAUTH_TOKEN=$(/bin/cat ${shellQuote(planFile)}); ${shellQuote(binary)} --resume ${conversation} --model fixture-model --permission-mode acceptEdits`;
    tmux("send-keys", "-t", pane, "-l", initial); tmux("send-keys", "-t", pane, "Enter");
    const launches = () => { try { return readFileSync(join(scaffold.openrigHome, "provider-launches.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } };
    await until(() => launches().length === 1);
    const marker = randomUUID();
    tmux("send-keys", "-t", pane, "-l", `remember:${marker}`); tmux("send-keys", "-t", pane, "Enter");
    await until(() => { try { return readFileSync(join(selected, `fixture-conversation-${conversation}`), "utf8") === marker; } catch { return false; } });
    const cli = async (args: string[]) => {
      const result = await runRig(args, daemon!.readEnv, rigBin, 60_000);
      expect(result.code, JSON.stringify(result)).toBe(0); return JSON.parse(result.stdout);
    };
    const refused = await runRig(["provider", "switch", "--seat", seat, "--to-account", "missing", "--api-key-file", join(scaffold.root, "missing-key"), "--json"], daemon.readEnv, rigBin);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ outcome: "failed_safely", reasons: ["token_file_unusable"] });
    expect(launches()).toHaveLength(1);
    const switched = await cli(["provider", "switch", "--seat", seat, "--to-account", "api", "--api-key-file", apiFile, "--json"]);
    expect(switched).toMatchObject({ outcome: "rebind_in_progress", seat: { conversation, credentialKind: "api-key", restart: { outcome: "resumed" } } });
    await until(() => launches().length === 2);
    expect(launches()[1]).toMatchObject({ conversation, auth: "api", model: "fixture-model", permission: "acceptEdits", remembered: true });
    expect(tmux("display-message", "-p", "-t", seat, "#{pane_id}")).toBe(pane);
    const argv = execFileSync("ps", ["-p", String(launches()[1].pid), "-o", "command="], { encoding: "utf8" });
    expect(argv).not.toMatch(/synthetic-(api|plan)/);
    tmux("send-keys", "-t", pane, "probe", "Enter");
    await until(() => tmux("capture-pane", "-p", "-t", pane).includes(`MEMORY:${marker} AUTH:api`));
    await until(() => sessions.getSessionsForRig(rig.id).some(s => s.status === "running" && s.resumeToken === conversation));
    const stopped = await cli(["down", rig.name, "--snapshot", "--force", "--json"]);
    expect(stopped.snapshotId).toBeTruthy();
    const restored = await cli(["up", rig.name, "--existing", "--yes", "--json"]);
    expect(restored.status).toBe("restored");
    await until(() => launches().length === 3);
    expect(launches()[2]).toMatchObject({ conversation, auth: "api", remembered: true });
    const status = await cli(["seat", "status", seat, "--json"]);
    expect(status.session_status).toBe("running");
    expect(status.runtime_home).toMatchObject({ home: selected, source: "account-switch" });
    expect(status.claude_token).toMatchObject({ kind: "api-key", label: "api" });
    const back = await cli(["provider", "switch", "--seat", seat, "--to-account", "plan", "--token-file", planFile, "--json"]);
    expect(back).toMatchObject({ outcome: "rebind_in_progress", seat: { conversation, restart: { outcome: "resumed" } } });
    await until(() => launches().length === 4);
    expect(launches()[3]).toMatchObject({ conversation, auth: "plan", remembered: true, model: "fixture-model", permission: "acceptEdits" });
    const paneBeforeFailure = tmux("display-message", "-p", "-t", seat, "#{pane_id}");
    // Lose the key only once precheck has succeeded and the old process receives TERM.
    writeFileSync(join(scaffold.openrigHome, `remove-key-on-stop-${launches()[3].pid}`), "");
    const interrupted = await runRig(["provider", "switch", "--seat", seat, "--to-account", "api", "--api-key-file", apiFile, "--json"], daemon.readEnv, rigBin, 60_000);
    expect(interrupted.code, JSON.stringify(interrupted)).toBe(1);
    const recovery = JSON.parse(interrupted.stdout);
    expect(recovery, JSON.stringify(recovery)).toMatchObject({ outcome: "unknown", seat: { restart: { recoveryCommand: expect.stringContaining("--snapshot-id"), remainingStep: expect.stringContaining("rig seat stop") } } });
    expect(launches()).toHaveLength(4);
    expect(existsSync(apiFile)).toBe(false);
    writeFileSync(apiFile, "synthetic-api", { mode: 0o600 });
    // Failed in-place resume preserves the reused pane; follow the reported stop-before-recovery step.
    expect(tmux("display-message", "-p", "-t", seat, "#{pane_id}")).toBe(paneBeforeFailure);
    expect(sessions.getSessionsForRig(rig.id).filter(row => row.nodeId === node.id && ["running", "idle", "unknown"].includes(row.status))).toEqual([]);
    await cli(["seat", "stop", seat, "--reason", "retire failed resume shell before snapshot recovery", "--json"]);
    // Follow the exact recovery command returned by the switch, with JSON output for assertions.
    const recoveryArgs = recovery.seat.restart.recoveryCommand.split(" ").slice(1);
    await cli([...recoveryArgs, "--json"]);
    await until(() => launches().length === 5);
    expect(launches()[4]).toMatchObject({ conversation, auth: "api", remembered: true, model: "fixture-model", permission: "acceptEdits" });
    const recoveredStatus = await cli(["seat", "status", seat, "--json"]);
    expect(recoveredStatus.runtime_home).toMatchObject({ home: selected, source: "account-switch" });
    expect(recoveredStatus.claude_token).toMatchObject({ kind: "api-key", label: "api" });
    const recoveredPane = tmux("display-message", "-p", "-t", seat, "#{pane_id}");
    tmux("send-keys", "-t", recoveredPane, "probe", "Enter");
    await until(() => tmux("capture-pane", "-p", "-t", recoveredPane).includes(`MEMORY:${marker} AUTH:api`));
    expect(JSON.stringify([switched, back, recovery])).not.toMatch(/synthetic-(api|plan)/);
  } finally {
    db?.close();
    if (daemon) await daemon.stop(); else scaffold.cleanup();
  }
}, 180_000);
