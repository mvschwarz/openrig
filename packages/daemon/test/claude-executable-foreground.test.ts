import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { shellQuote as quote } from "../src/adapters/shell-quote.js";

const run = promisify(execFile);
function available(command: string, args: string[]) {
  try { execFileSync(command, args, { stdio: "ignore" }); return true; } catch { return false; }
}
const hasTmux = available("tmux", ["-V"]);
const cases = [
  ...["fresh", "fork", "launch-resume", "restore-resume"].map(kind => ({ kind, shape: "executable" })),
  { kind: "fresh", shape: "alias" },
  { kind: "fresh", shape: "function" },
];

// The production adapters and staging transport run in real private shell panes.
// A held offline recorder exposes its PID/arguments/environment; it does not
// establish native Claude readiness, history, or provider authentication.
// ksh keeps the earlier launch, which isn't in the foreground. It calls an rc
// function without exporting the seat's new variables, as it did before, so
// that shape isn't run on ksh.
for (const shell of ["bash", "zsh", "dash", "ksh"]) {
  describe.skipIf(process.platform === "win32" || !hasTmux || !available(shell, ["-c", ":"]))(
    "classic Claude foreground in " + shell, () => {
      it.each(cases.filter(({ shape }) => shell !== "ksh" || shape !== "function"))("$kind through $shape preserves launch semantics and the parent pane", async ({ kind, shape }) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fg-"));
        const socket = path.join(root, "tmux"), bin = path.join(root, "bin's path");
        const marker = path.join(root, "started.json"), status = path.join(root, "status");
        const parent = path.join(root, "parent"), lookup = path.join(root, "lookup");
        const fake = path.join(root, "offline claude"), recorder = path.join(root, "record.cjs");
        const cli = path.join(root, "paired-rig"), rc = path.join(root, shell === "zsh" ? ".zshrc" : shell + "rc");
        const env = { HOME: root, ZDOTDIR: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color" };
        const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 })).stdout;
        fs.mkdirSync(bin);
        fs.writeFileSync(recorder, [
          "const fs = require('node:fs');",
          "process.title = 'claude-fixture';",
          "process.on('SIGTERM', () => process.exit(0));",
          "fs.writeFileSync(process.env.MARKER + '.part', JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv.slice(2),",
          "node:process.env.OPENRIG_NODE_ID,home:process.env.OPENRIG_HOME,renderer:process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN,",
          "resume:process.env.OPENRIG_RESUME_LAUNCH,wrapper:process.env.FIXTURE_WRAPPER,config:process.env.CLAUDE_CONFIG_DIR}));",
          "fs.renameSync(process.env.MARKER + '.part', process.env.MARKER);",
          "setInterval(() => {}, 1000);",
        ].join("\n"));
        fs.writeFileSync(fake, "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(recorder) + ' "$@"\n', { mode: 0o755 });
        fs.writeFileSync(cli, "#!/bin/sh\nprintf paired-rig\n", { mode: 0o755 });
        if (shape === "executable") fs.symlinkSync(fake, path.join(bin, "claude"));
        else {
          // A real file named claude must not cause a shell function/alias to be
          // mistaken for a file command, even when command -v returns "claude".
          const shadow = "#!/bin/sh\nexit 93\n";
          fs.writeFileSync(path.join(bin, "claude"), shadow, { mode: 0o755 });
          fs.writeFileSync(path.join(root, "claude"), shadow, { mode: 0o755 });
        }
        // The hook keeps the exit status first and writes its file last, so a complete status file means the parent
        // and lookup files are complete too.
        const prompt = "_fixture_status=$?\n"
          + "printf '%s|%s|%s' \"$$\" \"$OPENRIG_NODE_ID\" \"$CLAUDE_CONFIG_DIR\" > " + quote(parent) + "\n"
          + "command -v claude > " + quote(lookup) + "\n"
          + "printf '%s\\n' \"$_fixture_status\" > " + quote(status);
        const statusWritten = () => fs.existsSync(status) && fs.readFileSync(status, "utf8").endsWith("\n");
        fs.writeFileSync(rc, [
          "export PATH=" + quote(bin + ":" + env.PATH) + " MARKER=" + quote(marker),
          "export OPENRIG_NODE_ID=parent-node OPENRIG_HOME=parent-home CLAUDE_CONFIG_DIR=parent-config",
          "unset OPENRIG_RESUME_LAUNCH",
          "HISTFILE=/dev/null",
          "PS1='FIXTURE> '",
          shape === "alias" ? "alias claude=" + quote(quote(fake) + " --fixture-wrapper alias")
            : shape === "function" ? "claude() { FIXTURE_WRAPPER=function " + quote(fake) + ' "$@"; }' : "",
          shell === "zsh" ? "precmd() {\n" + prompt + "\n}" : shell === "bash" ? "PROMPT_COMMAND=" + quote(prompt)
            // dash and ksh have no prompt hook; the test calls this once the launch ends.
            : "fixture_hook() {\n" + prompt + "\n}\nfixture_hook",
        ].join("\n"));
        const transport = new TmuxAdapter(async command => {
          if (!command.startsWith("tmux ")) throw Error("Unexpected fixture command");
          return (await run("/bin/sh", ["-c", command.replace(/^tmux /, "tmux -S " + quote(socket) + " -f /dev/null ")], { env, timeout: 8000 })).stdout;
        });
        try {
          const shellCommand = shell === "zsh" ? "zsh -d -i" : shell === "bash" ? "bash --noprofile --rcfile " + quote(rc) + " -i"
            : "ENV=" + quote(rc) + " " + shell + " -i";
          await tm(["new-session", "-d", "-s", "seat", "-c", root, shellCommand]);
          await expect.poll(statusWritten, { timeout: 5000 }).toBe(true);
          const before = fs.readFileSync(parent, "utf8"), beforeLookup = fs.readFileSync(lookup, "utf8");
          const parentPid = Number(before.split("|")[0]);
          fs.unlinkSync(status);
          await tm(["set-environment", "-t", "seat", "OPENRIG_NODE_ID", "fixture-node"]);
          await tm(["set-environment", "-t", "seat", "OPENRIG_SESSION_NAME", "seat"]);
          const helper = new SeatLaunchEnvironment(transport, { OPENRIG_HOME: path.join(root, "instance") }, root, cli);
          const token = "11111111-1111-4111-8111-111111111111";
          const model = "fixture 'quoted' " + "x".repeat(4096);
          if (kind === "restore-resume") {
            const adapter = new ClaudeResumeAdapter(transport, { seatLaunchEnvironment: helper });
            (adapter as any).verifyResume = async () => ({ ok: false, code: "not_assessed", message: "offline recorder" });
            await adapter.resume("seat", "claude_id", token, root, "floor", model, undefined, "fixture-node");
          } else {
            const adapter = new ClaudeCodeAdapter({
              tmux: transport, seatLaunchEnvironment: helper,
              fsOps: { readFile: () => { throw Error("no native files"); }, writeFile: () => {}, exists: () => false,
                mkdirp: () => {}, copyFile: () => {}, readdir: () => [], homedir: root },
              sessionIdFactory: () => "22222222-2222-4222-8222-222222222222",
            });
            (adapter as any).verifyResumeLaunch = async () => ({ ok: false, error: "native identity not assessed" });
            await adapter.launchHarness({ nodeId: "fixture-node", id: "binding", tmuxSession: "seat", cwd: root,
              model, launchGeneration: "generation", launchPosture: "floor" } as never, { name: "seat",
              ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: token } }
                : kind === "launch-resume" ? { resumeToken: token } : {}) });
          }
          await expect.poll(() => fs.existsSync(marker), { timeout: 5000 }).toBe(true);
          const got = JSON.parse(fs.readFileSync(marker, "utf8"));
          expect(got).toMatchObject({ node: "fixture-node", home: path.join(root, "instance"), config: "parent-config", renderer: "1" });
          expect(got.argv[got.argv.indexOf("--model") + 1]).toBe(model);
          expect(got.resume).toBe(kind.endsWith("resume") ? token : undefined);
          if (shape === "executable") {
            if (shell !== "ksh") {
              const pgid = Number((await run("ps", ["-o", "pgid=", "-p", String(got.pid)], { env, timeout: 5000 })).stdout.trim());
              const paneCommand = await transport.getPaneCommand("seat");
              expect({ parentPid: got.ppid, processGroup: pgid, paneCommand }).toEqual({
                parentPid, processGroup: got.pid, paneCommand: expect.not.stringMatching(/^(bash|zsh|sh|dash|ksh)$/),
              });
            }
          } else if (shape === "alias") {
            expect(got.argv.slice(0, 2)).toEqual(["--fixture-wrapper", "alias"]);
          } else expect(got.wrapper).toBe("function");
          process.kill(got.pid, "SIGTERM");
          if (shell === "dash" || shell === "ksh") await tm(["send-keys", "-t", "seat", "fixture_hook", "Enter"]);
          await expect.poll(statusWritten, { timeout: 5000 }).toBe(true);
          expect(Number(fs.readFileSync(status, "utf8").trim())).toBe(0);
          expect(fs.readFileSync(parent, "utf8")).toBe(before);
          expect(fs.readFileSync(lookup, "utf8")).toBe(beforeLookup);
        } finally {
          await tm(["kill-server"]).catch(() => {});
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }, 20_000);
    },
  );
}

