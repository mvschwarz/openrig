import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { windowsCmdBridgeInvocation, windowsManagedRunnerParent } from "../src/domain/windows-cmd-bridge.js";
import { defaultTmuxFileOps } from "../src/adapters/tmux.js";
import { renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { verifyWindowsManagedRunner } from "../src/domain/windows-managed-runner.js";
import { readProcessTable } from "../src/domain/process-table.js";
import { killWindowsChildTree } from "../src/domain/windows-child-tree.js";
import { resolveIdentityVerifiedPiRecord } from "../src/domain/model-divergence/current-generation-record.js";

it.runIf(process.platform === "win32").each(["pi", "omp", "stub"] as const)("runs an owned cmd bridge and verifies only its exact managed runner (%s)", async runtime => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-bridge-"));
  const entry = path.join(root, "offline.cjs"), ops = defaultTmuxFileOps(), script = ops.tmpName();
  fs.writeFileSync(entry, "console.log('OWNED_READY');setInterval(()=>{},1000)");
  const state = path.join(root, "state"), launch = "owned-cmd-launch";
  const words = [process.execPath, entry, "--session-name", "owned-cmd", ...(runtime === "stub" ? [] : ["--state-root", state]), "--cwd", root, "--launch-id", launch, ...(runtime === "omp" ? ["--runtime", "omp"] : [])];
  await ops.writeFile(script, `Remove-Item -LiteralPath '${script.replaceAll("'", "''")}'\n${renderWindowsLaunch(words.map(shellQuote).join(" "))}\n`);
  const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/q"], {
    env: { PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root },
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  try {
    const invocation = windowsCmdBridgeInvocation(script);
    expect(Buffer.byteLength(invocation, "utf8")).toBeLessThanOrEqual(512);
    child.stdin.write(invocation + "\r\n");
    await expect.poll(() => output.includes("OWNED_READY"), { timeout: 8000 }).toBe(true);
    let all = await readProcessTable();
    await expect.poll(async () => {
      all = await readProcessTable();
      const bridge = all.find(row => row.ppid === child.pid && /powershell\.exe$/i.test(row.executablePath ?? ""));
      return !!bridge && all.some(row => row.ppid === bridge.pid && row.command.includes(launch));
    }, { timeout: 6000 }).toBe(true);
    const pane = all.find(row => row.pid === child.pid)!;
    const bridge = all.find(row => row.ppid === child.pid && /powershell\.exe$/i.test(row.executablePath ?? ""))!;
    const runner = all.find(row => row.ppid === bridge.pid && row.command.includes(launch))!;
    const rows = [pane, bridge, runner];
    const input = { runtime, sessionName: "owned-cmd", entryPath: entry, cwd: root, stateRoot: state, launchId: launch,
      getPanePid: async () => child.pid!, listProcesses: async () => all };
    expect(await verifyWindowsManagedRunner(input), JSON.stringify(all.filter(row => row.ppid === child.pid).map(row => ({ pid: row.pid, exe: row.executablePath })))).toBe(true);
    const sessions = path.join(root, "sessions"), sessionFile = path.join(sessions, "owned.jsonl");
    fs.mkdirSync(sessions); fs.writeFileSync(sessionFile, "synthetic-owned-session\n");
    if (runtime === "pi") expect(await resolveIdentityVerifiedPiRecord({ sessionName: input.sessionName, generation: "owned-generation", occupantBootAt: "2026-10-01T00:00:00Z",
      binding: { tmuxSession: input.sessionName, tmuxPane: "%owned" }, runner: { entryPath: entry, stateRoot: state, sessionsDir: sessions,
        state: { ready: true, launchId: launch, sessionFile } } }, { getPanePid: input.getPanePid, listProcesses: input.listProcesses }, file => fs.realpathSync(file)))
      .toMatchObject({ ok: true, pid: runner.pid, launchId: launch, path: fs.realpathSync(sessionFile) });
    expect(windowsManagedRunnerParent(all, child.pid!)).toBe(bridge.pid);
    expect(await verifyWindowsManagedRunner({ ...input, launchId: "wrong-launch" })).toBe(false);
    expect(await verifyWindowsManagedRunner({ ...input, listProcesses: async () => [pane, { ...bridge, command: `${bridge.executablePath} -NoProfile -Command arbitrary` }, runner] })).toBe(false);
    expect(await verifyWindowsManagedRunner({ ...input, listProcesses: async () => [...rows, { ...runner, pid: runner.pid + 1000000, ppid: child.pid! }] })).toBe(false);
    expect(await verifyWindowsManagedRunner({ ...input, listProcesses: async () => [...rows, { ...runner, pid: runner.pid + 1000000, ppid: child.pid!, executablePath: "C:\\not-system\\conhost.exe" }] })).toBe(false);
    expect(fs.existsSync(script)).toBe(false);
  } finally {
    await killWindowsChildTree(child); await closed;
    if (fs.existsSync(script)) fs.unlinkSync(script);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
