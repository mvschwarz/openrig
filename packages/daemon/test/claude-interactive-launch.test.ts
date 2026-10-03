import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";

const run = promisify(execFile);
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional dependency */ }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Fixture did not return to its shell prompt");
}

// The real adapters and tmux deliver to an interactive Bash with an rc-defined
// command. Claude is an offline recorder, never a provider executable. These
// controls prove command resolution/arguments, not native readiness or history.
describe.skipIf(!hasTmux || process.platform === "win32")("classic Claude interactive launch", () => {
  it("checks assignment, subshell/export and sourced-file alias/function effects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shell-forms-"));
    const rc = path.join(root, "bashrc"), script = path.join(root, "launch");
    const effects: Record<string, string> = {};
    try {
      for (const shape of ["alias", "function"]) {
        fs.writeFileSync(rc, shape === "alias" ? "alias claude='printenv PROBE'\n" : "claude() { printenv PROBE; }\n");
        fs.writeFileSync(script, "PROBE='from launch' claude\n");
        for (const [form, command] of Object.entries({
          assignments: "PROBE='from launch' claude",
          exportSubshell: "( export PROBE='from launch'; claude )",
          sourcedSubshell: `( . ${quote(script)} )`,
        })) {
          const result = await run("/bin/bash", ["--noprofile", "--rcfile", rc, "-ic", command], {
            env: { HOME: root, PATH: "/usr/bin:/bin" }, cwd: root, timeout: 5000,
          });
          effects[`${shape}/${form}`] = result.stdout.trim();
        }
      }
      console.log("CLAUDE_SHELL_FORMS", JSON.stringify(effects));
      expect(Object.values(effects)).toEqual(Array(6).fill("from launch"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("starts all 36 executable/alias/function, corrected/fallback/legacy, fresh/fork/resume/restore cells", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-interactive-"));
    const socket = path.join(root, "tmux");
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color" };
    const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 5000 })).stdout;
    const fake = path.join(root, "off-path-claude"), recorder = path.join(root, "record.cjs"), cli = path.join(root, "paired-rig");
    fs.writeFileSync(recorder, `const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(process.env.MARKER, JSON.stringify({argv:process.argv.slice(2), node:process.env.OPENRIG_NODE_ID,
 home:process.env.OPENRIG_HOME, userHome:process.env.HOME, config:process.env.CLAUDE_CONFIG_DIR,
 token:process.env.OPENRIG_ACTIVITY_HOOK_TOKEN, path:process.env.PATH,
 rig:cp.spawnSync('rig', [], {encoding:'utf8'}).stdout?.trim()}));\n`);
    fs.writeFileSync(fake, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(cli, "#!/bin/sh\nprintf 'paired-rig'\n", { mode: 0o755 });
    const cells: Array<{ shape: string; route: string; kind: string; started: boolean; exit: number; issues: string[] }> = [];
    try {
      for (const shape of ["executable", "alias", "function"]) for (const route of ["corrected", "fallback", "legacy"]) {
        for (const kind of ["fresh", "fork", "launch-resume", "restore-resume"]) {
          const name = `${shape}-${route}-${kind}`, dir = path.join(root, name), bin = path.join(dir, "bin");
          fs.mkdirSync(bin, { recursive: true });
          if (shape === "executable") fs.symlinkSync(fake, path.join(bin, "claude"));
          const marker = path.join(dir, "started.json"), status = path.join(dir, "status"), rc = path.join(dir, "bashrc");
          fs.writeFileSync(rc, `export PATH=${quote(bin + ":/usr/bin:/bin")} MARKER=${quote(marker)} HOME=${quote(dir)}\n`
            + `export OPENRIG_NODE_ID='rc-node' OPENRIG_HOME='rc-home' CLAUDE_CONFIG_DIR='rc-config' OPENRIG_ACTIVITY_HOOK_TOKEN='fixture-token'\nPS1='FIXTURE> '\n`
            + (shape === "alias" ? `alias claude=${quote(fake)}\n` : shape === "function" ? `claude() { ${quote(fake)} "$@"; }\n` : "")
            + `PROMPT_COMMAND='printf "%s\\n" "$?" > ${status}'\n`);
          await tm(["new-session", "-d", "-s", name, "/bin/bash --noprofile --rcfile " + quote(rc) + " -i"]);
          await until(() => fs.existsSync(status)); fs.unlinkSync(status);
          await tm(["set-environment", "-t", name, "OPENRIG_SESSION_NAME", name]);
          if (route === "corrected") await tm(["set-environment", "-t", name, "OPENRIG_NODE_ID", name]);
          const transport = new TmuxAdapter(async command => {
            if (!command.startsWith("tmux ")) throw new Error("Unexpected fixture command");
            return (await run("/bin/sh", ["-c", command.replace(/^tmux /, `tmux -S ${quote(socket)} -f /dev/null `)], { env, timeout: 5000 })).stdout;
          });
          const helper = route === "legacy" ? undefined : new SeatLaunchEnvironment(transport, {
            OPENRIG_HOME: path.join(dir, "rig-home"), HOME: "must-not-override", CLAUDE_CONFIG_DIR: "must-not-override",
            OPENRIG_ACTIVITY_HOOK_TOKEN: "must-not-type",
          }, root, cli);
          const model = route === "corrected" ? "fixture-" + "x".repeat(4096) : "fixture";
          const token = "11111111-1111-4111-8111-111111111111";
          if (kind === "restore-resume") {
            const adapter = new ClaudeResumeAdapter(transport, { seatLaunchEnvironment: helper });
            // Only the subsequent native observation is stubbed: the recorder
            // cannot establish Claude identity or continuity.
            (adapter as any).verifyResume = async () => ({ ok: false, code: "not_assessed", message: "offline recorder" });
            await adapter.resume(name, "claude_id", token, dir, "floor", model, undefined, name);
          } else {
            const adapter = new ClaudeCodeAdapter({ tmux: transport, seatLaunchEnvironment: helper,
              fsOps: { readFile: () => { throw Error("no native files"); }, writeFile: () => {}, exists: () => false,
                mkdirp: () => {}, copyFile: () => {}, readdir: () => [], homedir: dir },
              sessionIdFactory: () => "22222222-2222-4222-8222-222222222222" });
            (adapter as any).verifyResumeLaunch = async () => ({ ok: false, error: "native identity not assessed" });
            (adapter as any).pollForResumeToken = async () => null;
            await adapter.launchHarness({ nodeId: name, id: name, tmuxSession: name, cwd: dir, model,
              launchGeneration: "1", launchPosture: "floor" } as never, { name,
              ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: token } }
                : kind === "launch-resume" ? { resumeToken: token } : {}) });
          }
          await until(() => fs.existsSync(status));
          const started = fs.existsSync(marker), issues: string[] = [];
          if (started) {
            const got = JSON.parse(fs.readFileSync(marker, "utf8"));
            if (got.argv[got.argv.indexOf("--model") + 1] !== model) issues.push("model argument truncated");
            if (got.userHome !== dir || got.config !== "rc-config" || got.token !== "fixture-token") issues.push("user/provider environment changed");
            if (route === "corrected") {
              if (got.node !== name || got.home !== path.join(dir, "rig-home")) issues.push("metadata not corrected");
              if (got.rig !== "paired-rig") issues.push("paired rig not selected");
              if (!got.path.endsWith(bin + ":/usr/bin:/bin")) issues.push("user PATH replaced");
            } else if (got.node !== "rc-node" || got.home !== "rc-home") issues.push("fallback/legacy environment changed");
          }
          cells.push({ shape, route, kind, started, exit: Number(fs.readFileSync(status, "utf8").trim()), issues });
          await tm(["kill-session", "-t", name]);
        }
      }
      console.log("CLAUDE_INTERACTIVE_CELLS", JSON.stringify(cells));
      expect(cells).toHaveLength(36);
      expect(cells.filter(cell => !cell.started || cell.exit !== 0 || cell.issues.length)).toEqual([]);
    } finally {
      await tm(["kill-server"]).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