// Real tmux and a real interactive bash with an rc that sets PATH. `claude` and the wrapper are private fixtures that record
// the argv they were really started with; nothing here starts Claude Code or reads a provider setting.
describe.skipIf(process.platform === "win32" || !hasTmux || !available("bash", ["-c", ":"]))(
  "classic Claude launch_wrapper through a native pane",
  () => {
    /** Create an isolated tmux pane with argv-recording Claude and wrapper fixtures. */
    async function pane(wrapperName: string | null) {
      const temp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR ?? (process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "claude-wrap-")));
      const socket = path.join(temp, "tmux.sock"); const session = "claude-fixture";
      const bin = path.join(temp, "bin"); const userBin = path.join(temp, "user-bin"); const cwd = path.join(temp, "work");
      for (const dir of [bin, userBin, cwd]) fs.mkdirSync(dir);
      const claudeLog = path.join(temp, "claude-argv.log"); const wrapperLog = path.join(temp, "wrapper-argv.log");
      const logArgv = (log: string) => `for a in "$@"; do printf '%s\\n' "$a"; done > ${quote(log + ".part")} && mv ${quote(log + ".part")} ${quote(log)}`;
      // The rc PATH selects user-bin's claude, which a PATH-only lookup by the daemon would not.
      fs.writeFileSync(path.join(userBin, "claude"), `#!/bin/sh\n${logArgv(claudeLog)}\nsleep 30\n`, { mode: 0o755 });
      if (wrapperName) fs.writeFileSync(path.join(bin, wrapperName), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do a="$1"; shift; [ "$a" = "--" ] && break; done\n${logArgv(wrapperLog)}\nexec "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(temp, "rig"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const rc = path.join(temp, "pane.rc");
      const readyMarker = path.join(temp, "rc-ready");
      fs.writeFileSync(rc, `export PATH=${quote(userBin + ":" + bin + ":/usr/bin:/bin")}\n: > ${quote(readyMarker)}\n`);
      const sessionEnv = { PATH: `${bin}:/usr/bin:/bin`, OPENRIG_HOME: path.join(temp, "instance"), OPENRIG_URL: "", OPENRIG_NODE_ID: "fixture-node",
        OPENRIG_SESSION_NAME: session, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "gen-1" };
      const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { timeout: 8000 })).stdout;
      await tm(["new-session", "-d", "-s", session, "-x", "200", "-y", "50",
        ...Object.entries(sessionEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        `/bin/bash --noprofile --rcfile ${quote(rc)} -i`]);
      const tmux = new TmuxAdapter(async command => {
        if (!command.startsWith("tmux ")) throw Error("Unexpected fixture command");
        return (await run("/bin/sh", ["-c", command.replace(/^tmux /, "tmux -S " + quote(socket) + " -f /dev/null ")], { timeout: 8000 })).stdout;
      });
      const capture = async () => (await tmux.capturePaneContent(session, 40)) ?? "";
      await expect.poll(() => fs.existsSync(readyMarker), { timeout: 5000 }).toBe(true);
      const fsOps = { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], homedir: temp };
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fsOps as never, seatLaunchEnvironment: new SeatLaunchEnvironment(tmux, sessionEnv, cwd, path.join(temp, "rig")), sleep: async () => {} });
      vi.spyOn(adapter as never, "verifyResumeLaunch").mockResolvedValue({ ok: true } as never);
      const binding = { launchWrapper: wrapperName ? [wrapperName, "--"] : undefined, id: "b", nodeId: "fixture-node", tmuxSession: session, tmuxPane: "%0", tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd };
      const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").slice(0, -1);
      const cleanup = async () => {
        await tm(["kill-server"]).catch(() => {});
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      };
      return { temp, userBin, adapter, binding, capture, claudeLog, wrapperLog, lines, cleanup, tmux, session, tm };
    }

    it.each(["fresh", "resume", "fork"] as const)("%s launch starts the wrapper with the rc-selected claude executable and its native args as the child", async kind => {
      const p = await pane("native-wrapper");
      try {
        const result = await p.adapter.launchHarness(p.binding as never, { name: p.session, ...(kind === "resume" ? { resumeToken: "old-id" } : kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-id" } } : {}) });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        await expect.poll(() => fs.existsSync(p.claudeLog), { timeout: 5000 }).toBe(true);
        const argv = p.lines(p.claudeLog); const wrapped = p.lines(p.wrapperLog);
        expect(wrapped[0], await p.capture()).toBe(path.join(p.userBin, "claude"));
        expect(wrapped.slice(1)).toEqual(argv); // the wrapper's child is exactly claude and the args claude then received
        expect(argv).toEqual(expect.arrayContaining(kind === "resume" ? ["--resume", "old-id"] : kind === "fork" ? ["--resume", "parent-id", "--fork-session"] : ["--session-id"]));
        for (const intermediary of ["eval", "sh", "bash", "env", "exec"]) expect(wrapped).not.toContain(intermediary);
      } finally { await p.cleanup(); }
    });

    it("a missing wrapper starts nothing: claude never ran and the pane says so", async () => {
      const p = await pane(null);
      try {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await p.adapter.launchHarness({ ...p.binding, launchWrapper: ["absent-wrapper", "--"] } as never, { name: p.session });
        warn.mockRestore();
        // A probe typed after the launch line only runs once the fail-closed line has finished.
        const probe = path.join(p.temp, "probe");
        await p.tm(["send-keys", "-t", p.session, `printf '%s\\n' "$?" > ${quote(probe)}`, "Enter"]);
        await expect.poll(() => fs.existsSync(probe) && fs.readFileSync(probe, "utf8").includes("\n"), { timeout: 5000 }).toBe(true);
        const screen = await p.capture();
        expect(fs.existsSync(p.claudeLog), `claude ran unwrapped; pane:\n${screen}`).toBe(false);
        expect(fs.existsSync(p.wrapperLog), `the wrapper ran; pane:\n${screen}`).toBe(false);
        expect(fs.readFileSync(probe, "utf8").trim(), `exit status; pane:\n${screen}`).not.toBe("0");
        expect(screen).toContain("launch_wrapper unavailable; no agent started.");
      } finally { await p.cleanup(); }
    });
  },
);
