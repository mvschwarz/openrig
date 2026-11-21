import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("deduplicates replayed boundaries through an owned stock psmux capture", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-psmux-owned-"));
  const registry = path.join(root, "registry"), output = path.join(root, "transcript.log");
  fs.mkdirSync(registry);
  const namespace = `owned-${randomUUID()}`, session = "boundary@owned";
  const old = "--- SESSION BOUNDARY: owned old", echoed = "--- SESSION BOUNDARY: owned latest";
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TEMP: root, TMP: root, PATH: path.dirname(process.execPath),
    PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL",
  };
  const run = promisify(execFile);
  const invoke = async (args: string[]) => (await run(process.env.OPENRIG_TEST_PSMUX!, ["-L", namespace, ...args],
    { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10000 })).stdout;
  const receiver = path.join(root, "owned receiver.cjs");
  fs.writeFileSync(receiver, `console.log(${JSON.stringify(echoed)});console.log('stable owned output');setTimeout(()=>process.exit(0),20000);`);
  let captures = 0;
  const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX shell permitted"); }, undefined, async argv => {
    const result = await invoke(argv.slice(1));
    if (argv.includes("capture-pane")) captures++;
    return result;
  });
  Object.assign(adapter, { readAllSessionWindowActivity: undefined });
  try {
    await invoke(["new-session", "-d", "-s", session, "--", process.execPath, receiver]);
    const deadline = Date.now() + 5000;
    let content = "";
    while (!content.includes("stable owned output") && Date.now() < deadline) {
      content = await adapter.capturePaneContent(session, 20) ?? "";
      if (!content.includes("stable owned output")) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(content).toContain(echoed);
    fs.writeFileSync(output, `${old}\n${echoed}\n`);
    captures = 0;
    startTranscriptRotation(adapter, session, output, { lines: 20, pollIntervalMs: 50 });
    await expect.poll(() => captures, { timeout: 5000 }).toBeGreaterThanOrEqual(4);
    stopTranscriptRotation(session);
    // stop invalidates an in-flight capture before it can write.
    const lines = fs.readFileSync(output, "utf8").split("\n");
    expect(lines.filter(line => line === old)).toHaveLength(1);
    expect(lines.filter(line => line === echoed)).toHaveLength(2);
    expect(lines).toContain("stable owned output");
  } finally {
    stopTranscriptRotation(session);
    await invoke(["kill-session", "-t", `=${session}`]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);
