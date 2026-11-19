import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readWindowsProcessFacts } from "../../src/domain/windows-process-facts.js";

const exec = promisify(execFile);

/** Real psmux harness, separate from the inert tmux fixture bridge. Never PATH-first. */
export function nativePsmuxScaffold(executable: string) {
  if (process.platform !== "win32" || !path.isAbsolute(executable) || !fs.lstatSync(executable).isFile()) throw Error("Explicit native psmux executable required");
  // Retained evidence must outlive the generic worker TMPDIR exit cleanup.
  const parent = path.resolve(import.meta.dirname, "../../../../node_modules/.cache/openrig-native-scaffolds");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "run-")));
  const registry = path.join(root, "registry"); fs.mkdirSync(registry);
  const namespace = "scaffold-" + randomUUID();
  const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const env: Readonly<NodeJS.ProcessEnv> = Object.freeze({ SystemRoot: process.env.SystemRoot ?? "C:\\Windows", WINDIR: process.env.SystemRoot ?? "C:\\Windows",
    PATH: path.dirname(shell) + path.delimiter + path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
    PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL", SHELL: shell });
  let touched = false, closed = false, configured = false;
  const query = async (args: string[]) => (await exec(executable, ["-L", namespace, ...args], { cwd: root, env, encoding: "utf8", timeout: 10000, windowsHide: true })).stdout;
  return { root, registry, namespace, shell, env,
    async run(args: string[]) {
      if (closed || !args.length || args[0]!.startsWith("-") || args.some(arg => /^-[LSf]/.test(arg) || /^--(?:socket|namespace)/.test(arg))) {
        throw Error("Scaffold requires a command without global endpoint overrides");
      }
      touched = true;
      if (!configured && args[0] === "new-session") {
        await query(["start-server", ";", "set-option", "-g", "exit-empty", "off"]);
        await query(["set-option", "-g", "default-shell", `"${shell}" -NoProfile -NoLogo`]);
        configured = true;
      }
      return query(args);
    },
    async cleanup() {
      if (closed) return;
      if (touched) {
        const pid = Number((await query(["display-message", "-p", "#{pid}"])).trim());
        if (!Number.isSafeInteger(pid) || pid <= 1) throw Error("Owned psmux PID unavailable; scaffold retained");
        const facts = await readWindowsProcessFacts(pid);
        if (!facts || fs.realpathSync.native(facts.exe).toLowerCase() !== fs.realpathSync.native(executable).toLowerCase()
          || facts.env.HOME !== root || facts.env.USERPROFILE !== root) throw Error("Owned psmux identity unavailable; scaffold retained");
        const panes = (await query(["list-panes", "-a", "-F", "#{pane_pid}"])).trim().split(/\s+/).filter(Boolean).map(Number);
        if (!panes.every(value => Number.isSafeInteger(value) && value > 1)) throw Error("Owned pane PIDs unavailable; scaffold retained");
        await query(["kill-server"]);
        const deadline = Date.now() + 5000;
        const alive = () => [pid, ...panes].some(value => { try { process.kill(value, 0); return true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        } });
        while (alive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
        if (alive()) throw Error("Owned psmux processes have not exited; scaffold retained");
      }
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      closed = true;
    },
  };
}
