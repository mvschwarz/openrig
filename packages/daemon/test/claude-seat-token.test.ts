import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { claudeSeatTokenStep } from "../src/domain/claude-seat-token.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { createFullTestDb } from "./helpers/test-app.js";

// A Claude seat can be given its own subscription credential: an operator label and a token file. The managed launch
// reads the file when Claude starts, so the value never passes through OpenRig (its records, the launch command, argv or
// logs), and Claude doesn't start on another login when the file can't be read.

const exec = promisify(execFile);
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
const SYNTHETIC = "synthetic-fixture-value-not-a-credential";

function fixture(ref?: { label: string; tokenFile: string }, daemonEnv: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-seat-token-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), home = path.join(root, "home"), cwd = path.join(root, "work");
  for (const dir of [bin, home, cwd]) mkdirSync(dir);
  const claude = path.join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
printf '{"TOKEN":"%s"}' "\${CLAUDE_CODE_OAUTH_TOKEN-absent}"
`);
  chmodSync(claude, 0o700);
  const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
  db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT);
    CREATE TABLE nodes(id TEXT, rig_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT, claude_token_ref TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO rigs VALUES ('rig', NULL)").run();
  db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'claude-code', ?, NULL, ?)").run(cwd, ref ? JSON.stringify(ref) : null);
  db.exec("INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1)");
  const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...daemonEnv }, {}, async () => undefined);
  const events: unknown[] = [];
  managed.onTokenNotApplied = (event) => { events.push(event); };
  const prepare = () => managed.prepare({ nodeId: "node", session: "seat@rig", pane: "%1" }, "auto");
  const command = async () => (await prepare()).command(["--permission-mode", "auto"]);
  // `pane` is what the pane shell itself exports.
  const run = (cmd: string, pane: Record<string, string> = {}) => exec("/bin/sh", ["-c", cmd], { env: { PATH: "/usr/bin:/bin", ...pane }, timeout: 5000 });
  return { root, command, prepare, run, events };
}

describe.skipIf(process.platform === "win32")("a Claude seat's own subscription token file", () => {
  it("reaches only that seat's Claude process; the value never enters the launch command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-seat-token-file-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = path.join(root, "claude-work.token");
    writeFileSync(tokenFile, `${SYNTHETIC}\n`, { mode: 0o600 });
    const f = fixture({ label: "work", tokenFile });
    const command = await f.command();
    expect(command).not.toContain(SYNTHETIC);
    expect(command).toContain(tokenFile);
    expect(JSON.parse((await f.run(command)).stdout)).toEqual({ TOKEN: SYNTHETIC });
    expect(f.events).toEqual([]);
  });

  it("starts Claude on its stored login when the token file can't be read, and the pane says so", async () => {
    const tokenFile = path.join(tmpdir(), "no-such-dir-claude-seat-token", "claude-work.token");
    const f = fixture({ label: "work", tokenFile });
    const { stdout, stderr } = await f.run(await f.command());
    expect(JSON.parse(stdout)).toEqual({ TOKEN: "absent" });
    expect(stderr).toContain("subscription token (work) wasn't applied");
    // The launch result says so too, checked without reading the file.
    expect((await f.prepare()).warnings).toEqual([expect.stringContaining("subscription token (work) wasn't applied")]);
    // And each launch records it: the seat ran without its own token, and why.
    expect(f.events).toEqual(Array(2).fill({ type: "seat.claude_token_not_applied", rigId: "rig", nodeId: "node", label: "work", tokenFile,
      reason: `the token file ${tokenFile} doesn't exist` }));
  });

  it.each([["bash", true], ["zsh", true], ["fish", false]] as const)(
    "a launch without an explicit permission mode runs the token step before Claude in a %s pane: %s",
    async (shell, included) => {
      const root = mkdtempSync(path.join(tmpdir(), "claude-seat-token-classic-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const cli = path.join(root, "rig");
      writeFileSync(cli, "#!/bin/sh\n", { mode: 0o700 });
      const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig" };
      const tmux = { getPaneCommand: async () => shell, getSessionEnv: async (_session: string, key: string) => identity[key] } as unknown as TmuxAdapter;
      const launch = new SeatLaunchEnvironment(tmux, { PATH: "/usr/bin:/bin", HOME: root, OPENRIG_HOME: path.join(root, "instance") }, root, cli);
      const step = "{ __openrig_token_step_fixture; }";
      const command = await launch.command("seat@rig", "claude --resume abc", { runtime: "claude-code", nodeId: "node", claudeTokenStep: step });
      expect(command.includes(step)).toBe(included);
      if (included) expect(command.indexOf(step)).toBeLessThan(command.indexOf("claude --resume abc"));
    });

  it("wins over a CLAUDE_CODE_OAUTH_TOKEN the pane shell already exports, and over one the daemon forwards", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-seat-token-file-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = path.join(root, "claude-work.token");
    writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const pane = fixture({ label: "work", tokenFile });
    expect(JSON.parse((await pane.run(await pane.command(), { CLAUDE_CODE_OAUTH_TOKEN: "older-fixture-value" })).stdout)).toEqual({ TOKEN: SYNTHETIC });
    const forwarded = fixture({ label: "work", tokenFile }, { CLAUDE_CODE_OAUTH_TOKEN: "older-fixture-value" });
    expect(JSON.parse((await forwarded.run(await forwarded.command(), { CLAUDE_CODE_OAUTH_TOKEN: "older-fixture-value" })).stdout)).toEqual({ TOKEN: SYNTHETIC });
  });

  it("when the file can't be read, a token only the pane shell exports is still removed, and one the daemon forwards is kept", async () => {
    const tokenFile = path.join(tmpdir(), "no-such-dir-claude-seat-token", "claude-work.token");
    const pane = fixture({ label: "work", tokenFile });
    expect(JSON.parse((await pane.run(await pane.command(), { CLAUDE_CODE_OAUTH_TOKEN: "older-fixture-value" })).stdout)).toEqual({ TOKEN: "absent" });
    const forwarded = fixture({ label: "work", tokenFile }, { CLAUDE_CODE_OAUTH_TOKEN: "older-fixture-value" });
    expect(JSON.parse((await forwarded.run(await forwarded.command(), { CLAUDE_CODE_OAUTH_TOKEN: "older-fixture-value" })).stdout)).toEqual({ TOKEN: "older-fixture-value" });
  });

  it("with its token, Claude's process doesn't get the names Claude Code ranks above it, even ones the pane shell exports", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-seat-token-file-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = path.join(root, "claude-work.token");
    writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const report = `printf '%s|%s|%s|%s' "\${CLAUDE_CODE_OAUTH_TOKEN-absent}" "\${ANTHROPIC_API_KEY-absent}" "\${ANTHROPIC_AUTH_TOKEN-absent}" "\${CLAUDE_CODE_USE_BEDROCK-absent}"`;
    const pane = { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_AUTH_TOKEN: "fixture-auth", CLAUDE_CODE_USE_BEDROCK: "1" };
    const withToken = await exec("/bin/sh", ["-c", `${claudeSeatTokenStep({ label: "work", tokenFile }, shellQuote)} && ${report}`], { env: pane, timeout: 5000 });
    expect(withToken.stdout).toBe(`${SYNTHETIC}|absent|absent|absent`);
    // Without it, nothing is unset: the launch is as it would have been.
    const missing = path.join(root, "missing.token");
    const without = await exec("/bin/sh", ["-c", `${claudeSeatTokenStep({ label: "work", tokenFile: missing }, shellQuote)} && ${report}`], { env: pane, timeout: 5000 });
    expect(without.stdout).toBe("absent|fixture-key|fixture-auth|1");
  });

  it("a seat without one launches exactly as before", async () => {
    const f = fixture();
    const command = await f.command();
    expect(command).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.parse((await f.run(command)).stdout)).toEqual({ TOKEN: "absent" });
  });

  it("is kept on the seat as a reference only, and can be cleared", () => {
    const db = createFullTestDb(); cleanup.push(() => db.close());
    const repo = new RigRepository(db);
    const rig = repo.createRig("token-rig");
    const node = repo.addNode(rig.id, "owner", { runtime: "claude-code" });
    const read = () => repo.getRig(rig.id)?.nodes.find((n) => n.id === node.id)?.claudeTokenRef ?? null;
    expect(repo.setNodeClaudeTokenRef(node.id, { label: "work", tokenFile: "/secrets/claude-work.token" })).toBe(true);
    expect(read()).toEqual({ label: "work", tokenFile: "/secrets/claude-work.token" });
    expect(repo.setNodeClaudeTokenRef(node.id, null)).toBe(true);
    expect(read()).toBeNull();
  });
});
