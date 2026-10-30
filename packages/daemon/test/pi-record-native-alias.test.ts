import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { windowsArguments } from "../src/adapters/windows-argv.js";
import { resolveIdentityVerifiedPiRecord, type ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";

it.runIf(process.platform === "win32").each(["entry", "state"])("joins the current Pi record through an existing native %s alias", async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-record-alias-"));
  const alias = path.join(root, "alias");
  try {
    const physical = path.join(root, "physical");
    const sessions = path.join(physical, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const entry = path.join(physical, "runner.js");
    fs.writeFileSync(entry, "// owned fixture, never executed");
    fs.writeFileSync(path.join(physical, "other.js"), "// distinct file");
    fs.mkdirSync(path.join(physical, "other"));
    const sessionFile = path.join(sessions, "owned.jsonl");
    fs.writeFileSync(sessionFile, "{}\n");
    fs.symlinkSync(physical, alias, "junction");
    const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const node = fs.realpathSync.native(process.execPath);
    const words = [node, entry, "--session-name", "worker@owned", "--state-root", physical,
      "--cwd", physical, "--launch-id", "owned-launch"];
    const rows: ProcessRow[] = [
      { platform: "win32", pid: 10, ppid: 1, executablePath: shell, command: windowsArguments([shell, "-NoProfile"]), startedAt: "2026-10-29T12:00:00Z" },
      { platform: "win32", pid: 11, ppid: 10, executablePath: node, command: windowsArguments(words), startedAt: "2026-10-29T12:00:01Z" },
    ];
    const input = { sessionName: "worker@owned", generation: "owned-generation", occupantBootAt: "2026-10-29T12:00:00Z",
      binding: { tmuxSession: "worker@owned", tmuxPane: "%owned" },
      runner: { state: { ready: true, launchId: "owned-launch", sessionFile }, sessionsDir: sessions,
        entryPath: kind === "entry" ? path.join(alias, "RUNNER.js") : entry,
        stateRoot: kind === "state" ? alias : physical } };
    const deps = { getPanePid: async () => 10, listProcesses: async () => rows };
    const realpath = (file: string) => { try { return fs.realpathSync.native(file); } catch { return null; } };
    expect(await resolveIdentityVerifiedPiRecord(input, deps, realpath)).toMatchObject({ ok: true, pid: 11, path: fs.realpathSync.native(sessionFile) });
    const different = kind === "entry" ? { ...input.runner, entryPath: path.join(physical, "other.js") }
      : { ...input.runner, stateRoot: path.join(physical, "other") };
    expect((await resolveIdentityVerifiedPiRecord({ ...input, runner: different }, deps, realpath)).ok).toBe(false);
    expect((await resolveIdentityVerifiedPiRecord({ ...input, runner: { ...input.runner,
      state: { ...input.runner.state, launchId: "older-launch" } } }, deps, realpath)).ok).toBe(false);
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
