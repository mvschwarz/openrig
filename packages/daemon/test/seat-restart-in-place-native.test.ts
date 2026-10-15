// OPR.0.7.0.5 — native harness for the in-place restart: a REAL tmux server on a private -L socket, a
// compiled stub `codex` (no real Codex, no account, no credentials), the REAL CodexRuntimeAdapter, and the
// production route factory with its default process and /proc readers. Both pane shapes.
//
// Isolation (as seat-handover-cutover-e2e): a per-run -L socket on every tmux command, $TMUX removed,
// teardown by SESSION NAME, never kill-server; stub processes are killed by pid at the end. Skips without
// tmux, a C compiler, or Linux /proc.
//
// The real Codex must be unreachable (an earlier version of this harness let a login shell's profile put
// the installed Codex first on PATH). So: every pane process starts NON-login from `env -i` with an
// explicit PATH/HOME/CODEX_HOME; CODEX_HOME is the test's temp dir and asserted not to be ~/.codex;
// every launch goes through the adapter's pinned launch PATH; and a check INSIDE the pane fails closed
// (prints PREFLIGHT-REFUSED, starts nothing) unless `codex` resolves to the stub there.
//
// Pane roots are given to tmux as separate argv words, so tmux execs them directly: no outer shell sits
// between tmux and the pane's root process on images whose shell doesn't exec a lone `-c` command.
import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const pexec = promisify(execFile);
const SOCK = `openrig-restart-${process.pid}`;
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
delete cleanEnv.TMUX;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  const { stdout } = await pexec("sh", ["-c", safe], { env: cleanEnv });
  return stdout;
};
const tmux = (args: string) => exec(`tmux ${args}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN = "019a0000-0000-7000-8000-00000000c0de";

function available(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v tmux && command -v cc"], { env: cleanEnv, stdio: "ignore" });
    return fs.existsSync("/proc/self/environ");
  } catch { return false; }
}

const STUB_C = `
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
static void bye(int s) { (void)s; _exit(0); }
int main(int argc, char **argv) {
  signal(SIGTERM, bye);
  if (!getenv("STUB_QUIET")) for (int i = 1; i <= 40; i++) printf("history line %d from pid %d\\n", i, (int)getpid());
  printf("OpenAI Codex (v0.0.0-stub)\\nstub conversation %s pid %d\\n\\n\\xe2\\x80\\xba \\n", argc > 1 ? argv[argc - 1] : "?", (int)getpid());
  fflush(stdout);
  for (;;) pause();
}
`;

const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-restart-native-"));
const sessions: string[] = [];
const pids = new Set<number>();
afterAll(async () => {
  for (const name of sessions) await tmux(`kill-session -t ${q(name)}`).catch(() => {});
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  // The server exits with its last session; remove its socket file only once nothing answers on it.
  const socket = nodePath.join(`/tmp/tmux-${process.getuid?.() ?? ""}`, SOCK);
  if (!(await tmux("ls").then(() => true, () => false))) fs.rmSync(socket, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

async function panePid(pane: string): Promise<number> {
  return Number((await tmux(`display-message -p -t ${q(pane)} '#{pane_pid}'`)).trim());
}
/** Running stub processes, by their executable path (never by matching command text). */
function stubPids(): number[] {
  const stub = nodePath.join(root, "bin", "codex");
  return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((entry) => {
    try { return fs.readlinkSync(`/proc/${entry}/exe`) === stub ? [Number(entry)] : []; } catch { return []; }
  });
}

describe.runIf(available())("in-place restart, native (private tmux socket, stub codex)", () => {
  const bin = nodePath.join(root, "bin");
  const home = nodePath.join(root, "codex-home");
  const work = nodePath.join(root, "work");
  const launchPath = `${bin}:/usr/bin:/bin`;

  /** Each word single-quoted for the harness's sh, so tmux receives them as separate argv words. */
  const argv = (...words: string[]) => words.map(q).join(" ");

  async function setup(shape: "shell_backed" | "direct_native", opts: { running?: { networkOverride: boolean; daemonOptOut: boolean; addDirs: string[] }; quiet?: boolean; prelude?: string;
    /** Shell-backed: type the launch the way OpenRig does (tmux adapter's staged `/bin/sh <script>`). */
    staged?: boolean } = {}) {
    // One seat at a time: end the previous test's session and wait for its stub to exit.
    for (const name of sessions) await tmux(`kill-session -t ${q(name)}`).catch(() => {});
    for (let i = 0; i < 50 && stubPids().length > 0; i++) await sleep(100);
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    if (!fs.existsSync(nodePath.join(bin, "codex"))) {
      fs.writeFileSync(nodePath.join(root, "codex.c"), STUB_C);
      execFileSync("cc", ["-o", nodePath.join(bin, "codex"), nodePath.join(root, "codex.c")], { env: cleanEnv });
    }
    const stub = nodePath.join(bin, "codex");
    const resolved = execFileSync("/bin/sh", ["-c", "command -v codex"], { env: { PATH: launchPath }, encoding: "utf8" }).trim();
    if (resolved !== stub) throw new Error(`Refusing to run: codex on the pinned PATH is ${resolved}, not the stub.`);
    expect(home).not.toBe(nodePath.join(os.homedir(), ".codex"));
    const seat = `dev-codex@${shape === "shell_backed" ? "shell" : "native"}-rig`;
    sessions.push(seat);
    const db = createFullTestDb();
    const realTmux = new TmuxAdapter(exec);
    const adapter = new CodexRuntimeAdapter({
      tmux: realTmux, launchPath,
      fsOps: { readFile: (p) => fs.readFileSync(p, "utf8"), writeFile: () => {}, exists: (p) => fs.existsSync(p), mkdirp: () => {}, homedir: root },
    });
    const setupApp = createTestApp(db, { tmux: realTmux, adapters: { codex: adapter },
      appDeps: { seatActivityService: { getSeatState: () => ({ seatNodeId: "", activity: "working", needsInput: { count: 0, reason: null },
        needsInputEvidence: null, decidedBy: null, seq: 1, changedAt: "", rungs: [], lastSwap: null }) } as never } });
    const rig = setupApp.rigRepo.createRig(seat.split("@")[1]!);
    const node = setupApp.rigRepo.addNode(rig.id, "dev.codex", { runtime: "codex", cwd: work });
    const session = setupApp.sessionRegistry.registerSession(node.id, seat);
    setupApp.sessionRegistry.updateStatus(session.id, "running");
    setupApp.sessionRegistry.updateResumeToken(session.id, "codex_id", TOKEN, "scrape");

    // The running Codex starts with exactly the flags the seat's managed relaunch composes.
    const override = new NativePermissionStore(db).launchOverride(node.id, "codex");
    const built = await adapter.buildResumeCommand({
      id: "", nodeId: node.id, attachmentType: "tmux", tmuxSession: seat, tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: work, launchPosture: "floor",
      kernelAuthority: override.kernelAuthority, teamPermissionDefault: override.teamPermissionDefault,
      nonInterruptive: setupApp.rigRepo.getRigNonInterruptive(rig.id),
    }, { name: seat, resumeToken: TOKEN, ...(opts.running ? { running: opts.running } : {}) });
    if (!built.ok) throw new Error(built.error);
    // Session env for respawns; the pane processes themselves start from env -i, non-login.
    const env = `-e ${q(`PATH=${launchPath}`)} -e ${q(`CODEX_HOME=${home}`)} -e ${q(`HOME=${root}`)}`;
    const cleanStart = ["env", "-i", `PATH=${launchPath}`, `HOME=${root}`, `CODEX_HOME=${home}`, "TERM=screen", ...(opts.quiet ? ["STUB_QUIET=1"] : []), "/bin/sh"];
    const preflight = `[ "$(command -v codex)" = ${q(stub)} ] && [ "$CODEX_HOME" = ${q(home)} ]`;
    if (shape === "shell_backed") {
      await tmux(`-f /dev/null new-session -d -s ${q(seat)} -x 120 -y 30 -c ${q(work)} ${env} ${argv(...cleanStart)}`);
      await sleep(200);
      const launch = `${opts.prelude ?? ""}${preflight} && ${built.command} || echo PREFLIGHT-REFUSED`;
      if (opts.staged) {
        const sent = await realTmux.sendShellCommand(seat, launch);
        if (!sent.ok) throw new Error(sent.message);
      } else {
        await tmux(`send-keys -t ${q(seat)} -l -- ${q(launch)}`);
        await tmux(`send-keys -t ${q(seat)} Enter`);
      }
    } else {
      const script = `${preflight} || { echo PREFLIGHT-REFUSED; exec sleep 30; }; exec ${built.command}`;
      await tmux(`-f /dev/null new-session -d -s ${q(seat)} -x 120 -y 30 -c ${q(work)} ${env} ${argv(...cleanStart, "-c", script)}`);
    }
    await sleep(500);
    const refused = (await tmux(`capture-pane -p -t ${q(seat)} -S -200`)).split("\n").some((line) => line.trim() === "PREFLIGHT-REFUSED");
    expect(refused, "the in-pane preflight found the stub and the temp CODEX_HOME").toBe(false);
    const pane = (await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim();
    setupApp.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: seat, tmuxPane: pane });
    for (const pid of stubPids()) pids.add(pid);
    expect(stubPids(), "exactly one stub codex, started by the pane").toHaveLength(1);
    const post = async (route: string, body: Record<string, unknown> = {}) => {
      const res = await setupApp.app.request(`/api/seat/${route}/${encodeURIComponent(seat)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    return { seat, pane, post };
  }

  it("shell-backed: the same conversation resumes in the same pane under the same shell, with the running choices", async () => {
    const dirs = [nodePath.join(root, "shared-one"), nodePath.join(root, "shared-two")];
    const { seat, pane, post } = await setup("shell_backed", { running: { networkOverride: true, daemonOptOut: true, addDirs: dirs } });
    const shellBefore = await panePid(pane);
    const [oldStub] = stubPids();

    const plan = await post("restart-plan");
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({ planOnly: true, paneShape: "shell_backed", conversationProof: "argv",
      activity: { state: "working" }, codexHome: home, childProcesses: [], oldProcess: { pid: oldStub } });

    const result = await post("restart", { reason: "native harness", operator: "test@rig" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ outcome: "restarted_account_unverified", pane, oldProcess: { pid: oldStub },
      newProcess: { sameExecutable: true } });
    for (const pid of stubPids()) pids.add(pid);
    expect(stubPids(), "only the replacement stub runs").toEqual([result.body.newProcess.pid]);
    expect(result.body.newProcess.pid).not.toBe(oldStub);
    expect(await panePid(pane), "same pane shell").toBe(shellBefore);
    const screen = await tmux(`capture-pane -p -t ${q(pane)} -S -300`);
    expect(screen, "the original's output stays in the pane").toContain(`from pid ${oldStub}`);
    expect(screen).toContain(`stub conversation ${TOKEN} pid ${result.body.newProcess.pid}`);
    expect((await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim()).toBe(pane);
    // #1196 r2 F1: the replacement runs with the old process's --no-daemon, network override and add-dirs.
    const newArgv = fs.readFileSync(`/proc/${result.body.newProcess.pid}/cmdline`, "utf8").split("\0");
    expect(newArgv).toContain("--no-daemon");
    expect(newArgv).toContain("sandbox_workspace_write.network_access=true");
    expect(newArgv.filter((_, index) => newArgv[index - 1] === "--add-dir")).toEqual(dirs);

    const verified = await post("restart-verify", {});
    expect(verified.body).toMatchObject({ ok: true, outcome: "restarted_account_unverified", accountEvidence: { state: "not_requested" } });
  }, 60_000);

  it("a Codex launched the way OpenRig launches it (staged sh script), restarted twice in the same pane", async () => {
    const { pane, post } = await setup("shell_backed", { staged: true });
    const shell = await panePid(pane);
    const [oldStub] = stubPids();
    const parentOf = (pid: number) => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
    const script = parentOf(oldStub!);
    expect(script, "a staged script sits between the shell and Codex").not.toBe(shell);
    expect(parentOf(script)).toBe(shell);
    expect(fs.readFileSync(`/proc/${script}/cmdline`, "utf8")).toMatch(/openrig-tmux-send-\d+-[0-9a-f-]+\.txt/);

    for (const round of [1, 2]) {
      const plan = await post("restart-plan");
      expect(plan.body, `round ${round}: ${JSON.stringify(plan.body)}`).toMatchObject({ ok: true, paneShape: "shell_backed" });
      const result = await post("restart", { reason: `native harness staged round ${round}` });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ outcome: "restarted_account_unverified", pane, paneShape: "shell_backed" });
      for (const pid of stubPids()) pids.add(pid);
      expect(stubPids(), `round ${round}: only the replacement stub runs`).toEqual([result.body.newProcess.pid]);
      expect(await panePid(pane), "same pane shell").toBe(shell);
    }
  }, 90_000);

  it("direct-native: respawned without -k, remain-on-exit put back after the verified replacement", async () => {
    const { seat, pane, post } = await setup("direct_native");
    const before = await panePid(pane);
    expect(stubPids(), "the pane's own process is the stub").toEqual([before]);
    const result = await post("restart", { reason: "native harness" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ outcome: "restarted_account_unverified", paneShape: "direct_native", pane });
    expect(result.body.paneHeld).toBeUndefined();
    for (const pid of stubPids()) pids.add(pid);
    const after = await panePid(pane);
    expect(after).not.toBe(before);
    // The replacement is the respawned pane's root, or its child where the image's sh doesn't exec a lone
    // command (review-r2's dash): compare with the reported process, and tie it to the pane separately.
    const replacement = result.body.newProcess.pid as number;
    expect(stubPids(), "only the replacement stub runs").toEqual([replacement]);
    const parent = Number(fs.readFileSync(`/proc/${replacement}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
    expect([replacement, parent], "the replacement is the respawned pane's root or its direct child").toContain(after);
    // tmux resets the visible screen on respawn; the original's earlier output is kept in scrollback.
    const screen = await tmux(`capture-pane -p -t ${q(pane)} -S -300`);
    expect(screen, "the original's scrollback stays in the pane").toContain(`from pid ${before}`);
    expect(screen).toContain(`stub conversation ${TOKEN} pid ${replacement}`);
    expect((await tmux(`show-options -p -v -t ${q(pane)} remain-on-exit`)).trim(), "no pane-local setting left behind").toBe("");
    expect((await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim()).toBe(pane);
  }, 60_000);

  it("#1196 r2 F3: an Account line already below the cursor, untouched by the restart, is not account evidence", async () => {
    // review-r2's case: the line sits on row 25, the cursor is moved to the top, and the restart's output
    // stays above it, so the frame keeps the line in place across the restart.
    const prelude = `printf '\\033[2J\\033[25;1H%s: %s\\033[1;1H' Account me@example.com; `;
    const { pane, post } = await setup("shell_backed", { quiet: true, prelude });
    const before = (await tmux(`capture-pane -p -t ${q(pane)}`)).split("\n");
    expect(before[24], "the old Account line is on row 25 before the restart").toBe("Account: me@example.com");
    const result = await post("restart", { reason: "native harness F3" });
    expect(result.body, JSON.stringify(result.body)).toMatchObject({ outcome: "restarted_account_unverified" });
    for (const pid of stubPids()) pids.add(pid);
    const after = (await tmux(`capture-pane -p -t ${q(pane)}`)).split("\n");
    expect(after[24], "the same line is still on row 25 after the restart").toBe("Account: me@example.com");
    const cursor = Number((await tmux(`display-message -p -t ${q(pane)} '#{cursor_y}'`)).trim());
    expect(cursor, "the cursor is above the old line").toBeLessThan(24);
    const verified = await post("restart-verify", { expectAccount: "me@example.com" });
    expect(verified.body).toMatchObject({ ok: true, outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  }, 60_000);
});
