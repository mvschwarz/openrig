import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// Real CLI/daemon/SQLite/tmux with two scripted agents. These journeys exercise
// ordinary user commands; they do not model a provider prompt or input consumption.
// Reuse one private fixture to keep the PR cost bounded. Each assertion uses its
// own marker/selector. The stream and cwd cases restart this fixture's daemon.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const library = resolve(here, "../../test-system/scenarios");

describe("stub CLI journeys", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  const launchedRigs: string[] = [];
  const sender = "work-worker@rig-alpha";
  const recipient = "work-worker@rig-beta";

  async function cli(args: string[]) {
    const result = await runRig(args, { ...daemon!.readEnv, OPENRIG_SESSION_NAME: sender }, rigBin);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout);
  }

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    for (const name of ["alpha", "beta"]) {
      const cwd = join(scaffold.root, name);
      mkdirSync(cwd);
      const result = await runRig(["up", join(library, `rig-${name}-stub.yaml`), "--cwd", cwd, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(result.code, JSON.stringify({ name, ...result })).toBe(0);
      launchedRigs.push(`rig-${name}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); return; }
    try {
      // Stop the launched seats while their daemon can still coordinate teardown.
      // Removing the scratch tree with live rigs can race their final writes.
      for (const rig of launchedRigs) await cli(["down", rig, "--json", "--force"]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  it.each(["normal", "narrow soft-wrap"])("verified send renders in the addressed pane and not its sibling: %s", async (mode) => {
    if (mode === "narrow soft-wrap") {
      execFileSync("tmux", ["-S", scaffold!.tmuxSocketPath, "resize-window", "-t", `=${recipient}:`, "-x", "42", "-y", "40"], { env: scaffold!.env });
    }
    // A long token forces real mid-word terminal wrapping, not just modeled newlines.
    const marker = `verified-send-${randomUUID()}` + (mode === "narrow soft-wrap" ? "-" + "x".repeat(100) + " tail" : "");
    const receipt = await cli(["send", recipient, marker, "--verify", "--json"]);
    expect(receipt.verified).toBe(true);
    const target = await cli(["capture", recipient, "--json"]);
    const sibling = await cli(["capture", sender, "--json"]);
    if (mode === "narrow soft-wrap") expect(JSON.stringify(target)).not.toContain(marker);
    expect(JSON.stringify(target).replace(/\\n/g, "")).toContain(marker);
    expect(JSON.stringify(sibling).replace(/\\n/g, "")).not.toContain(marker);
    // Pane rendering is the contract here. The stub has no consuming input loop.
  }, 60_000);

  it("keeps the current-rig view exact while explicit scopes reach the other live rig", async () => {
    const all = await cli(["ps", "--nodes", "--all-rigs", "--json"]);
    expect(all.map((n: { canonicalSessionName: string }) => n.canonicalSessionName).sort()).toEqual([sender, recipient]);
    for (const [rig, seat] of [["rig-alpha", sender], ["rig-beta", recipient]]) {
      const nodes = await cli(["ps", "--nodes", "--rig", rig, "--json"]);
      expect(nodes.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([seat]);
      expect(nodes[0].sessionStatus).toBe("running");
    }
    const current = await cli(["ps", "--nodes", "--json"]);
    expect(current.entries.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([sender]);
    expect(current.scope).toMatchObject({ rig: "rig-alpha", rigsOnHost: 2 });
    // Exact arrays, not subset matches: an extra sibling is a failure.
  }, 60_000);

  it("hold mode retains a CLI send outside its pane and exposes its original ID", async () => {
    const marker = `typing-guard-${randomUUID()}`;
    try {
      const preference = await cli(["seat", "set-typing-guard", recipient, "--mode", "hold", "--reason", "fixture manual input", "--json"]);
      expect(preference).toMatchObject({ effective: true, effectiveMode: "hold", pending: false });
      const receipt = await cli(["send", recipient, marker, "--verify", "--json"]);
      expect(receipt).toMatchObject({ outcome: "retained", sent: false, verified: false });
      expect(receipt.outboxIds).toHaveLength(1);
      const id = receipt.outboxIds[0];
      const retained = await cli(["seat", "held-messages", recipient, "--id", id, "--json"]);
      expect(retained.entry).toMatchObject({ outboxId: id, deliveryState: "retained", destinationSession: recipient });
      expect(retained.entry.body).toContain(marker);
      expect(JSON.stringify(await cli(["capture", recipient, "--json"]))).not.toContain(marker);
      expect(await cli(["seat", "status", sender, "--json"])).toMatchObject({ typingGuard: { effective: false, effectiveMode: "off" } });
    } finally {
      await cli(["seat", "set-typing-guard", recipient, "--enabled", "false", "--reason", "fixture cleanup", "--json"]);
    }
  }, 60_000);

  it("replays one exact stream item after restart and an idempotent emit retry", async () => {
    const id = `journey-${randomUUID()}`;
    const tag = `journey-tag-${randomUUID()}`;
    const body = `durable-body-${randomUUID()}`;
    const emit = ["stream", "emit", "--source", sender, "--id", id, "--body", body, "--hint-tags", tag, "--json"];
    const item = await cli(emit);
    expect(item).toMatchObject({ streamItemId: id, sourceSession: sender, body });
    await cli(["stream", "emit", "--source", recipient, "--body", "unrelated-stream-control", "--json"]);
    const read = () => cli(["stream", "list", "--tag", tag, "--json"]);
    expect(await read()).toEqual([item]);
    await daemon!.restart();
    expect(await read()).toEqual([item]);
    expect(await cli(emit)).toEqual(item);
    expect(await read()).toEqual([item]);
    // Durable CLI replay, not an SSE/live-watch or stub-activity-hook claim.
  }, 60_000);

  it("changes one seat's future cwd, preserving its live process and durable work until a fresh launch", async () => {
    const before = (await cli(["ps", "--nodes", "--rig", "rig-beta", "--json", "--full"]))[0];
    expect(before.nodeId).toEqual(expect.any(String));
    const destination = join(realpathSync(scaffold!.root), "relocated worker");
    const oldNotes = join(before.cwd, "operator-notes.txt");
    writeFileSync(oldNotes, "Keep shared workspace notes.\n");
    // tmux can sanitize control characters in formats; use a printable separator.
    const pane = () => execFileSync("tmux", ["-S", scaffold!.tmuxSocketPath, "list-panes",
      "-t", `=${recipient}:`, "-F", "#{pane_current_path}|#{pane_pid}"], { encoding: "utf8" }).trim().split("|");
    const oldPane = pane();
    expect(oldPane[0]).toBe(realpathSync(before.cwd));
    const qitemId = `cwd-${randomUUID()}`;
    await cli(["queue", "create", "--destination", recipient, "--id", qitemId,
      "--body", "Retain this work across directory changes", "--summary", "Directory continuity fixture", "--no-nudge", "--json"]);
    const db = new Database(join(scaffold!.stateDir, "scenario.db"), { readonly: true });
    try {
      const queue = () => db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId);
      const sessions = () => db.prepare("SELECT id, session_name, status FROM sessions WHERE node_id = ? ORDER BY id").all(before.nodeId);
      const originalQueue = queue();
      const originalSessions = sessions();
      expect(originalQueue).toBeDefined();
      expect(originalSessions).toHaveLength(1);
      const changed = await cli(["seat", "set-cwd", recipient, "--cwd", destination, "--reason", "isolate workspace", "--json"]);
      expect(changed).toMatchObject({ ok: true, changed: true, from: before.cwd, to: destination, effect: "next_launch" });
      expect(pane()).toEqual(oldPane);
      expect(sessions()).toEqual(originalSessions);
      expect(queue()).toEqual(originalQueue);
      expect(await cli(["seat", "status", recipient, "--json"])).toMatchObject({ launch_cwd: destination, current_occupant: recipient });
      expect((await cli(["ps", "--nodes", "--rig", "rig-alpha", "--json", "--full"]))[0].cwd).toBe(join(scaffold!.root, "alpha"));

      await daemon!.restart();
      expect(await cli(["seat", "status", recipient, "--json"])).toMatchObject({ launch_cwd: destination });
      expect(pane()).toEqual(oldPane);
      const launched = await cli(["seat", "launch", recipient, "--fresh", "--stop", "--reason", "use selected directory", "--json"]);
      expect(launched).toMatchObject({ ok: true, sessionName: recipient });
      expect(pane()[0]).toBe(destination);
      expect(pane()[1]).not.toBe(oldPane[1]);
      expect((await cli(["ps", "--nodes", "--rig", "rig-beta", "--json", "--full"]))[0]).toMatchObject({ nodeId: before.nodeId, cwd: destination });
      expect(sessions()).toHaveLength(originalSessions.length + 1);
      expect(sessions().map(row => (row as { id: string }).id)).toEqual(expect.arrayContaining(originalSessions.map(row => (row as { id: string }).id)));
      expect(queue()).toEqual(originalQueue);
      expect(readFileSync(oldNotes, "utf8")).toBe("Keep shared workspace notes.\n");

      const invalid = await runRig(["seat", "set-cwd", recipient, "--cwd", "relative/path", "--reason", "invalid fixture", "--json"], daemon!.readEnv, rigBin);
      expect(invalid.code).toBe(1);
      expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, code: "invalid_cwd" });
      expect(await cli(["seat", "status", recipient, "--json"])).toMatchObject({ launch_cwd: destination });
    } finally { db.close(); }
  }, 120_000);
});
