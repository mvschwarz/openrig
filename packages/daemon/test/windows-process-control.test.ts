import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe.skipIf(process.platform !== "win32")("Windows process termination", () => {
  it("terminates only the addressed owned child and leaves its sibling alive", async () => {
    const children = [0, 1].map(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore", windowsHide: true,
    }));
    try {
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve); child.once("error", reject);
      })));
      const target = children[0]!;
      const exited = new Promise<void>(resolve => target.once("exit", () => resolve()));
      const adapter = new TmuxAdapter(async command => (await promisify(exec)(command, { windowsHide: true })).stdout,
        undefined, undefined, "psmux");
      expect(await adapter.signalPid(target.pid!, "KILL")).toEqual({ ok: true });
      await exited;
      expect(children[1]!.exitCode).toBeNull();
      expect(process.kill(children[1]!.pid!, 0)).toBe(true);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }, 15000);
});
