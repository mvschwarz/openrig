import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function fixture(ref?: { label: string; tokenFile: string; kind?: "api-key" }, daemonEnv: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-seat-token-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), home = path.join(root, "home"), cwd = path.join(root, "work");
  for (const dir of [bin, home, cwd]) mkdirSync(dir);
  const claude = path.join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
if [ -n "\${ANTHROPIC_API_KEY-}" ]; then printf '{"API":"%s","TOKEN":"%s"}' "$ANTHROPIC_API_KEY" "\${CLAUDE_CODE_OAUTH_TOKEN-absent}"; else printf '{"TOKEN":"%s"}' "\${CLAUDE_CODE_OAUTH_TOKEN-absent}"; fi
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
  const command = async (accountHome?: string, accountToken?: { label: string; tokenFile: string }) => (await managed.prepare({ nodeId: "node", session: "seat@rig", pane: "%1", ...(accountHome ? { accountHome, accountToken: accountToken ?? null } : {}) }, "auto")).command(["--permission-mode", "auto"]);
  // `pane` is what the pane shell itself exports.
  const run = (cmd: string, pane: Record<string, string> = {}) => exec("/bin/sh", ["-c", cmd], { env: { PATH: "/usr/bin:/bin", ...pane }, timeout: 5000 });
  return { root, command, prepare, run, events, db, managed };
}

