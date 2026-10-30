import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopGroup } from "../src/domain/codex-network-default.js";

describe.skipIf(process.platform !== "win32")("Windows owned probe tree cleanup", () => {
  it("ends a live reader and its owned descendant after stdin grace", async () => {
    const source = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let descendant: number | undefined;
    try {
      const [data] = await once(child.stdout!, "data");
      descendant = Number(String(data).trim());
      expect(descendant).toBeGreaterThan(0);
      await stopGroup(child, 100);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(() => process.kill(descendant!, 0)).toThrow();
      // Calling again must not target the old PID after Node has reaped it.
      await stopGroup(child, 10);
    } finally {
      child.kill();
      if (descendant) { try { process.kill(descendant); } catch { /* already gone */ } }
    }
  }, 15_000);
});
