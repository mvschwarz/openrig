import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

// #3901: a handover's cutover holds the retiree's signals to the terminal (tmux session and server) its pane was resolved
// in. On a real tmux server, with the real adapter, delivery guard and process table: a later terminal read that comes
// back unreadable isn't a change (the pane-level stop goes on), and a positive replacement still stops it.
describe.skipIf(process.platform === "win32")("a handover's cutover and its retiree's terminal, on a real tmux server (#3901)", () => {
  const NAME = "dev-impl@pinned";
  const exec = promisify(execFile);
  /** The adapter's terminal identity read (killSession's, and the pin's). */
  const isTerminalRead = (argv: string[]) => argv.includes("display-message") && argv.some((arg) => arg.startsWith("#{session_id}|"));

  async function harness(hooks: { before?: (argv: string[]) => void; after?: (argv: string[], tmux: (...a: string[]) => Promise<string>) => Promise<void> } = {}) {
    // Short socket path for macOS sockaddr_un, no inherited server, no config.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMUX_TMPDIR: home, SHELL: "/bin/sh" };
    const server = ["-L", "pin", "-f", "/dev/null"];
    const tmux = async (...args: string[]) => (await exec("tmux", [...server, ...args], { env, timeout: 5000 })).stdout.trim();
    const signalled: string[] = [];
    const adapter = new TmuxAdapter(async (command) => {
      signalled.push(command);
      return (await exec("/bin/sh", ["-c", command], { timeout: 5000 })).stdout;
    }, undefined, async (argv) => {
      hooks.before?.(argv);
      const out = (await exec(argv[0]!, argv.slice(1), { env, timeout: 5000 })).stdout;
      await hooks.after?.(argv, tmux);
      return out;
    }, server);
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
    const guard = new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target));
    guard.recoverActivation();
    adapter.deliveryGuard = guard;
    const rig = rigRepo.createRig("pinned");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: home });

    // A foreground executable named claude, under the pane's shell (this Node, renamed: it ends on TERM and HUP).
    const agent = path.join(home, "claude");
    fs.copyFileSync(fs.realpathSync(process.execPath), agent);
    fs.chmodSync(agent, 0o755);
    const runAgent = (ms: number, setup = "") => `${shellQuote(agent)} -e ${shellQuote(`${setup}setTimeout(() => {}, ${ms})`)}`;
    await tmux("new-session", "-d", "-s", NAME, "-e", `OPENRIG_NODE_ID=${node.id}`, `${runAgent(300_000)}; :`);
    const pane = (await tmux("list-panes", "-t", `=${NAME}:`, "-F", "#{pane_id}")).split("\n")[0]!;
    const session = sessionRegistry.registerSession(node.id, NAME);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: NAME, tmuxPane: pane });

    // The successor's own launch isn't what's under test: the respawn and the harness launch are recorded, not run.
    const respawned: string[] = [];
    vi.spyOn(adapter, "respawnPane").mockImplementation(async (target: string) => { respawned.push(target); return { ok: true }; });
    vi.spyOn(adapter, "getDefaultShell").mockResolvedValue("/bin/sh");
    vi.spyOn(adapter, "getPaneCommand").mockResolvedValue("sh");
    vi.spyOn(adapter, "seatProcessLimitsRecoveryPlan").mockResolvedValue(null);
    const runtime = { runtime: "claude-code", launchHarness: vi.fn(async () => ({ ok: true })), checkReady: vi.fn(async () => ({ ready: true })) } as unknown as RuntimeAdapter;
    const launcher = new SuccessorSessionLauncher(adapter, new DiscoveryRepository(db), {
      newId: () => "01PINNED", runtimeAdapters: { "claude-code": runtime }, readinessTimeoutMs: 50,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), exitPollMs: 50, exitTimeoutMs: 1_000,
    });
    const handover = () => guard.lifecycle([node.id], () =>
      launcher.createSuccessor({ node: { id: node.id, runtime: "claude-code", cwd: home }, departingSessionName: NAME }));
    const close = async () => { await tmux("kill-server").catch(() => {}); db.close(); fs.rmSync(home, { recursive: true, force: true }); };
    return { home, tmux, pane, runAgent, signalled, respawned, handover, close };
  }

  it("a terminal read that is unreadable after a good one isn't a change: the pane-level stop goes on, reported forced, and the handover continues", async () => {
    let reads = 0;
    // The first read (as the pane is resolved) succeeds; every later one fails, while the pane, its pid and the guard's
    // binding all still resolve.
    const h = await harness({ before: (argv) => { if (isTerminalRead(argv) && ++reads > 1) throw new Error("tmux: lost server connection"); } });
    try {
      const panePid = await h.tmux("display-message", "-p", "-t", h.pane, "#{pane_pid}");
      const result = await h.handover();
      expect(reads).toBeGreaterThan(1);
      expect(result).toMatchObject({ ok: true, retireeExit: "forced",
        retireeExitDetail: "Claude Code wasn't signalled: its terminal (tmux session and server) couldn't be read just before it. The pane's process exited on TERM." });
      // The agent's own TERM isn't sent on an unreadable terminal; the pane's root gets TERM, as before #3901.
      expect(h.signalled).toEqual([`kill -TERM ${panePid}`]);
      expect(h.respawned).toEqual([expect.any(String)]);
      expect(await h.tmux("display-message", "-p", "-t", h.pane, "#{pane_dead}")).toBe("1");
    } finally { await h.close(); }
  });

  it("a server replaced after the pane is resolved still stops the cutover: nothing is signalled and the new terminal's agent runs on", async () => {
    let replaced = false;
    let runAgent: (ms: number) => string = () => "";
    const h = await harness({ after: async (argv, tmux) => {
      // Just after the first terminal read (as the pane is resolved), the server is replaced; another terminal takes the
      // name and the old ids, and runs an agent the exit would recognise.
      if (replaced || !isTerminalRead(argv)) return;
      replaced = true;
      await tmux("kill-server");
      await tmux("new-session", "-d", "-s", NAME, `exec ${runAgent(301_000)}`);
    } });
    runAgent = h.runAgent;
    try {
      const result = await h.handover();
      expect(replaced).toBe(true);
      expect(result).toMatchObject({ ok: false, code: "guard_target_changed", step: "create_successor", replacementStarted: false,
        message: expect.stringMatching(/no longer in the tmux session and server it was first read in/) });
      expect(h.signalled).toEqual([]);
      expect(h.respawned).toEqual([]);
      expect(await h.tmux("list-panes", "-t", `=${NAME}:`, "-F", "#{pane_dead} #{pane_current_command}")).toBe("0 claude");
    } finally { await h.close(); }
  });
  it("late unreadable identity still permits the guarded pane stop to escalate from TERM to KILL", async () => {
    let reads = 0;
    const h = await harness({ before: (argv) => { if (isTerminalRead(argv) && ++reads > 1) throw new Error("tmux: lost server connection"); } });
    try {
      const ready = path.join(h.home, "term-handler-ready");
      const setup = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`;
      await h.tmux("respawn-pane", "-k", "-t", h.pane, `exec ${h.runAgent(300_000, setup)}`);
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(ready)).toBe(true);
      const panePid = await h.tmux("display-message", "-p", "-t", h.pane, "#{pane_pid}");
      const result = await h.handover();
      expect(reads).toBeGreaterThan(1);
      expect(result).toMatchObject({ ok: true, retireeExit: "forced",
        retireeExitDetail: expect.stringMatching(/terminal.*couldn't be read.*was killed/) });
      expect(h.signalled).toEqual([`kill -TERM ${panePid}`, `kill -KILL ${panePid}`]);
      expect(h.respawned).toEqual([expect.any(String)]);
      expect(await h.tmux("display-message", "-p", "-t", h.pane, "#{pane_dead}")).toBe("1");
    } finally { await h.close(); }
  }, 15_000);

  it("moving the pane out of its named session preserves the unresolved-target stop without signalling it", async () => {
    let moved = false;
    let movedPane = "";
    const other = "another-owner@pinned";
    const h = await harness({ after: async (argv, tmux) => {
      if (moved || !isTerminalRead(argv)) return;
      moved = true;
      await tmux("new-session", "-d", "-s", other, "exec /bin/sh");
      await tmux("join-pane", "-s", movedPane, "-t", `=${other}:`);
    } });
    movedPane = h.pane;
    try {
      const result = await h.handover();
      expect(moved).toBe(true);
      // Moving the last pane removes the original named session. Its scoped PID lookup no longer resolves;
      // it must report that actual failure, never broaden the target to the pane's new session.
      expect(result).toMatchObject({ ok: false, code: "retiree_not_terminated", replacementStarted: false,
        message: expect.stringContaining("can't find session: dev-impl@pinned") });
      expect(h.signalled).toEqual([]);
      expect(h.respawned).toEqual([]);
      expect(await h.tmux("display-message", "-p", "-t", h.pane, "#{session_name}")).toBe(other);
      expect(await h.tmux("display-message", "-p", "-t", h.pane, "#{pane_dead}")).toBe("0");
    } finally { await h.close(); }
  });

});
