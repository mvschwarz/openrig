import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { findRunProcesses, RUN_MARKER } from "../src/acp/run-processes.js";

describe.skipIf(process.platform !== "win32")("native Windows ACP run markers", () => {
  it("finds detached descendants after parent exit, excluding unrelated markers and private environment values", async () => {
    const run = randomUUID();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore", env: { ...process.env, [RUN_MARKER]: randomUUID() }, windowsHide: true,
    });
    const launcher = spawn(process.execPath, ["-e", `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();`], {
      stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, [RUN_MARKER]: run, OPENRIG_TEST_PRIVATE_SENTINEL: "must-not-leave-native-helper" }, windowsHide: true,
    });
    let descendant: number | undefined;
    try {
      const exited = once(launcher, "exit");
      const [output] = await once(launcher.stdout!, "data");
      descendant = Number(String(output).trim());
      await exited;
      expect(descendant).toBeGreaterThan(0);
      const rows = await findRunProcesses(run);
      expect(rows).toContainEqual({ pid: descendant });
      expect(rows).not.toContainEqual({ pid: unrelated.pid });
      expect(rows).not.toContainEqual({ pid: launcher.pid });
      expect(rows.every(row => Object.keys(row).join() === "pid")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("must-not-leave-native-helper");
      expect(await findRunProcesses(randomUUID())).toEqual([]);
    } finally {
      launcher.kill(); unrelated.kill();
      if (descendant) { try { process.kill(descendant); } catch { /* already gone */ } }
    }
  }, 40_000);
});
