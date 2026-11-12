import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { processStart } from "../src/commands/acp.js";

describe.skipIf(process.platform !== "win32")("ACP native Windows process identity", () => {
  it("retains creation identity while alive and rejects the exited process", async () => {
    const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    await once(child.stdout!, "data");
    try {
      const start = processStart(child.pid!);
      expect(start).toMatch(/^\d+$/);
      expect(processStart(child.pid!)).toBe(start);
      expect(processStart(process.pid)).not.toBe(start);
    } finally { const exited = once(child, "exit"); child.kill(); await exited; }
    expect(processStart(child.pid!)).toBeUndefined();
  }, 30_000);
  it("rejects non-PID input before querying the OS", () => {
    for (const pid of [0, -1, NaN, 1.5]) expect(processStart(pid)).toBeUndefined();
  });
});
