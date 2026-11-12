import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("captures distinct stock psmux servers without assigning sibling output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-psmux-batch-"));
  const registry = path.join(root, "registry"); fs.mkdirSync(registry);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: "NUL" };
  const execute = promisify(execFile);
  const invoke = async (args: string[]) => (await execute(process.env.OPENRIG_TEST_PSMUX!, args, { cwd: root, env, windowsHide: true, timeout: 10000, encoding: "utf8" })).stdout;
  const names = ["owned-batch-a", "owned-batch-b"];
  const receiver = path.join(root, "receiver.cjs");
  fs.writeFileSync(receiver, "console.log(process.argv[2]);setInterval(()=>{},1000);");
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell transport"); }, undefined, argv => invoke(argv.slice(1)), [], "psmux");
  try {
    for (const name of names) {
      await invoke(["new-session", "-d", "-s", name, "--", process.execPath, receiver, "marker-" + name]);
      await expect.poll(() => adapter.capturePaneContent(name), { timeout: 5000 }).toContain("marker-" + name);
    }
    const captured = await adapter.capturePanesContent(names);
    for (const name of names) {
      expect(captured?.get(name)?.text).toBe(await adapter.capturePaneContent(name));
      expect(captured?.get(name)?.text).toContain("marker-" + name);
      expect(captured?.get(name)?.text).not.toContain("marker-" + names.find(other => other !== name));
    }
    const withMissing = await adapter.capturePanesContent([names[0]!, "owned-batch-absent", names[1]!]);
    expect(withMissing?.get("owned-batch-absent")).toMatchObject({ text: null, missing: true });
    for (const name of names) expect(withMissing?.get(name)?.text).toBe(await adapter.capturePaneContent(name));
  } finally {
    for (const name of names) await invoke(["kill-session", "-t", "=" + name]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 40000);