describe.skipIf(process.platform === "win32")("a Claude seat's own subscription token file", () => {
  it.each(["missing-key", "relative-cwd", "conflicting-settings"])("classic launch and resume return structured credential failure: %s", async problem => {
    const f = fixture();
    const tokenFile = path.join(f.root, "key");
    if (problem !== "missing-key") writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    f.db.prepare("UPDATE nodes SET claude_token_ref = ?").run(JSON.stringify({ label: "api", tokenFile, kind: "api-key" }));
    if (problem === "relative-cwd") f.db.exec("UPDATE nodes SET cwd = 'relative'");
    if (problem === "conflicting-settings") {
      mkdirSync(path.join(f.root, "work", ".claude"));
      writeFileSync(path.join(f.root, "work", ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic-conflict" } }));
    }
    const sendText = vi.fn(), sendKeys = vi.fn(), sendShellCommand = vi.fn();
    const tmux = { sendText, sendKeys, sendShellCommand } as unknown as TmuxAdapter;
    const adapter = new ClaudeCodeAdapter({ tmux, claudeManagedLaunch: f.managed });
    await expect(adapter.launchHarness({ nodeId: "node", tmuxSession: "seat@rig", cwd: path.join(f.root, "work") } as never,
      { name: "seat" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Selected API-key|Claude credential settings/) });
    const resume = new ClaudeResumeAdapter(tmux, { claudeManagedLaunch: f.managed });
    await expect(resume.resume("seat@rig", "claude_id", "original", path.join(f.root, "work"), undefined, undefined, undefined, "node"))
      .resolves.toMatchObject({ ok: false, code: "api_key_unavailable" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("a staged API successor rechecks its own reference and home rather than the predecessor's missing key", async () => {
    const f = fixture({ label: "old-api", tokenFile: "/synthetic/missing-old-api", kind: "api-key" });
    const selected = path.join(f.root, "next-account"); mkdirSync(selected);
    const tokenFile = path.join(f.root, "new-key"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    f.db.exec("ALTER TABLE nodes ADD COLUMN account_home TEXT");
    f.db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'node'").run(path.join(f.root, "old-account"));
    const prepared = await f.managed.prepare({ nodeId: "node", session: "staging", pane: "%2", generation: "next-gen", accountHome: selected,
      accountToken: { label: "new-api", tokenFile, kind: "api-key" },
      runtimeSwitch: { fromRuntime: "claude-code", session: "seat@rig", pane: "%1", generation: "gen" } }, "auto");
    expect(prepared.configDir).toBe(selected);
    expect(JSON.parse((await f.run(prepared.command([]))).stdout)).toEqual({ API: SYNTHETIC, TOKEN: "absent" });
    writeFileSync(path.join(selected, "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic-conflict" } }));
    expect(() => prepared.command([])).toThrow(/credential settings could override/);
  });

  it("an API-key reference works inside a persisted account home without losing its allowed helper", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "integrated-account-api-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const selected = path.join(root, "selected"); mkdirSync(selected);
    writeFileSync(path.join(selected, "settings.json"), JSON.stringify({ apiKeyHelper: "synthetic-unused-helper" }));
    const tokenFile = path.join(root, "api-key"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const f = fixture({ label: "api", tokenFile, kind: "api-key" });
    f.db.exec("ALTER TABLE nodes ADD COLUMN account_home TEXT");
    f.db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'node'").run(selected);
    expect((await f.prepare()).configDir).toBe(selected);
    expect(JSON.parse((await f.run(await f.command())).stdout)).toEqual({ API: SYNTHETIC, TOKEN: "absent" });
  });

  it("an explicit account home ignores the old seat token and inherited provider credentials", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "isolated-claude-home-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = path.join(root, "old-token");
    writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const f = fixture({ label: "old-account", tokenFile }, {
      CLAUDE_CODE_OAUTH_TOKEN: "old-fixture", ANTHROPIC_API_KEY: "old-api-fixture", CODEX_ACCESS_TOKEN: "old-access-fixture",
      OPENAI_FEDERATION_RULE_ID: "old-rule-fixture", OPENAI_IDENTITY_TOKEN_FILE: "/old-identity-file-fixture",
      OPENAI_PROJECT_ID: "old-project-fixture", AWS_BEARER_TOKEN_BEDROCK: "old-bedrock-fixture", ANTHROPIC_PROFILE: "synthetic-profile", ANTHROPIC_FEDERATION_RULE_ID: "synthetic-rule", ANTHROPIC_ORGANIZATION_ID: "synthetic-org",
    });
    const selected = path.join(root, "selected-account"); mkdirSync(selected);
    writeFileSync(path.join(f.root, "bin", "claude"), `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' "$CLAUDE_CONFIG_DIR" "\${CLAUDE_CODE_OAUTH_TOKEN+set}" "\${ANTHROPIC_API_KEY+set}" "\${CODEX_ACCESS_TOKEN+set}" "\${OPENAI_FEDERATION_RULE_ID+set}" "\${OPENAI_IDENTITY_TOKEN_FILE+set}" "\${OPENAI_PROJECT_ID+set}" "\${AWS_BEARER_TOKEN_BEDROCK+set}" "\${ANTHROPIC_PROFILE+set}" "\${ANTHROPIC_FEDERATION_RULE_ID+set}" "\${ANTHROPIC_ORGANIZATION_ID+set}"
`);
    const command = await f.command(selected);
    expect(command).not.toContain(tokenFile);
    expect(command).not.toContain(SYNTHETIC);
    const result = await f.run(command, {
      CLAUDE_CODE_OAUTH_TOKEN: "pane-old-fixture", ANTHROPIC_API_KEY: "pane-old-api-fixture", CODEX_ACCESS_TOKEN: "pane-old-access-fixture",
      OPENAI_FEDERATION_RULE_ID: "pane-old-rule-fixture", OPENAI_IDENTITY_TOKEN_FILE: "/pane-old-identity-file-fixture",
      OPENAI_PROJECT_ID: "pane-old-project-fixture", AWS_BEARER_TOKEN_BEDROCK: "pane-old-bedrock-fixture", ANTHROPIC_PROFILE: "pane-profile", ANTHROPIC_FEDERATION_RULE_ID: "pane-rule", ANTHROPIC_ORGANIZATION_ID: "pane-org",
    });
    expect(result.stdout).toBe(`${selected}||||||||||`);
    expect(f.events).toEqual([]);
  });

  it.each([undefined, "/accounts/member", "/accounts/daemon"])("a staged managed clear uses configured home %s and removes only the old account token", async baseline => {
    const f = fixture({ label: "old", tokenFile: "/absent/old-token" }, baseline === "/accounts/daemon" ? { CLAUDE_CONFIG_DIR: baseline } : {});
    f.db.exec("ALTER TABLE nodes ADD COLUMN account_home TEXT");
    f.db.prepare("UPDATE nodes SET account_home = ?, env_json = ? WHERE id = 'node'")
      .run(path.join(f.root, "old-account"), baseline === "/accounts/member" ? JSON.stringify({ CLAUDE_CONFIG_DIR: baseline }) : null);
    writeFileSync(path.join(f.root, "bin", "claude"), `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
printf '%s|%s' "\${CLAUDE_CONFIG_DIR-}" "\${CLAUDE_CODE_OAUTH_TOKEN+set}"
`);
    const managed = await f.managed.prepare({ nodeId: "node", session: "staging", pane: "%2", generation: "next-gen", accountHome: null, accountToken: null,
      runtimeSwitch: { fromRuntime: "claude-code", session: "seat@rig", pane: "%1", generation: "gen" } }, "auto");
    expect(managed.configDir).toBe(baseline ?? path.join(f.root, "home", ".claude"));
    expect(f.managed.configPaths(path.join(f.root, "work"), "node", null).statePath).toBe(baseline ? path.join(baseline, ".claude.json") : path.join(f.root, "home", ".claude.json"));
    const result = await f.run(managed.command([]), { CLAUDE_CONFIG_DIR: "/accounts/old", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old" });
    expect(result.stdout).toBe(`${baseline ?? ""}|`);
  });

  it("an account-home plan uses its explicit setup-token file and fails closed if that file disappears", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "selected-claude-plan-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = path.join(root, "plan-token"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const accountHome = path.join(root, "plan-home"); mkdirSync(accountHome);
    const f = fixture(undefined, { CLAUDE_CODE_OAUTH_TOKEN: "unselected-fixture" });
    const command = await f.command(accountHome, { label: "plan", tokenFile });
    expect(command).not.toContain(SYNTHETIC);
    expect(JSON.parse((await f.run(command)).stdout)).toEqual({ TOKEN: SYNTHETIC });
    rmSync(tokenFile);
    await expect(f.run(command)).rejects.toMatchObject({ code: 1, stdout: "" });
  });

  it("a later managed launch restores the stored account home and its setup-token reference", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stored-claude-plan-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = path.join(root, "plan-token"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const selected = path.join(root, "plan-home"); mkdirSync(selected);
    const f = fixture({ label: "plan", tokenFile }, { CLAUDE_CODE_OAUTH_TOKEN: "wrong-daemon-fixture", ANTHROPIC_API_KEY: "wrong-api-fixture" });
    f.db.exec("ALTER TABLE nodes ADD COLUMN account_home TEXT");
    f.db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'node'").run(selected);
    expect((await f.prepare()).configDir).toBe(selected);
    const command = await f.command();
    expect(command).not.toContain(SYNTHETIC);
    expect(JSON.parse((await f.run(command)).stdout)).toEqual({ TOKEN: SYNTHETIC });
  });

  it("refuses a selected plan home whose API helper would outrank its explicit token, including edits after preparation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "conflicting-claude-plan-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = path.join(root, "plan-token"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const selected = path.join(root, "plan-home"); mkdirSync(selected);
    const f = fixture({ label: "plan", tokenFile });
    f.db.exec("ALTER TABLE nodes ADD COLUMN account_home TEXT");
    f.db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'node'").run(selected);
    const prepared = await f.prepare();
    writeFileSync(path.join(selected, "settings.json"), JSON.stringify({ apiKeyHelper: "printf synthetic-api-helper" }));
    expect(() => prepared.command(["--permission-mode", "auto"])).toThrow(/credential settings could override/);
    await expect(f.command()).rejects.toThrow(/credential settings could override/);
  });

  it("an API home without a selected token keeps its intended user-scope API helper", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "selected-claude-api-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const selected = path.join(root, "api-home"); mkdirSync(selected);
    writeFileSync(path.join(selected, "settings.json"), JSON.stringify({ apiKeyHelper: "printf synthetic-api-helper" }));
    const f = fixture(undefined, { CLAUDE_CODE_OAUTH_TOKEN: "wrong-daemon-fixture" });
    const command = await f.command(selected);
    expect(JSON.parse((await f.run(command)).stdout)).toEqual({ TOKEN: "absent" });
    expect((await f.managed.prepare({ nodeId: "node", session: "seat@rig", pane: "%1", accountHome: selected, accountToken: null }, "auto")).configDir).toBe(selected);
  });

  it("an API key reaches only the child, overrides inherited auth, and fails closed if its file disappears", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-api-key-")), "api-key");
    cleanup.push(() => rmSync(path.dirname(file), { recursive: true, force: true }));
    writeFileSync(file, SYNTHETIC, { mode: 0o600 });
    const command = claudeSeatTokenStep({ label: "api", tokenFile: file, kind: "api-key" }, shellQuote)
      + ` && "${process.execPath}" -e 'process.stdout.write(JSON.stringify({api:process.env.ANTHROPIC_API_KEY,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN,profile:process.env.ANTHROPIC_PROFILE}))'`;
    expect(command).not.toContain(SYNTHETIC);
    const pane = { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old-token", ANTHROPIC_PROFILE: "synthetic-profile", ANTHROPIC_AUTH_TOKEN: "synthetic-old-auth" };
    const { stdout } = await exec("/bin/sh", ["-c", command], { env: pane });
    expect(JSON.parse(stdout)).toEqual({ api: SYNTHETIC });
    const traced = await exec("/bin/sh", ["-c", "set -x; " + command], { env: pane });
    expect(traced.stderr).not.toContain(SYNTHETIC);
    expect(pane.CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-old-token");
    rmSync(file);
    await expect(exec("/bin/sh", ["-c", command], { env: pane })).rejects.toMatchObject({ code: 1, stdout: "" });
  });

  it.each(["", "two lines\nnot-a-key", "null\0byte", "x".repeat(8193)])("an invalid API-key file cannot start a child", async value => {
    const dir = mkdtempSync(path.join(tmpdir(), "invalid-api-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const tokenFile = path.join(dir, "key"); writeFileSync(tokenFile, value, { mode: 0o600 });
    const command = claudeSeatTokenStep({ label: "api", tokenFile, kind: "api-key" }, shellQuote) + "; printf started";
    await expect(exec("/bin/sh", ["-c", command], { env: {} })).rejects.toMatchObject({ code: 1, stdout: "" });
  });

  it("a credential setting added after preparation refuses API dispatch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "changed-api-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const tokenFile = path.join(dir, "key"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const f = fixture({ label: "api", tokenFile, kind: "api-key" });
    const prepared = await f.prepare();
    mkdirSync(path.join(f.root, "work", ".claude"));
    writeFileSync(path.join(f.root, "work", ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic-conflict" } }));
    expect(() => prepared.command([])).toThrow("credential settings could override");
  });

  it("the classic launch reads the API-key file only in its staged child", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "classic-api-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cli = path.join(dir, "rig"); writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const tokenFile = path.join(dir, "key"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig" };
    const tmux = { getPaneCommand: async () => "sh", getSessionEnv: async (_session: string, key: string) => identity[key] } as unknown as TmuxAdapter;
    const launch = new SeatLaunchEnvironment(tmux, { OPENRIG_HOME: path.join(dir, "instance") }, dir, cli);
    const step = claudeSeatTokenStep({ label: "api", tokenFile, kind: "api-key" }, shellQuote);
    const child = `claude() { "${process.execPath}" -e 'process.stdout.write(JSON.stringify({api:process.env.ANTHROPIC_API_KEY,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN}))'; }; `;
    const command = child + await launch.command("seat@rig", "claude --resume synthetic-session", { nodeId: "node", runtime: "claude-code", claudeTokenStep: step });
    expect(command).not.toContain(SYNTHETIC);
    const env = { PATH: "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old" };
    expect(JSON.parse((await exec("/bin/sh", ["-c", command], { env })).stdout)).toEqual({ api: SYNTHETIC });
    rmSync(tokenFile);
    await expect(exec("/bin/sh", ["-c", command], { env })).rejects.toMatchObject({ code: 1, stdout: "" });
  });

  it("managed launch retains the selected API key through environment reduction and persistence", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "managed-api-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const tokenFile = path.join(dir, "key"); writeFileSync(tokenFile, SYNTHETIC, { mode: 0o600 });
    const f = fixture({ label: "api", tokenFile, kind: "api-key" }, { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old" });
    expect(JSON.parse((await f.run(await f.command())).stdout)).toEqual({ API: SYNTHETIC, TOKEN: "absent" });
    rmSync(tokenFile);
    await expect(f.command()).rejects.toThrow("Selected API-key file unavailable");
  });

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
    expect(repo.setNodeClaudeTokenRef(node.id, { label: "api", tokenFile: "/secrets/api-key", kind: "api-key" })).toBe(true);
    expect(read()).toEqual({ label: "api", tokenFile: "/secrets/api-key", kind: "api-key" });
    expect(repo.setNodeClaudeTokenRef(node.id, null)).toBe(true);
    expect(read()).toBeNull();
  });
});
