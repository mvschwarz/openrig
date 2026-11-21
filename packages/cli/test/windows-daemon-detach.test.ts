import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWindowsBreakawayCommand } from "../src/windows-daemon-detach.js";

it.runIf(process.platform === "win32")("preserves native CLI arguments, cwd and caller temp through breakaway startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon O'Brien 中文 "));
  const script = path.join(root, "owned child.cjs");
  await writeFile(script, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),temp:process.env.TEMP,payload:process.env.OPENRIG_DAEMON_DETACH_PAYLOAD}));");
  try {
    const args = ["quoted \"value\"", "中文 space", "trailing\\"];
    const result = await runWindowsBreakawayCommand(process.execPath, [script, ...args], root);
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: root, temp: process.env.TEMP });
    expect(result.stderr).toBe("");
  } finally { await rm(root, { recursive: true }); }
}, 15000);

it.runIf(process.platform === "win32")("propagates the startup CLI failure without launching a fallback", async () => {
  await expect(runWindowsBreakawayCommand(process.execPath, ["-e", "process.stderr.write('owned-startup-failure');process.exit(7)"]))
    .rejects.toMatchObject({ code: 7, stderr: expect.stringContaining("owned-startup-failure") });
}, 15000);
