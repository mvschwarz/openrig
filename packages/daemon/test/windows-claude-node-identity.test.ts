import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { listNativeProcesses, verifyClaudePaneProcess } from "../src/domain/native-process-lineage.js";
import { killWindowsChildTree } from "../src/domain/windows-child-tree.js";

it.runIf(process.platform === "win32").each(["frozen", "declared-npm"])("proves an owned %s Claude Node entry without treating another script as the provider", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-node-identity-"));
  const pkg = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(pkg, { recursive: true });
  const manifest = path.join(pkg, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }));
  const script = mode === "frozen" ? path.join(root, "owned cli.cjs") : path.join(pkg, "cli.js");
  fs.writeFileSync(script, 'console.log("OWNED_READY");setInterval(()=>{},1000);');
  const child = spawn(process.execPath, [script, "--session-id", "owned-conversation"], { cwd: root,
    env: { SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, TEMP: root, TMP: root }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  try {
    await expect.poll(() => output.includes("OWNED_READY"), { timeout: 5000 }).toBe(true);
    let rows = await listNativeProcesses();
    await expect.poll(async () => { rows = await listNativeProcesses(); return rows.some(row => row.pid === child.pid); }, { timeout: 6000 }).toBe(true);
    const input = { target: "owned", tmux: { getPanePid: async () => process.pid, getPaneCommand: async () => "node" },
      listProcesses: async () => rows, ...(mode === "frozen" ? { selectedExecutable: process.execPath, selectedScript: script } : {}), expectedToken: "owned-conversation" };
    const found = await verifyClaudePaneProcess(input);
    expect(found?.process.pid).toBe(child.pid);
    expect(await verifyClaudePaneProcess({ ...input, selectedExecutable: process.execPath, selectedScript: path.join(root, "other.cjs") })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, expectedToken: "other-conversation" })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, selectedExecutable: path.join(root, "node.exe") })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, listProcesses: async () => [...rows, { ...found!.process, pid: found!.process.pid + 1000000 }] })).toBeNull();
    if (mode === "declared-npm") {
      fs.writeFileSync(manifest, JSON.stringify({ name: "unrelated", bin: { claude: "cli.js" } }));
      expect(await verifyClaudePaneProcess(input)).toBeNull();
    }
  } finally { await killWindowsChildTree(child); await closed; fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);
