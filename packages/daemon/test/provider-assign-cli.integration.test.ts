import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon } from "./helpers/scenario-daemon.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

// #3625 slices 3 and 4: the compiled CLI plans and applies an account assignment to a two-seat rig on a private daemon and
// tmux server, and status reads each seat against it. Only Claude is synthetic: the switch, snapshots, relaunch and resume
// are production code.
it.skipIf(process.platform === "win32")("compiled provider assign plans, then applies, moving both seats and keeping both conversations", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");
  let daemon: Awaited<ReturnType<typeof spawnScenarioDaemon>> | undefined;
  let db: Database.Database | undefined;
  const tmux = (...args: string[]) => execFileSync("tmux", args, { env: scaffold.env, encoding: "utf8", stdio: "pipe" }).trim();
  const until = async (predicate: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`synthetic provider did not settle: ${what}`);
  };
  try {
    const binary = join(scaffold.root, "bin", "claude");
    execFileSync("cc", [fileURLToPath(new URL("fixtures/provider-switch-claude.c", import.meta.url)), "-o", binary, `-DFIXTURE_NODE=${JSON.stringify(process.execPath)}`,
      `-DFIXTURE_RELAY=${JSON.stringify(fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url)))}`]);
    // The seats start on one token; the assignment moves them to "plan", which the synthetic Claude reports as AUTH:plan.
    const startFile = join(scaffold.root, "start-token"), planFile = join(scaffold.root, "plan-token");
    writeFileSync(startFile, "synthetic-start", { mode: 0o600 }); writeFileSync(planFile, "synthetic-plan", { mode: 0o600 });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin, timeoutMs: 60_000 });
    db = new Database(join(scaffold.stateDir, "scenario.db")); db.pragma("busy_timeout = 5000");
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const rig = rigs.createRig("assign-fixture");
    const launches = () => { try { return readFileSync(join(scaffold.openrigHome, "provider-launches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };

    const seats: Array<{ seat: string; pane: string; conversation: string; marker: string; home: string }> = [];
    for (const name of ["alpha", "beta"]) {
      const home = join(scaffold.root, `config-${name}`); mkdirSync(home);
      const node = rigs.addNode(rig.id, `work.${name}`, { runtime: "claude-code", cwd: scaffold.root, model: "fixture-model", restorePolicy: "resume_if_possible" });
      rigs.setNodeClaudeTokenRef(node.id, { label: "start", tokenFile: startFile });
      db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(home, node.id);
      new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "acceptEdits" }, "fixture", "fixture launch mode");
      const seat = `r00-assign-fixture-work_${name}`, conversation = randomUUID();
      tmux("new-session", "-d", "-s", seat, "exec /bin/bash --noprofile --norc");
      const pane = tmux("display-message", "-p", "-t", seat, "#{pane_id}");
      const session = sessions.registerSession(node.id, seat);
      sessions.updateStatus(session.id, "running"); sessions.updateResumeToken(session.id, "claude_id", conversation, "operator");
      sessions.updateStartupStatus(session.id, "ready"); sessions.updateBinding(node.id, { tmuxSession: seat, tmuxPane: pane });
      for (const [key, value] of Object.entries({ OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: seat, OPENRIG_RUNTIME: "claude-code",
        OPENRIG_OCCUPANT_GENERATION: sessions.currentOccupantTenure(node.id)!.generationUuid })) tmux("set-environment", "-t", seat, key, value);
      const before = launches().length;
      tmux("send-keys", "-t", pane, "-l", `export CLAUDE_CONFIG_DIR=${shellQuote(home)}; export CLAUDE_CODE_OAUTH_TOKEN=$(/bin/cat ${shellQuote(startFile)}); `
        + `${shellQuote(binary)} --resume ${conversation} --model fixture-model --permission-mode acceptEdits`);
      tmux("send-keys", "-t", pane, "Enter");
      await until(() => launches().length === before + 1, `${name} launched`);
      const marker = randomUUID();
      tmux("send-keys", "-t", pane, "-l", `remember:${marker}`); tmux("send-keys", "-t", pane, "Enter");
      await until(() => { try { return readFileSync(join(home, `fixture-conversation-${conversation}`), "utf8") === marker; } catch { return false; } }, `${name} remembered`);
      seats.push({ seat, pane, conversation, marker, home });
    }
    expect(launches().map((l) => l.auth)).toEqual(["other", "other"]);

    const rigCli = (args: string[]) => runRig(args, daemon!.readEnv, rigBin, 180_000);
    const ok = async (args: string[]) => { const r = await rigCli(args); expect(r.code, JSON.stringify(r)).toBe(0); return JSON.parse(r.stdout); };
    await ok(["provider", "account", "add", "plan", "--provider", "claude", "--token-file", planFile, "--json"]);
    const assign = ["provider", "assign", rig.name, "--provider", "claude", "--account", "plan", "--include-overrides"];

    // The plan: both seats would change, each with its own account home shown as the choice it overrides.
    const planned = await ok([...assign, "--json"]);
    expect(planned.plan.rows.map((r: { seat: string; effect: string }) => [r.seat, r.effect])).toEqual(seats.map((s) => [s.seat, "change"]));
    expect(planned.plan.rows.every((r: { precheck: { safe: boolean } }) => r.precheck.safe)).toBe(true);
    expect(launches()).toHaveLength(2);

    // A digest that isn't the plan's is refused, and nothing moves.
    const stale = await rigCli([...assign, "--apply", "--plan", "000000000000", "--json"]);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ ok: false, code: "plan_changed", digest: planned.plan.digest });
    expect(launches()).toHaveLength(2);

    const applied = await ok([...assign, "--apply", "--plan", planned.plan.digest, "--json"]);
    expect(applied.report.results.map((r: { seat: string; kind: string }) => [r.seat, r.kind])).toEqual(seats.map((s) => [s.seat, "switched"]));
    await until(() => launches().length === 4, "both relaunched");
    for (const [i, s] of seats.entries()) {
      expect(launches().find((l) => l.conversation === s.conversation && l.auth === "plan"), `launch ${i}`).toMatchObject({ remembered: true, model: "fixture-model", permission: "acceptEdits" });
      expect(tmux("display-message", "-p", "-t", s.seat, "#{pane_id}")).toBe(s.pane);
      tmux("send-keys", "-t", s.pane, "probe", "Enter");
      await until(() => tmux("capture-pane", "-p", "-t", s.pane).includes(`MEMORY:${s.marker} AUTH:plan`), `${s.seat} probe`);
    }

    // Read back: the rig's assignment, each seat's result, and the label in use.
    const after = await ok([...assign, "--json"]);
    expect(after.plan.intent).toMatchObject({ label: "plan" });
    expect(after.plan.rows.map((r: { effect: string; lastResult?: { kind: string } }) => [r.effect, r.lastResult?.kind])).toEqual([["unchanged", "switched"], ["unchanged", "switched"]]);
    const removal = await rigCli(["provider", "account", "remove", "plan", "--provider", "claude"]);
    expect(removal.code).toBe(1);
    expect(removal.stderr + removal.stdout).toContain(`rig ${rig.name} (claude)`);

    // #3625 slice 4: status reads both seats as following the rig's assignment.
    type Binding = { seatSession: string; assignment?: { state: string; intended: { label: string } | null; applied: { kind: string } | null; override?: string } };
    const statusOf = async () => Object.fromEntries(((await ok(["provider", "status", "--json"])).bindings as Binding[]).map((b) => [b.seatSession, b.assignment]));
    const [alpha, beta] = seats as [typeof seats[0], typeof seats[0]];
    expect(await statusOf()).toMatchObject({
      [alpha.seat]: { state: "follows", intended: { label: "plan" }, applied: { kind: "switched" } },
      [beta.seat]: { state: "follows", intended: { label: "plan" }, applied: { kind: "switched" } },
    });
    // beta is switched back to its first token by hand: status reads it as the seat's own choice, and alpha still follows.
    const manual = await ok(["provider", "switch", "--seat", beta.seat, "--to-account", "start", "--token-file", startFile, "--json"]);
    expect(manual).toMatchObject({ outcome: "rebind_in_progress" });
    await until(() => launches().length === 5, "beta relaunched by hand");
    const status = await statusOf();
    expect(status[alpha.seat]).toMatchObject({ state: "follows" });
    // A Claude seat's token is what its launch uses, so it's named, not the config dir the person didn't touch.
    expect(status[beta.seat]).toMatchObject({ state: "override", override: `its own token file ${startFile} ("start")`, applied: { kind: "switched" } });
    const human = await rigCli(["provider", "status"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`this seat is configured with its own choice: its own token file ${startFile} ("start")`);
    expect(JSON.stringify([planned, applied, after, status, human.stdout])).not.toMatch(/synthetic-(start|plan)/);
  } finally {
    db?.close();
    if (daemon) await daemon.stop(); else scaffold.cleanup();
  }
}, 300_000);
